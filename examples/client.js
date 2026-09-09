"use strict";

const { WhopClient } = require("@whop/sdk");

/** A platform-authenticated Whop client, or a clear error about what's missing. */
function platformClient() {
  const token = process.env.WHOP_API_KEY;

  if (!token) {
    console.error("WHOP_API_KEY is not set. Copy .env.example and fill it in.");
    process.exit(1);
  }

  return new WhopClient({
    token,
    environment: process.env.WHOP_API_URL || "https://sandbox-api.whop.com/api/v1",
  });
}

module.exports = { platformClient };
