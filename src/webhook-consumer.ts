import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import type { KeyValueStore } from "./store";
import { EXTERNAL_ID_METADATA_KEY } from "./onboarding";

export { WebhookVerificationError };

/**
 * The envelope Whop wraps every event in.
 *
 * `account_id` carries the connected account an event belongs to. Whop pinned
 * that name on 2026-08-14; deliveries on older API versions carry `company_id`
 * instead, so {@link sellerAccountIdOf} reads whichever is present.
 */
export interface WhopWebhookEvent<TData = Record<string, unknown>> {
  /** Webhook message id. Matches the `webhook-id` header. */
  id: string;
  /** Event name, e.g. `payment.succeeded`. */
  type: string;
  account_id?: string;
  /** Pre-2026-08-14 name for `account_id`. */
  company_id?: string;
  api_version?: string;
  timestamp?: string;
  data: TData;
  /** Present on `.updated` events: the fields as they were before the change. */
  previous_attributes?: Record<string, unknown>;
}

/** An event plus the seller it belongs to. */
export interface RoutedEvent<TData = Record<string, unknown>> {
  event: WhopWebhookEvent<TData>;
  /** The connected account, prefixed `biz_`. Null on platform-level events. */
  sellerAccountId: string | null;
  /**
   * Ledgerly's own seller id, resolved through the onboarding store.
   * Null when the account is unknown to us. See {@link WebhookConsumer.handle}.
   */
  externalId: string | null;
}

export type EventHandler<TData = Record<string, unknown>> = (
  routed: RoutedEvent<TData>
) => Promise<void>;

export interface WebhookConsumerOptions {
  /**
   * The endpoint's signing secret, exactly as Whop displays it, `ws_` prefix
   * included. Do not strip the prefix or pre-encode it.
   */
  secret: string;
  /** Durable store of processed message ids. Survives restarts. */
  store: KeyValueStore;
  /**
   * Maps a connected account id back to Ledgerly's seller id. Defaults to
   * reading the mapping {@link onboardSeller} writes.
   */
  resolveExternalId?: (sellerAccountId: string) => Promise<string | null>;
}

export interface HandleResult {
  /** False when the message id had already been processed. */
  processed: boolean;
  eventType: string;
  sellerAccountId: string | null;
  externalId: string | null;
  /** True when no handler was registered for this event type. */
  unhandled: boolean;
}

/** The connected account an event belongs to, across API versions. */
export function sellerAccountIdOf(event: WhopWebhookEvent): string | null {
  return event.account_id ?? event.company_id ?? null;
}

const processedKey = (messageId: string) => `webhook:${messageId}`;

/**
 * Verifies, deduplicates and routes Whop webhooks.
 *
 * ## Delivery semantics
 *
 * At-least-once. A message id is recorded as processed only after its handler
 * resolves, so a crash mid-handler leaves it unrecorded and Whop's retry runs
 * the handler again. That is the safe direction to fail, since the alternative
 * loses events outright, but it does mean **handlers must be idempotent themselves**.
 * Key your own writes on `event.id`, or on the payment/transfer id inside
 * `event.data`.
 *
 * A handler that throws propagates out of {@link handle}, so the endpoint can
 * answer non-2xx and let Whop redeliver.
 */
export class WebhookConsumer {
  private readonly secret: string;
  private readonly store: KeyValueStore;
  private readonly resolveExternalId: (sellerAccountId: string) => Promise<string | null>;
  private readonly handlers = new Map<string, EventHandler<any>>();
  private readonly wildcardHandlers: EventHandler<any>[] = [];

  constructor(options: WebhookConsumerOptions) {
    if (!options.secret) {
      throw new Error("A webhook signing secret is required");
    }

    this.secret = options.secret;
    this.store = options.store;
    this.resolveExternalId =
      options.resolveExternalId ??
      (async (sellerAccountId) =>
        (await this.store.get(`account:${sellerAccountId}`)) ?? null);
  }

  /** Register the handler for one event type. Replaces any previous one. */
  on<TData = Record<string, unknown>>(eventType: string, handler: EventHandler<TData>): this {
    this.handlers.set(eventType, handler);
    return this;
  }

  /** Register a handler that runs for every event, after the typed one. */
  onAny(handler: EventHandler): this {
    this.wildcardHandlers.push(handler);
    return this;
  }

  /**
   * Verify, deduplicate and dispatch one delivery.
   *
   * @param rawBody The exact bytes of the request body. Signatures cover the
   * bytes Whop sent, so a re-serialized body never verifies: pass
   * `await request.text()`, never `JSON.stringify(await request.json())`.
   * @param headers The request headers. `webhook-id`, `webhook-timestamp` and
   * `webhook-signature` are read, case-insensitively.
   *
   * @throws {WebhookVerificationError} when the signature is missing, malformed,
   * outside the timestamp tolerance, or simply wrong. Answer 400 and do not
   * retry: a bad signature never becomes good.
   * @throws {Error} propagated from a handler. Answer 5xx so Whop redelivers.
   */
  async handle(rawBody: string, headers: Record<string, string>): Promise<HandleResult> {
    // Throws unless the signature verifies. Nothing below this line runs on an
    // unsigned or badly-signed request, including the JSON parse.
    const event = unwrapWebhook<WhopWebhookEvent>(rawBody, {
      headers,
      key: this.secret,
    });

    const messageId = headerValue(headers, "webhook-id") ?? event.id;

    if (!messageId) {
      throw new Error("Delivery has neither a webhook-id header nor an envelope id");
    }

    const sellerAccountId = sellerAccountIdOf(event);
    const externalId = sellerAccountId
      ? await this.resolveExternalId(sellerAccountId)
      : null;

    if (await this.store.has(processedKey(messageId))) {
      return {
        processed: false,
        eventType: event.type,
        sellerAccountId,
        externalId,
        unhandled: false,
      };
    }

    const handler = this.handlers.get(event.type);
    const routed: RoutedEvent = { event, sellerAccountId, externalId };

    if (handler) {
      await handler(routed);
    }

    for (const wildcard of this.wildcardHandlers) {
      await wildcard(routed);
    }

    // Only now: a handler that threw above leaves this unwritten, and Whop's
    // retry gets another attempt.
    await this.store.set(processedKey(messageId), new Date().toISOString());

    return {
      processed: true,
      eventType: event.type,
      sellerAccountId,
      externalId,
      unhandled: !handler,
    };
  }

  /**
   * Record the account -> seller mapping this consumer routes with.
   *
   * Call it for each seller you onboard, so events arriving for that account
   * resolve to a Ledgerly seller id instead of null. When {@link onboardSeller}
   * and this consumer share a store, wire it into your onboarding path.
   */
  async registerSeller(sellerAccountId: string, externalId: string): Promise<void> {
    await this.store.set(`account:${sellerAccountId}`, externalId);
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;

  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

export { EXTERNAL_ID_METADATA_KEY };
