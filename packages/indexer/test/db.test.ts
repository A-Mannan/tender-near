import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TapeDb } from "../src/db.js";
import { projectJob, type StoredEvent } from "../src/derive.js";
import { applyFixture, buildFixture, type Fixture } from "./fixtures/data.js";

let dir: string;
let db: TapeDb;
let fixture: Fixture;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tender-indexer-"));
  db = new TapeDb(join(dir, "test.sqlite"));
  fixture = buildFixture();
  applyFixture(db, fixture);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("indexes every block and event from the fixture", () => {
  const counts = db.counts();
  assert.equal(counts.blocks, 7);
  assert.equal(counts.events, 22);
  assert.equal(counts.jobs, 4);
  assert.equal(counts.prints, 2);
  assert.equal(db.lastProcessedHeight(), 106);
  assert.equal(db.latestBlock()?.height, 106);
});

test("projects the settled Vickrey job with exact unit price and print metadata", () => {
  const job = db.getJobById("tender.testnet:0");
  assert.ok(job);
  assert.equal(job.status, "Settled");
  assert.equal(job.winner, "worker1.testnet");
  assert.equal(job.clearing_price, "1800000000000000000000000");
  assert.equal(job.unit_price, "600000000000000000000000");
  assert.equal(job.commit_count, 3);
  assert.equal(job.reveal_count, 3);
  assert.equal(job.spec_uri, "ipfs://spec-0");

  const print = db.getPrint("tender.testnet:0");
  assert.ok(print);
  assert.equal(print.unit_price, "600000000000000000000000");
  assert.equal(print.unit_label, "kloc");
  assert.equal(print.savings_bps, 4000);
  assert.equal(print.worker_premium_bps, 5000);
  assert.equal(print.tx_hash?.startsWith("Tx"), true);
  assert.equal(print.block_height, 105);
});

test("projects FirstPrice, refunded and rolled-back jobs correctly", () => {
  const firstPrice = db.getJobById("tender.testnet:1");
  assert.equal(firstPrice?.status, "Settled");
  assert.equal(firstPrice?.mechanism, "FirstPrice");
  assert.equal(firstPrice?.unit_price, "500000000000000000000000");

  const refunded = db.getJobById("tender.testnet:2");
  assert.equal(refunded?.status, "CancelledZeroReveals");
  assert.equal(db.getPrint("tender.testnet:2"), null);

  const rolledBack = db.getJobById("tender.testnet:3");
  assert.equal(rolledBack?.status, "Delivered");
  assert.equal(rolledBack?.settle_trigger, null);
});

test("re-ingesting the same blocks is idempotent", () => {
  const beforeCounts = db.counts();
  for (const block of fixture.blocks) {
    const result = db.applyBlock(
      { height: block.height, hash: block.hash, timestampNs: block.timestampNs },
      block.events,
    );
    assert.equal(result.insertedEvents, 0, "duplicate events must be ignored");
  }
  assert.deepEqual(db.counts(), beforeCounts);
  assert.equal(db.listPrints().total, 2);
});

test("job projection is independent of event arrival order", () => {
  const events = db.jobEvents("tender.testnet", "0");
  const forward = projectJob(events);
  const shuffled = [...events].reverse();
  const backward = projectJob(shuffled);
  assert.deepEqual(backward, forward);
});

test("rebuildAll reconstructs projections from raw events", () => {
  const rebuilt = db.rebuildAll();
  assert.equal(rebuilt, 4);
  assert.equal(db.getJobById("tender.testnet:0")?.status, "Settled");
  assert.equal(db.listPrints().total, 2);
});

test("short job id lookup is unambiguous for this contract", () => {
  assert.equal(db.getJobById("0")?.id, "tender.testnet:0");
  assert.deepEqual(db.findJobIdByShortId("2"), ["tender.testnet:2"]);
  assert.equal(db.getJobById("999"), null);
});

test("worker reveal and win aggregates are exact", () => {
  const reveals = db.workerReveals();
  assert.deepEqual(
    reveals.sort((a, b) => a.worker.localeCompare(b.worker)),
    [
      { worker: "worker1.testnet", reveals: 2 },
      { worker: "worker2.testnet", reveals: 2 },
      { worker: "worker3.testnet", reveals: 1 },
    ],
  );
  const wins = db.workerWins().sort((a, b) => a.winner.localeCompare(b.winner));
  assert.deepEqual(wins, [
    { winner: "worker1.testnet", wins: 1, volume_won: "1800000000000000000000000" },
    { winner: "worker2.testnet", wins: 1, volume_won: "1000000000000000000000000" },
  ]);
});

test("queries filter by category, unit and escrow without SQL injection", () => {
  assert.equal(db.listPrints({ category: "data-labeling" }).total, 1);
  assert.equal(db.listPrints({ unit: "kloc" }).total, 1);
  assert.equal(db.listPrints({ escrow: "near" }).total, 2);
  assert.equal(db.listPrints({ escrow: "ft" }).total, 0);
  assert.equal(db.listPrints({ category: "x' OR 1=1 --" }).total, 0);
  assert.equal(db.listJobs({ category: "data-labeling" }).total, 1);
  assert.equal(db.listJobs({ status: "Settled" }).total, 2);
  assert.deepEqual(db.distinctCategories(), ["data-labeling", "smart-contract-audit"]);
});

test("recent events are newest-first and receipt lookup is stable", () => {
  const recent = db.recentEvents(3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0]?.blockHeight, 106);
  const first = db.jobEvents("tender.testnet", "0")[0];
  assert.ok(first);
  const receiptRows = db.eventsForReceipt(first.receiptId);
  assert.equal(receiptRows.length, 1);
  assert.equal(receiptRows[0]?.event, "job_created");
});

test("stored events retain the original NEP-297 payload", () => {
  const events: StoredEvent[] = db.jobEvents("tender.testnet", "0");
  const created = events.find((event) => event.event === "job_created");
  assert.equal(created?.data["title"], "Job 0");
  assert.equal(created?.data["reserve_price"], "3000000000000000000000000");
  assert.equal(created?.data["max_commits"], 16);
});