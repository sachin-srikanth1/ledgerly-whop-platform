import type { WhopClient } from "@whop/sdk";
import { decimalStringToCents, formatMoney, toCents, toMajorUnits } from "./money";

export type RecordKind = "payment" | "transfer";

/** One row from Ledgerly's own ledger, to be checked against Whop. */
export interface LocalLedgerRecord {
  /** The Whop id this row records: `pay_...` or `tran_...`. The join key. */
  id: string;
  kind: RecordKind;
  /** Major units. A string is parsed exactly; a number must be whole cents. */
  amount: number | string;
  /** Lowercase ISO 4217. */
  currency: string;
  status: string;
}

export type DiscrepancyType =
  | "missing_in_ledger"
  | "missing_in_whop"
  | "amount_mismatch"
  | "currency_mismatch"
  | "status_mismatch";

export interface Discrepancy {
  type: DiscrepancyType;
  recordId: string;
  kind: RecordKind;
  detail: string;
  whop?: NormalizedRecord;
  local?: NormalizedRecord;
}

/** A Whop record and a local row reduced to the fields worth comparing. */
export interface NormalizedRecord {
  id: string;
  kind: RecordKind;
  amountCents: number;
  currency: string;
  status: string;
}

export interface ReconcileOptions {
  /** The seller's connected account, prefixed `biz_`. */
  sellerAccountId: string;
  localLedger: LocalLedgerRecord[];
  /** Inclusive lower bound on creation time. Applied by Whop and locally. */
  since?: Date;
  /** Exclusive upper bound on creation time. */
  until?: Date;
  /**
   * Map a Whop status onto Ledgerly's vocabulary before comparing. Whop's
   * payment statuses are not Ledgerly's, so without this every row reports a
   * status mismatch. Defaults to comparing lowercased strings unchanged.
   */
  normalizeStatus?: (status: string, kind: RecordKind) => string;
}

export interface ReconciliationReport {
  sellerAccountId: string;
  generatedAt: string;
  window: { since: string | null; until: string | null };
  counts: {
    whopPayments: number;
    whopTransfers: number;
    localPayments: number;
    localTransfers: number;
    discrepancies: number;
  };
  discrepancies: Discrepancy[];
}

/**
 * Diff one seller's payments and transfers on Whop against Ledgerly's ledger.
 *
 * Fetches every record in the window, following pagination to the end rather
 * than just the first page, and reports what the two sides disagree about.
 *
 * ## Errors are not caught
 *
 * If Whop cannot be reached, this throws. It deliberately does not fall back to
 * an empty result set: an empty Whop side makes every local row look like
 * `missing_in_whop`, and an empty ledger against an empty fetch reports a clean
 * reconciliation. Both are worse than an outage you can see. Let it throw and
 * retry the job.
 *
 * ## What it cannot tell you
 *
 * Only records Whop still returns are visible. A payment created and hard
 * deleted between runs is invisible to both sides, and a record that falls
 * outside `since`/`until` on one side but not the other reads as missing.
 * Reconcile over closed windows, not windows ending at `now`.
 *
 * @param client Whop client authenticated with the *platform* API key.
 */
