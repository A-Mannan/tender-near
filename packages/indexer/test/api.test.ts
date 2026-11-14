import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApiServer } from "../src/api.js";
import type { IndexerConfig } from "../src/config.js";
import { TapeDb } from "../src/db.js";
import type { Indexer, IndexerStatus, SyncSummary } from "../src/poller.js";
import {
  applyFixture,
  buildFixture,
  ftJobCreated,
  nearExact,
  revealed,
  settled,
  type Fixture,
} from "./fixtures/data.js";
import type { StoredEvent } from "../src/derive.js";

let dir: string;
let db: TapeDb;
let server: Server;
let baseUrl: string;
let fixture: Fixture;

const status: IndexerStatus = {
  running: true,
  last_sync_at: "2026-11-13T20:00:00.000Z",
  last_error: null,
  last_rpc_height: 108,
  last_indexed_height: 107,
  syncs: 1,
  total_events: 26,
  total_blocks: 8,
};

const stubIndexer = {
  status: () => status,
  syncOnce: async (): Promise<SyncSummary> => ({
    from: 108,
    to: 108,
    blocks: 1,
    events: 0,
    prints: 0,
    skipped: 0,
    warnings: [],
  }),
} as unknown as Indexer;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tender-api-"));
  const dbPath = join(dir, "test.sqlite");
  db = new TapeDb(dbPath);
  fixture = buildFixture();
  applyFixture(db, fixture);
  const ftContract = "ft-tender.testnet";
  const ftEvents: StoredEvent[] = [
    ftJobCreated(4, 107, {
      buyer: "ft-buyer.testnet",
      tokenId: "fake-ft.testnet",
      category: "tokenized-labor",
      contract: ftContract,
    }),
    revealed(4, 107, "ft-worker.testnet", nearExact(700), 1, 1, {
      category: "smart-contract-audit",
      contract: ftContract,
    }),
    revealed(4, 107, "near-worker.testnet", nearExact(600), 1, 2, {
      category: "smart-contract-audit",
      contract: ftContract,
    }),
    settled(4, 107, {
      title: "FT fixture",
      category: "smart-contract-audit",
      winner: "ft-worker.testnet",
      reserve: nearExact(1000),
      winning: nearExact(700),
      runnerUp: nearExact(800),
      clearing: nearExact(800),
      workUnits: 1,
      unitLabel: "task",
      escrowToken: { Ft: { token_id: "fake-ft.testnet" } },
    }),
  ].map((item) => ({ ...item, contractId: ftContract }));
  db.applyBlock(
    { height: 107, hash: "Blk107-ft", timestampNs: "1700000210000000000" },
    ftEvents,
  );

  const config: IndexerConfig = {
    rpcUrl: "http://127.0.0.1:3030",
    dbPath,
    host: "127.0.0.1",
    port: 0,
    startBlock: null,
    endBlock: null,
    maxBlocksPerSync: 10,
    intervalMs: 1_000,
    corsOrigins: ["*"],
    network: "sandbox",
    contractFilter: [],
    demoMode: false,
    maxTxsPerBlock: 10,
    concurrency: 8,
  };

  server = createApiServer({ config, db, indexer: stubIndexer });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = (await response.json()) as any;
  return { status: response.status, body, headers: response.headers };
}

test("health reports indexer and chain state", async () => {
  const { status: code, body, headers } = await get("/health");
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.network, "sandbox");
  assert.equal(body.counts.events, 26);
  assert.equal(body.counts.prints, 3);
  assert.equal(body.latest_block.height, 107);
  assert.equal(body.indexer.last_indexed_height, 107);
  assert.equal(headers.get("access-control-allow-origin"), "*");
});

test("config and facets advertise real indexed data", async () => {
  const config = await get("/config");
  assert.equal(config.body.network, "sandbox");
  assert.deepEqual(config.body.contracts, ["ft-tender.testnet", "tender.testnet"]);
  assert.equal(config.body.demo_mode, false);

  const facets = await get("/facets");
  assert.deepEqual(facets.body.categories, ["data-labeling", "smart-contract-audit"]);
  assert.deepEqual(facets.body.units, ["1k-rows", "kloc", "task"]);
});

test("tape returns settled prints with exact price views", async () => {
  const { status: code, body } = await get("/tape?limit=10");
  assert.equal(code, 200);
  assert.equal(body.total, 3);
  assert.equal(body.items.length, 3);
  const ft = body.items.find((item: any) => item.id === "ft-tender.testnet:4");
  assert.equal(ft.escrow.kind, "ft");
  assert.equal(ft.escrow.token_id, "fake-ft.testnet");
  assert.equal(ft.clearing_price.raw, nearExact(800));
  assert.equal(ft.clearing_price.near, null);
  const vickrey = body.items.find((item: any) => item.id === "tender.testnet:0");
  assert.ok(vickrey);
  assert.equal(vickrey.clearing_price.raw, "1800000000000000000000000");
  assert.equal(vickrey.clearing_price.near, "1.8");
  assert.equal(vickrey.unit_price.near, "0.6");
  assert.equal(vickrey.unit_label, "kloc");
  assert.equal(vickrey.savings_bps, 4000);
  assert.equal(vickrey.tx_hash.startsWith("Tx"), true);
  assert.equal(vickrey.explorer_url, null, "sandbox has no public explorer");
});

test("tape filters by category and rejects invalid parameters", async () => {
  const filtered = await get("/tape?category=data-labeling");
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0].id, "tender.testnet:1");

  assert.equal((await get("/tape?limit=0")).status, 400);
  assert.equal((await get("/tape?limit=abc")).status, 400);
  assert.equal((await get("/tape?category=" + "x".repeat(65))).status, 400);
  assert.equal((await get("/tape?contract=not a valid id!")).status, 400);
  assert.equal((await get("/tape?escrow=gold")).status, 400);
  assert.equal((await get("/tape?window_hours=-2")).status, 400);
});

