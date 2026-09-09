"use strict";

/**
 * A webhook endpoint that verifies signatures, deduplicates, and routes events
 * to the seller they belong to.
 *
 * Point a Whop webhook at http://localhost:3000/webhooks (through a tunnel) and
 * enable `child_resource_events` so the platform receives connected accounts'
 * events, not just its own.
 */

const http = require("node:http");
const path = require("node:path");
const { WebhookConsumer, FileStore, WebhookVerificationError } = require("../dist");

const secret = process.env.WHOP_WEBHOOK_SECRET;

if (!secret) {
  console.error("WHOP_WEBHOOK_SECRET is not set. Copy .env.example and fill it in.");
  process.exit(1);
}

// The same file examples/onboard-seller.js writes to, so events for an account
// onboarded there resolve to its Ledgerly seller id.
const store = new FileStore(path.join(process.cwd(), "seller-accounts.json"));
const consumer = new WebhookConsumer({ secret, store });

const describe = ({ event, externalId, sellerAccountId }) =>
  `${event.type} for ${externalId ?? sellerAccountId ?? "the platform"}`;

consumer.on("payment.succeeded", async (routed) => {
  console.log(`  ${describe(routed)} — payment ${routed.event.data.id}`);
  // Credit the seller's ledger. Key the write on routed.event.id or the
  // payment id: this handler can run more than once for the same event.
});

consumer.on("refund.created", async (routed) => {
  console.log(`  ${describe(routed)} — refund ${routed.event.data.id}`);
  // Whop does not reverse the application fee on a refund. Decide explicitly
  // whether Ledgerly returns its 8%, and record that decision here.
});

consumer.on("dispute.created", async (routed) => {
  console.log(`  ${describe(routed)} — dispute ${routed.event.data.id}`);
});

consumer.on("transfer.completed", async (routed) => {
  console.log(`  ${describe(routed)} — transfer ${routed.event.data.id}`);
});

consumer.on("payout.updated", async (routed) => {
  console.log(`  ${describe(routed)} — payout now ${routed.event.data.status}`);
});

consumer.on("account.updated", async (routed) => {
  console.log(`  ${describe(routed)} — account state changed`);
});

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    // The signature covers the exact bytes Whop sent, so keep them intact.
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    request.on("error", reject);
  });

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/webhooks") {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const result = await consumer.handle(await readBody(request), request.headers);

    console.log(
      result.processed
        ? `✓ ${result.eventType}${result.unhandled ? " (no handler)" : ""}`
        : `· ${result.eventType} already processed`
    );

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      // A bad signature never becomes good: 400, so Whop stops retrying.
      console.error(`✗ rejected: ${error.message}`);
      response.writeHead(400).end("Invalid signature");
      return;
    }

    // A handler failed. 500 so Whop redelivers and the handler runs again.
    console.error("✗ handler failed:", error);
    response.writeHead(500).end("Handler failed");
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Listening on :${process.env.PORT || 3000}, POST /webhooks`);
});
