#!/usr/bin/env node
/**
 * End-to-end verification of the Tender indexer against real NEAR testnet
 * receipts produced by `scripts/testnet-demo.mjs`.
 *
 * Indexes a bounded block window into a fresh SQLite database, starts the
 * public API, and asserts every market-tape endpoint against the exact on-chain
 * clearing prices. Writes `deployments/testnet.json` on success.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, ".data");
const DEMO_PATH = join(DATA_DIR, "testnet-demo.json");
const DB_PATH = join(DATA_DIR, "testnet.sqlite");
const LOG_PATH = join(DATA_DIR, "indexer-testnet.log");
const DEPLOYMENTS_DIR = join(ROOT, "deployments");
const OUT_PATH = join(DEPLOYMENTS_DIR, "testnet.json");

const PORT = Number(process.env.VERIFY_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const NEAR = 10n ** 24n;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function yoctoToNear(value) {
  const raw = BigInt(value);
  return `${raw / NEAR}.${(raw % NEAR).toString().padStart(24, "0").replace(/0+$/, "") || "0"}`;
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function assertEqual(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

async function waitForHealth(timeoutMs, targetHeight) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    try {
      const health = await getJson("/health");
      last = health;
      if (Date.now() - lastLogAt > 10_000) {
        lastLogAt = Date.now();
        console.log(
          `[verify] indexed=${health.indexer.last_indexed_height} rpc=${health.indexer.last_rpc_height} events=${health.counts.events} prints=${health.counts.prints}`,
        );
      }
      // Receipts execute a few blocks after their transaction. Wait for the
      // block that contains the final demo receipt, not just a raw event count,
      // so the zero-reveal refund projection is present before assertions.
      if (
        health.counts.prints >= 2 &&
        health.counts.events >= 20 &&
        health.indexer.last_indexed_height >= targetHeight
      ) {
        return health;
      }
    } catch {
      /* server may not be listening yet */
    }
    await sleep(2_000);
  }
  throw new Error(`indexer did not reach expected state in time: ${JSON.stringify(last)}`);
}

