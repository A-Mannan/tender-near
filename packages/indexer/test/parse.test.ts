import assert from "node:assert/strict";
import { test } from "node:test";
import { blockTimestampNs } from "../src/poller.js";
import {
  escrowTokenLabel,
  normalizeEscrowToken,
  parseTenderLog,
  parseTenderLogs,
  fieldUint,
} from "../src/events.js";

const validEvent = {
  standard: "tender",
  version: "1.0.0",
  event: "bid_revealed",
  data: [{ job_id: "0", worker: "w1.testnet", bid_yocto: "1800000000000000000000000" }],
};

test("parses a valid Tender NEP-297 log", () => {
  const parsed = parseTenderLog(`EVENT_JSON:${JSON.stringify(validEvent)}`);
  assert.ok(parsed);
  assert.equal(parsed.event, "bid_revealed");
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0]?.worker, "w1.testnet");
});

test("supports multiple data entries per event", () => {
  const payload = {
    ...validEvent,
    data: [validEvent.data[0], { ...validEvent.data[0], worker: "w2.testnet" }],
  };
  const parsed = parseTenderLog(`EVENT_JSON:${JSON.stringify(payload)}`);
  assert.equal(parsed?.data.length, 2);
});

test("ignores non-Tender, malformed and future-version logs", () => {
  assert.equal(parseTenderLog("plain log"), null);
  assert.equal(parseTenderLog("EVENT_JSON:{not json"), null);
  assert.equal(parseTenderLog(`EVENT_JSON:${JSON.stringify({ ...validEvent, standard: "nep141" })}`), null);
  assert.equal(parseTenderLog(`EVENT_JSON:${JSON.stringify({ ...validEvent, version: "2.0.0" })}`), null);
  assert.equal(parseTenderLog(`EVENT_JSON:${JSON.stringify({ ...validEvent, event: "" })}`), null);
  assert.equal(parseTenderLog(`EVENT_JSON:${JSON.stringify({ ...validEvent, data: "nope" })}`), null);
});

test("parseTenderLogs preserves order and skips unrelated logs", () => {
  const logs = [
    "INFO hello",
    `EVENT_JSON:${JSON.stringify(validEvent)}`,
    "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[]}",
  ];
  const parsed = parseTenderLogs(logs);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.event, "bid_revealed");
});

test("normalizes escrow tokens and rejects unknown shapes", () => {
  assert.deepEqual(normalizeEscrowToken("Near"), { kind: "near" });
  assert.deepEqual(normalizeEscrowToken({ Ft: { token_id: "usdc.testnet" } }), {
    kind: "ft",
    token_id: "usdc.testnet",
  });
  assert.equal(normalizeEscrowToken({ Ft: {} }), null);
  assert.equal(escrowTokenLabel("Near"), "NEAR");
  assert.equal(escrowTokenLabel({ Ft: { token_id: "usdc.testnet" } }), "FT usdc.testnet");
});

test("fieldUint canonicalizes decimal strings and rejects negatives", () => {
  assert.equal(fieldUint({ value: "0012" }, "value"), "12");
  assert.equal(fieldUint({ value: 12 }, "value"), "12");
  assert.equal(fieldUint({ value: "-1" }, "value"), null);
  assert.equal(fieldUint({ value: "1.5" }, "value"), null);
  assert.equal(fieldUint({}, "value"), null);
});
test("blockTimestampNs prefers exact nanosec strings over lossy JSON numbers", () => {
  assert.equal(
    blockTimestampNs({ timestamp_nanosec: "1794602483350711710", timestamp: 1794602483350711800 }),
    "1794602483350711710",
  );
  assert.equal(blockTimestampNs({ timestamp_ns: "1700000000000000000" }), "1700000000000000000");
  assert.equal(blockTimestampNs({ timestamp: 1794602483350712 }), "1794602483350712");
  assert.throws(() => blockTimestampNs({}), /missing a timestamp/);
});
