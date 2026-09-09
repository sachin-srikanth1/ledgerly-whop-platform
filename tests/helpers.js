"use strict";

const { Webhook } = require("standardwebhooks");

/**
 * Sign a payload exactly the way Whop's backend does, so tests exercise the
 * real verification path rather than a stub.
 *
 * Whop HMACs with the literal bytes of the `ws_` secret it issued, while
 * `standardwebhooks` base64-decodes whatever key it is given. Base64-encoding
 * the whole secret here cancels that decode out, the same trick
 * `unwrapWebhook` uses on the verifying side.
 */
function signWebhook({ secret, messageId, payload, timestamp = new Date() }) {
  const signer = new Webhook(Buffer.from(secret, "utf-8").toString("base64"));

  return {
    "webhook-id": messageId,
    "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
    "webhook-signature": signer.sign(messageId, timestamp, payload),
  };
}

/** A Whop client stub whose `list` calls return async-iterable pages. */
function fakeClient({ payments = [], transfers = [], onList } = {}) {
  const record = (resource, request) => {
    if (onList) onList(resource, request);
  };

  return {
    payments: {
      list: async (request) => {
        record("payments", request);
        return payments;
      },
    },
    transfers: {
      list: async (request) => {
        record("transfers", request);
        return transfers;
      },
    },
  };
}

/** A Whop `Money` value: an exact decimal string plus its precision. */
const money = (amount, currency = "usd") => ({
  amount,
  currency,
  decimals: 2,
  display_decimals: 2,
});

module.exports = { signWebhook, fakeClient, money };
