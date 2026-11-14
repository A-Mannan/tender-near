import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEMO_PATH = resolve(ROOT, ".data/testnet-demo.json");
const CONTRACT_ID = process.env.TENDER_E2E_CONTRACT ?? "tender-hack-1114g.testnet";
const DEPLOY_PATH = resolve(ROOT, "deployments/testnet.json");
const REPLAY_PATH = resolve(ROOT, "deployments/testnet-replay.json");
const REPLAY_ENABLED = process.env.TENDER_E2E_LIFECYCLE !== "1" && existsSync(REPLAY_PATH);
const SEED_REPLAY = REPLAY_ENABLED ? "node scripts/replay-testnet-window.mjs && " : "";

/** Prefer the local demo window; fall back to the committed deployment proof. */
function indexerWindow(): { start: number | null; end: number | null } {
  if (existsSync(DEMO_PATH)) {
    const demo = JSON.parse(readFileSync(DEMO_PATH, "utf8")) as {
      indexer_window?: { start_block_hint?: number; latest_block?: number };
    };
    const start = demo.indexer_window?.start_block_hint;
    const latest = demo.indexer_window?.latest_block;
    if (Number.isInteger(start)) {
      // The opt-in lifecycle test creates a new job after the demo window. It
      // starts at the chain head so it does not spend minutes replaying demo
      // history it never asserts on.
      if (process.env.TENDER_E2E_LIFECYCLE === "1") {
        return { start: null, end: null };
      }
      // Bound the market replay to the demo window; following the live head
      // would add thousands of unrelated blocks and slow every test run.
      return {
        start: start as number,
        end: Number.isInteger(latest) ? (latest as number) + 10 : null,
      };
    }
  }
  if (existsSync(DEPLOY_PATH)) {
    const deploy = JSON.parse(readFileSync(DEPLOY_PATH, "utf8")) as {
      indexer?: { start_block?: number; last_indexed_block?: number };
    };
    const start = deploy.indexer?.start_block;
    const last = deploy.indexer?.last_indexed_block;
    if (Number.isInteger(start) && Number.isInteger(last)) {
      // The clean clone has no demo JSON. Recover the committed proof window,
      // but cap work at its last transaction block to avoid empty live-head scans.
      return { start: start as number, end: last as number };
    }
  }
  throw new Error("No indexer window found; run scripts/testnet-demo.mjs or provide deployments/testnet.json");
}

const WINDOW = indexerWindow();
const INDEXER_PORT = Number(process.env.TENDER_E2E_INDEXER_PORT ?? 8787);
const WEB_PORT = Number(process.env.TENDER_E2E_WEB_PORT ?? 4174);
if (!Number.isInteger(INDEXER_PORT) || INDEXER_PORT < 1 || INDEXER_PORT > 65535) {
  throw new Error("TENDER_E2E_INDEXER_PORT must be an integer from 1 to 65535");
}
if (!Number.isInteger(WEB_PORT) || WEB_PORT < 1 || WEB_PORT > 65535) {
  throw new Error("TENDER_E2E_WEB_PORT must be an integer from 1 to 65535");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, isMobile: false, hasTouch: true },
    },
  ],
  webServer: [
    {
      command: `rm -f .data/e2e.sqlite .data/e2e.sqlite-shm .data/e2e.sqlite-wal && ${SEED_REPLAY}TENDER_DB=.data/e2e.sqlite HOST=127.0.0.1 PORT=${INDEXER_PORT} TENDER_START_BLOCK=${WINDOW.start ?? ""} TENDER_END_BLOCK=${WINDOW.end ?? ""} TENDER_NETWORK=testnet TENDER_CONTRACTS=${CONTRACT_ID} CORS_ORIGIN=* NEAR_RPC_URL=https://near-testnet.drpc.org INDEXER_CONCURRENCY=8 MAX_BLOCKS_PER_SYNC=200 SYNC_INTERVAL_MS=1200 node packages/indexer/dist/src/index.js`,
      url: `http://127.0.0.1:${INDEXER_PORT}/health`,
      cwd: "../..",
      timeout: 300_000,
      reuseExistingServer: false,
    },
    {
      command: `TENDER_API_PROXY=http://127.0.0.1:${INDEXER_PORT} npx vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
