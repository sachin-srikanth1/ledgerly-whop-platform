/**
 * Ledgerly platform SDK for Whop.
 *
 * Four pieces, each usable on its own: idempotent seller onboarding, checkout
 * carrying Ledgerly's 8% application fee, a webhook consumer that verifies
 * Standard Webhooks signatures and routes events to the right seller, and a
 * reconciliation job that diffs Whop against the local ledger.
 */

export { FileStore, MemoryStore } from "./store";
export type { KeyValueStore } from "./store";

export { decimalStringToCents, formatMoney, toCents, toMajorUnits } from "./money";

export {
  DEFAULT_REFRESH_URL,
  DEFAULT_RETURN_URL,
  EXTERNAL_ID_METADATA_KEY,
  findAccountByExternalId,
  getOnboardingStatus,
  onboardSeller,
  rebuildStore,
} from "./onboarding";
export type {
  OnboardingStatus,
  OnboardSellerInput,
  OnboardSellerOptions,
  OnboardSellerResult,
  RebuildStoreResult,
} from "./onboarding";

export {
  calculateApplicationFee,
  createCheckout,
  getFeeBreakdown,
  LEDGERLY_FEE_BASIS_POINTS,
  MAX_PRODUCT_TITLE_LENGTH,
  validateApplicationFee,
} from "./checkout";
export type { CreateCheckoutInput, CreateCheckoutResult } from "./checkout";

export {
  sellerAccountIdOf,
  WebhookConsumer,
  WebhookVerificationError,
} from "./webhook-consumer";
export type {
  EventHandler,
  HandleResult,
  HeadersLike,
  RoutedEvent,
  WebhookConsumerOptions,
  WhopWebhookEvent,
} from "./webhook-consumer";

export { formatReport, reconcileSeller } from "./reconciliation";
export type {
  Discrepancy,
  DiscrepancyType,
  LocalLedgerRecord,
  NormalizedRecord,
  RecordKind,
  ReconciliationReport,
  ReconcileOptions,
} from "./reconciliation";

export { paySellerShare, splitSellerShare } from "./transfers";
export type { PaySellerShareInput, PaySellerShareResult } from "./transfers";