async function main() {
  if (!existsSync(DEMO_PATH)) {
    throw new Error(`Missing ${DEMO_PATH}; run scripts/testnet-demo.mjs first.`);
  }
  const demo = JSON.parse(readFileSync(DEMO_PATH, "utf8"));
  const startBlock = demo.indexer_window?.start_block_hint;
  const latestBlock = demo.indexer_window?.latest_block;
  if (!Number.isInteger(startBlock)) throw new Error("demo JSON has no indexer start block hint");
  if (!Number.isInteger(latestBlock)) throw new Error("demo JSON has no indexer latest block");
  // Receipts can execute a few blocks after the originating transaction.
  const endBlock = latestBlock + 10;

  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  const env = {
    ...process.env,
    NEAR_RPC_URL: process.env.NEAR_RPC_URL || "https://near-testnet.drpc.org",
    TENDER_DB: DB_PATH,
    TENDER_CONTRACTS: demo.contract_id,
    TENDER_START_BLOCK: String(startBlock),
    TENDER_END_BLOCK: String(endBlock),
    TENDER_NETWORK: "testnet",
    TENDER_DEMO_MODE: "0",
    MAX_BLOCKS_PER_SYNC: "600",
    MAX_TXS_PER_BLOCK: "500",
    INDEXER_CONCURRENCY: "4",
    SYNC_INTERVAL_MS: "1500",
    HOST: "127.0.0.1",
    PORT: String(PORT),
  };

  const logStream = await import("node:fs").then(({ createWriteStream }) =>
    createWriteStream(LOG_PATH, { flags: "w" }),
  );
  const child = spawn(process.execPath, [join(ROOT, "packages/indexer/dist/src/index.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const cleanup = async () => {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  };

  try {
    const health = await waitForHealth(15 * 60_000, latestBlock + 10);
    console.log(
      `[verify] health ok blocks=${health.counts.blocks} events=${health.counts.events} jobs=${health.counts.jobs} prints=${health.counts.prints}`,
    );

    // ---- /tape ----
    const tape = await getJson("/tape?limit=10");
    assertEqual(tape.total, 2, "tape total");
    const auditId = String(demo.jobs.audit.job_id);
    const labelingId = String(demo.jobs.labeling.job_id);
    const codegenId = String(demo.jobs.codegen.job_id);
    const print0 = tape.items.find((item) => item.id === `${demo.contract_id}:${auditId}`);
    const print1 = tape.items.find((item) => item.id === `${demo.contract_id}:${labelingId}`);
    assert.ok(print0 && print1, "both settled prints present");

    assertEqual(print0.clearing_price.raw, "1100000000000000000000000", "job0 clearing");
    assertEqual(print0.clearing_price.near, "1.1", "job0 clearing NEAR");
    assertEqual(print0.winning_bid.raw, "900000000000000000000000", "job0 winning bid");
    assertEqual(print0.runner_up_bid.raw, "1100000000000000000000000", "job0 runner-up");
    assertEqual(print0.unit_price.raw, "366666666666666666666666", "job0 unit price");
    assertEqual(print0.savings_bps, 2666, "job0 buyer savings bps");
    assertEqual(print0.worker_premium_bps, 2222, "job0 Vickrey worker premium bps");
    assertEqual(print0.winner, demo.jobs.audit.winner, "job0 winner");
    assertEqual(print0.trigger, "buyer_accepted", "job0 settlement trigger");

    assertEqual(print1.clearing_price.raw, "550000000000000000000000", "job1 clearing");
    assertEqual(print1.clearing_price.near, "0.55", "job1 clearing NEAR");
    assertEqual(print1.savings_bps, 4500, "job1 buyer savings bps");
    assertEqual(print1.mechanism, "FirstPrice", "job1 mechanism");
    assertEqual(print1.trigger, "timeout_auto_settled", "job1 settlement trigger");

    // ---- /tape/median ----
    const median = await getJson("/tape/median");
    assertEqual(median.count, 2, "median count");
    assertEqual(median.median_unit_price, "320833333333333333333333", "median unit price");
    assertEqual(median.median_clearing_price, "825000000000000000000000", "median clearing price");
    assertEqual(median.volume_clearing, "1650000000000000000000000", "median volume");
    assertEqual(median.buyer_savings, "850000000000000000000000", "buyer savings");
    assertEqual(median.median_savings_bps, 3583, "median savings bps");

    // ---- /tape/spread ----
    const spread = await getJson("/tape/spread");
    assertEqual(spread.count, 2, "spread count");
    assertEqual(spread.min_unit_price, "275000000000000000000000", "spread min");
    assertEqual(spread.max_unit_price, "366666666666666666666666", "spread max");
    assertEqual(spread.spread, "91666666666666666666666", "spread width");

    // ---- /tape/win-rate ----
    const winRate = await getJson("/tape/win-rate?limit=10");
    assertEqual(winRate.count, 3, "win-rate worker count");
    const rates = new Map(winRate.items.map((row) => [row.worker, row]));
    assertEqual(rates.get(demo.jobs.audit.winner).win_rate_bps, 10_000, "audit winner win rate");
    assertEqual(rates.get(demo.jobs.labeling.winner).wins, 1, "labeling winner wins");
    assertEqual(rates.get(demo.jobs.labeling.winner).reveals, 2, "labeling winner reveals");
    assertEqual(rates.get(demo.jobs.labeling.winner).win_rate_bps, 5_000, "labeling winner win rate");

    // ---- /jobs detail ----
    const job0 = await getJson(`/jobs/${encodeURIComponent(`${demo.contract_id}:${auditId}`)}`);
    assertEqual(job0.job.status, "Settled", "job0 status");
    assertEqual(job0.job.commit_count, 3, "job0 commits");
    assertEqual(job0.job.reveal_count, 3, "job0 reveals");
    assert.equal(job0.events.length, 10, "job0 event count");
    assertEqual(job0.events[0].event, "job_created", "job0 first event");
    assert.equal(job0.events.at(-1).event, "job_settled", "job0 last event");
    assert.ok(job0.events.every((event) => event.receipt_id && event.tx_hash), "all events hashed");

    const refunded = await getJson(`/jobs/${encodeURIComponent(`${demo.contract_id}:${codegenId}`)}`);
    assertEqual(refunded.job.status, "CancelledZeroReveals", "zero-reveal status");
    assertEqual(refunded.print, null, "refunded job has no print");

    // ---- /receipts ----
    const receiptId = job0.events[0].receipt_id;
    const receipt = await getJson(`/receipts/${receiptId}`);
    assertEqual(receipt.items[0].event, "job_created", "receipt event");
    assert.equal(receipt.items[0].data.standard, undefined, "stored data is the event payload");

    // ---- facets ----
    const facets = await getJson("/facets");
    assert.deepEqual(facets.categories, ["data-labeling", "smart-contract-audit"], "categories");
    assert.deepEqual(facets.units, ["1k-rows", "kloc"], "units");

    // ---- explorer links ----
    assert.match(print0.explorer_url, /^https:\/\/testnet\.nearblocks\.io\//, "explorer link");
    assert.equal(print0.explorer_url.endsWith(print0.tx_hash), true, "explorer link uses tx hash");

    const deployFile = join(ROOT, "contracts/tender/target/near/tender.wasm");
    const wasmSha = existsSync(deployFile)
      ? await import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(readFileSync(deployFile)).digest("hex"),
        )
      : null;

    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const output = {
      network: "testnet",
      contract_id: demo.contract_id,
      deployed_at: "2026-11-14T01:20:36Z",
      deploy_transaction: "5gyAWNw27R3T1xwMsKkgRRy2STnCvW4sdtiQWJmLTv6M",
      wasm_sha256: wasmSha,
      rpc_url: env.NEAR_RPC_URL,
      demo_generated_at: demo.generated_at,
      indexer: {
        start_block: startBlock,
        last_indexed_block: health.indexer.last_indexed_height,
        blocks: health.counts.blocks,
        events: health.counts.events,
        jobs: health.counts.jobs,
        prints: health.counts.prints,
      },
      jobs: demo.jobs,
      tape: {
        total: tape.total,
        prints: tape.items.map((item) => ({
          id: item.id,
          category: item.category,
          mechanism: item.mechanism,
          winner: item.winner,
          clearing_price_near: item.clearing_price.near,
          winning_bid_near: item.winning_bid.near,
          runner_up_bid_near: item.runner_up_bid.near,
          unit_price_near: item.unit_price.near,
          unit_label: item.unit_label,
          savings_bps: item.savings_bps,
          worker_premium_bps: item.worker_premium_bps,
          trigger: item.trigger,
          tx_hash: item.tx_hash,
          explorer_url: item.explorer_url,
        })),
      },
      aggregate: {
        median: {
          count: median.count,
          median_unit_price_near: median.median_unit_price_near,
          median_clearing_price_near: median.median_clearing_price_near,
          volume_clearing_near: median.volume_clearing_near,
          buyer_savings_near: median.buyer_savings_near,
          median_savings_bps: median.median_savings_bps,
        },
        spread: {
          min_unit_price_near: spread.min_unit_price_near,
          max_unit_price_near: spread.max_unit_price_near,
          median_unit_price_near: spread.median_unit_price_near,
          spread_near: spread.spread_near,
          spread_bps: spread.spread_bps,
        },
        win_rate: winRate.items.map((row) => ({
          worker: row.worker,
          wins: row.wins,
          reveals: row.reveals,
          win_rate_bps: row.win_rate_bps,
          volume_won_near: row.volume_won_near,
        })),
      },
      api_endpoints: [
        "/tape",
        "/tape/median",
        "/tape/spread",
        "/tape/win-rate",
        "/jobs",
        "/jobs/:id",
        "/receipts/:id",
      ],
      verified_at: new Date().toISOString(),
    };
    writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`[verify] wrote ${OUT_PATH}`);
    console.log(`[verify] median unit price = ${median.median_unit_price_near} NEAR per unit`);
    console.log(`[verify] spread = ${spread.spread_near} NEAR (${spread.spread_bps} bps of median)`);
    console.log(`[verify] Vickrey premium = ${print0.worker_premium_bps} bps; buyer savings = ${print0.savings_bps} bps`);
    console.log("[verify] all indexer + API assertions passed against live testnet receipts");
  } catch (error) {
    const tail = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").split("\n").slice(-25).join("\n") : "";
    console.error("[verify] FAILED:", error);
    if (tail) console.error(`[verify] indexer log tail:\n${tail}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[verify] fatal:", error);
  process.exit(1);
});
