"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileStore, MemoryStore } = require("../dist/store");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledgerly-store-"));

test("FileStore round-trips through the file", async () => {
  const filePath = path.join(tempDir(), "state.json");

  const writer = new FileStore(filePath);
  await writer.set("a", "1");
  await writer.set("b", "2");

  const reader = new FileStore(filePath);
  assert.equal(await reader.get("a"), "1");
  assert.equal(await reader.has("b"), true);
  assert.equal(await reader.has("missing"), false);
  assert.equal(reader.size(), 2);
});

test("an absent file is an empty store, not an error", async () => {
  const store = new FileStore(path.join(tempDir(), "does-not-exist.json"));
  assert.equal(store.size(), 0);
});

test("a corrupt store refuses to start rather than silently losing idempotency", () => {
  const filePath = path.join(tempDir(), "corrupt.json");
  fs.writeFileSync(filePath, "{ this is not json");

  // Starting empty here would re-process every webhook already handled.
  assert.throws(() => new FileStore(filePath), /Could not read store/);
});

test("a store holding the wrong JSON shape is rejected", () => {
  const filePath = path.join(tempDir(), "array.json");
  fs.writeFileSync(filePath, '["evt_1", "evt_2"]');

  assert.throws(() => new FileStore(filePath), /Could not read store/);
});

test("writes are atomic: no partial file is left behind", async () => {
  const directory = tempDir();
  const filePath = path.join(directory, "state.json");
  const store = new FileStore(filePath);

  await store.set("key", "value");

  const leftovers = fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp files must be renamed, not abandoned");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), { key: "value" });
});

test("MemoryStore satisfies the same contract", async () => {
  const store = new MemoryStore();
  assert.equal(await store.has("a"), false);
  await store.set("a", "1");
  assert.equal(await store.get("a"), "1");
  assert.equal(store.size(), 1);
});