test("median endpoint matches fixture arithmetic", async () => {
  const { body } = await get("/tape/median?escrow=near");
  assert.equal(body.count, 2);
  assert.equal(body.median_unit_price, fixture.expected.medianUnitPrice);
  assert.equal(body.median_unit_price_near, "0.55");
  assert.equal(body.median_clearing_price, fixture.expected.medianClearingPrice);
  assert.equal(body.volume_clearing, fixture.expected.volumeClearing);
  assert.equal(body.buyer_savings, fixture.expected.buyerSavings);
  assert.equal(body.median_savings_bps, fixture.expected.medianSavingsBps);
  assert.deepEqual(body.units, ["1k-rows", "kloc"]);

  const category = await get("/tape/median?category=smart-contract-audit&escrow=near");
  assert.equal(category.body.count, 1);
  assert.equal(category.body.median_unit_price_near, "0.6");
});

test("median grouping by category returns one bucket per category", async () => {
  const { body } = await get("/tape/median?group_by=category&escrow=near");
  assert.equal(body.by_category.length, 2);
  const audit = body.by_category.find((bucket: any) => bucket.category === "smart-contract-audit");
  assert.equal(audit.stats.count, 1);
  assert.equal(audit.stats.median_unit_price, "600000000000000000000000");
  assert.equal(audit.stats.volume_clearing_near, "1.8");
});

test("spread endpoint reports exact min, quartiles and max", async () => {
  const { body } = await get("/tape/spread?escrow=near");
  assert.equal(body.count, 2);
  assert.equal(body.min_unit_price_near, "0.5");
  assert.equal(body.max_unit_price_near, "0.6");
  assert.equal(body.spread, fixture.expected.spread);
  assert.equal(body.spread_bps, fixture.expected.spreadBps);
});

test("win-rate endpoint merges reveals and wins, including zero-win workers", async () => {
  const { body } = await get("/tape/win-rate?limit=10");
  assert.equal(body.count, 3);
  const byWorker = new Map<string, any>(body.items.map((row: any) => [row.worker, row]));
  assert.equal(byWorker.get("worker1.testnet").wins, 1);
  assert.equal(byWorker.get("worker1.testnet").reveals, 2);
  assert.equal(byWorker.get("worker1.testnet").win_rate_bps, 5000);
  assert.equal(byWorker.get("worker3.testnet").wins, 0);
  assert.equal(byWorker.get("worker3.testnet").win_rate_bps, 0);
  assert.equal(byWorker.get("worker1.testnet").volume_won_near, "1.8");
  assert.equal(byWorker.has("ft-worker.testnet"), false);
  assert.equal(byWorker.has("near-worker.testnet"), false);

  const ft = await get("/tape/win-rate?limit=10&escrow=ft");
  const ftByWorker = new Map<string, any>(ft.body.items.map((row: any) => [row.worker, row]));
  assert.equal(ftByWorker.get("ft-worker.testnet").wins, 1);
  assert.equal(ftByWorker.get("ft-worker.testnet").reveals, 1);
  assert.equal(ftByWorker.get("ft-worker.testnet").volume_won_near, null);
  assert.equal(ft.body.filters.escrow, "ft");
  assert.equal(ftByWorker.has("near-worker.testnet"), true);
  assert.equal(ftByWorker.get("near-worker.testnet").wins, 0);
  assert.equal(ftByWorker.get("near-worker.testnet").reveals, 1);
  assert.equal(ftByWorker.get("near-worker.testnet").volume_won_near, null);
});

test("jobs list and detail expose events, receipt ids and tx hashes", async () => {
  const list = await get("/jobs?limit=10");
  assert.equal(list.body.total, 5);
  assert.equal(list.body.items.length, 5);

  const detail = await get("/jobs/tender.testnet:0");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.job.status, "Settled");
  assert.equal(detail.body.job.spec_uri, "ipfs://spec-0");
  assert.equal(detail.body.print.id, "tender.testnet:0");
  assert.equal(detail.body.events.length, 10);
  assert.equal(detail.body.events[0].event, "job_created");
  assert.ok(detail.body.events[0].receipt_id);
  assert.ok(detail.body.events[0].tx_hash);

  const short = await get("/jobs/0");
  assert.equal(short.body.job.id, "tender.testnet:0");

  assert.equal((await get("/jobs/999")).status, 404);
});

test("receipt inspection returns stored NEP-297 payloads", async () => {
  const detail = await get("/jobs/tender.testnet:0");
  const receiptId = detail.body.events[0].receipt_id;
  const receipt = await get(`/receipts/${receiptId}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.items[0].event, "job_created");
  assert.equal(receipt.body.items[0].data.title, "Job 0");
  assert.equal((await get("/receipts/not-a-receipt")).status, 400);
  const missing = `11111111111111111111111111111111`;
  assert.equal((await get(`/receipts/${missing}`)).status, 404);
});

test("events feed is bounded and newest-first", async () => {
  const { body } = await get("/events?limit=5");
  assert.equal(body.count, 5);
  assert.equal(body.items[0].block_height, 107);
  assert.equal((await get("/events?limit=501")).status, 400);
});

test("manual sync returns the indexer summary", async () => {
  const response = await fetch(`${baseUrl}/sync`, { method: "POST" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.blocks, 1);
  assert.deepEqual(body.warnings, []);
});

test("unknown routes return a JSON 404", async () => {
  const { status: code, body } = await get("/nope");
  assert.equal(code, 404);
  assert.match(body.error, /no route/);
});

test("OPTIONS preflight is CORS-friendly", async () => {
  const response = await fetch(`${baseUrl}/tape`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /GET/);
});