export async function reconcileSeller(
  client: WhopClient,
  options: ReconcileOptions
): Promise<ReconciliationReport> {
  const { sellerAccountId, localLedger, since, until, normalizeStatus } = options;

  if (!sellerAccountId) throw new Error("sellerAccountId is required");

  const normalize = normalizeStatus ?? ((status: string) => status.toLowerCase());

  const [whopPayments, whopTransfers] = await Promise.all([
    fetchPayments(client, sellerAccountId, since, until, normalize),
    fetchTransfers(client, sellerAccountId, since, until, normalize),
  ]);

  const localPayments = localLedger
    .filter((record) => record.kind === "payment")
    .map((record) => normalizeLocal(record, normalize));
  const localTransfers = localLedger
    .filter((record) => record.kind === "transfer")
    .map((record) => normalizeLocal(record, normalize));

  const discrepancies = [
    ...diff(whopPayments, localPayments, "payment"),
    ...diff(whopTransfers, localTransfers, "transfer"),
  ];

  return {
    sellerAccountId,
    generatedAt: new Date().toISOString(),
    window: {
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
    counts: {
      whopPayments: whopPayments.length,
      whopTransfers: whopTransfers.length,
      localPayments: localPayments.length,
      localTransfers: localTransfers.length,
      discrepancies: discrepancies.length,
    },
    discrepancies,
  };
}

/**
 * Every payment on the seller's account in the window.
 *
 * Reconciles on `total`, the account-facing total: price after discounts plus
 * any tax added on top. Not `amount_after_fees`, which nets out Whop's fees and
 * so is not what a ledger records at charge time.
 */
async function fetchPayments(
  client: WhopClient,
  sellerAccountId: string,
  since: Date | undefined,
  until: Date | undefined,
  normalize: (status: string, kind: RecordKind) => string
): Promise<NormalizedRecord[]> {
  const page = await (client.payments.list as any)({
    account_id: sellerAccountId,
    ...(since ? { created_after: since.toISOString() } : {}),
    ...(until ? { created_before: until.toISOString() } : {}),
    first: 50,
  });

  const records: NormalizedRecord[] = [];

  for await (const payment of page) {
    const money = payment.total ?? payment.amount_after_fees;

    if (!money) {
      throw new Error(`Payment ${payment.id} has no total to reconcile against`);
    }

    records.push({
      id: payment.id,
      kind: "payment",
      amountCents: decimalStringToCents(money.amount, money.decimals ?? 2),
      currency: String(payment.currency).toLowerCase(),
      status: normalize(String(payment.status), "payment"),
    });
  }

  return records;
}

/**
 * Every transfer into the seller's account in the window.
 *
 * Filtered by `destination_id`: these are the transfers Ledgerly sends a seller
 * their share with. Transfers *out* of the seller's account are a different
 * question and are not reconciled here.
 *
 * The filter is not optional. `transfers.list` with neither `origin_id` nor
 * `destination_id` is a 400 ("You must specify an origin_id or a
 * destination_id"), unlike `payments.list`, which happily lists everything.
 */
async function fetchTransfers(
  client: WhopClient,
  sellerAccountId: string,
  since: Date | undefined,
  until: Date | undefined,
  normalize: (status: string, kind: RecordKind) => string
): Promise<NormalizedRecord[]> {
  const page = await (client.transfers.list as any)({
    destination_id: sellerAccountId,
    ...(since ? { created_after: since.toISOString() } : {}),
    ...(until ? { created_before: until.toISOString() } : {}),
    first: 50,
  });

  const records: NormalizedRecord[] = [];

  for await (const transfer of page) {
    // Unlike Payment's Money objects, a transfer's amount is a plain number of
    // major units.
    records.push({
      id: transfer.id,
      kind: "transfer",
      amountCents: toCents(transfer.amount),
      currency: String(transfer.currency).toLowerCase(),
      status: normalize(String(transfer.status), "transfer"),
    });
  }

  return records;
}

function normalizeLocal(
  record: LocalLedgerRecord,
  normalize: (status: string, kind: RecordKind) => string
): NormalizedRecord {
  return {
    id: record.id,
    kind: record.kind,
    amountCents:
      typeof record.amount === "string"
        ? decimalStringToCents(record.amount)
        : toCents(record.amount),
    currency: record.currency.toLowerCase(),
    status: normalize(record.status, record.kind),
  };
}

function diff(
  whopRecords: NormalizedRecord[],
  localRecords: NormalizedRecord[],
  kind: RecordKind
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const localById = new Map(localRecords.map((record) => [record.id, record]));
  const whopIds = new Set(whopRecords.map((record) => record.id));

  for (const whop of whopRecords) {
    const local = localById.get(whop.id);

    if (!local) {
      discrepancies.push({
        type: "missing_in_ledger",
        recordId: whop.id,
        kind,
        detail: `${kind} ${whop.id} is on Whop but not in the local ledger`,
        whop,
      });
      continue;
    }

    if (whop.currency !== local.currency) {
      discrepancies.push({
        type: "currency_mismatch",
        recordId: whop.id,
        kind,
        detail: `${kind} ${whop.id}: Whop ${whop.currency}, local ${local.currency}`,
        whop,
        local,
      });
    } else if (whop.amountCents !== local.amountCents) {
      // Only meaningful once the currencies agree.
      discrepancies.push({
        type: "amount_mismatch",
        recordId: whop.id,
        kind,
        detail:
          `${kind} ${whop.id}: Whop ${formatMoney(toMajorUnits(whop.amountCents), whop.currency)}, ` +
          `local ${formatMoney(toMajorUnits(local.amountCents), local.currency)}`,
        whop,
        local,
      });
    }

    if (whop.status !== local.status) {
      discrepancies.push({
        type: "status_mismatch",
        recordId: whop.id,
        kind,
        detail: `${kind} ${whop.id}: Whop "${whop.status}", local "${local.status}"`,
        whop,
        local,
      });
    }
  }

  for (const local of localRecords) {
    if (!whopIds.has(local.id)) {
      discrepancies.push({
        type: "missing_in_whop",
        recordId: local.id,
        kind,
        detail: `${kind} ${local.id} is in the local ledger but not on Whop`,
        local,
      });
    }
  }

  return discrepancies;
}

/** Render a report as human-readable lines, newest concern first. */
export function formatReport(report: ReconciliationReport): string {
  const lines = [
    `Reconciliation: ${report.sellerAccountId}`,
    `Generated ${report.generatedAt}`,
    `Window: ${report.window.since ?? "beginning"} to ${report.window.until ?? "now"}`,
    "",
    `Payments   Whop ${report.counts.whopPayments}  local ${report.counts.localPayments}`,
    `Transfers  Whop ${report.counts.whopTransfers}  local ${report.counts.localTransfers}`,
    `Discrepancies: ${report.counts.discrepancies}`,
  ];

  if (report.discrepancies.length === 0) {
    lines.push("", "In sync.");
    return lines.join("\n");
  }

  lines.push("");
  for (const discrepancy of report.discrepancies) {
    lines.push(`  [${discrepancy.type}] ${discrepancy.detail}`);
  }

  return lines.join("\n");
}
