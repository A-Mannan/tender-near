import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TapeDb } from "../src/db.js";
import { applyReplayWindow, type ReplayWindow } from "../src/replay.js";

const replay = JSON.parse(
  readFileSync(new URL("../../../../deployments/testnet-replay.json", import.meta.url), "utf8"),
) as ReplayWindow;
let dir: string;
let db: TapeDb;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tender-replay-"));
  db = new TapeDb(join(dir, "replay.sqlite"));
  applyReplayWindow(db, replay);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("public testnet replay reproduces exact jobs, prints and contiguous block coverage", () => {
  assert.deepEqual(db.counts(), {
    events: 24,
    jobs: 3,
    prints: 2,
    blocks: 595,
  });
  assert.equal(db.lastProcessedHeight(), replay.indexer.last_indexed_block);
  assert.equal(db.latestBlock()?.height, replay.indexer.last_indexed_block);
  assert.equal(db.getJobById("tender-hack-1114g.testnet:3")?.status, "Settled");
  assert.equal(db.getJobById("tender-hack-1114g.testnet:4")?.status, "Settled");
  assert.equal(db.getJobById("tender-hack-1114g.testnet:5")?.status, "CancelledZeroReveals");

  const audit = db.getPrint("tender-hack-1114g.testnet:3");
  assert.equal(audit?.clearing_price, "1100000000000000000000000");
  assert.equal(audit?.winning_bid, "900000000000000000000000");
  assert.equal(audit?.savings_bps, 2666);
  assert.equal(audit?.tx_hash, "9Hkvi6XxdvdenfQBJqXdnFRH2Y4ZH31L94zWjo3UXnho");
});

test("replaying the same window is idempotent and validates projection metadata", () => {
  applyReplayWindow(db, replay);
  assert.equal(db.counts().events, 24);
  assert.throws(
    () => applyReplayWindow(db, {
      ...replay,
      indexer: { ...replay.indexer, events: replay.indexer.events + 1 },
    }),
    /replay projection does not match/,
  );
});
