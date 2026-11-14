import { defineConfig, devices } from "@playwright/test";

const INDEXER_PORT = Number(process.env.TENDER_E2E_INDEXER_PORT ?? 8787);
const WEB_PORT = Number(process.env.TENDER_E2E_WEB_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
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
      command: `rm -f .data/e2e.sqlite .data/e2e.sqlite-shm .data/e2e.sqlite-wal && TENDER_DB=.data/e2e.sqlite HOST=127.0.0.1 PORT=${INDEXER_PORT} TENDER_START_BLOCK=$(node -e "const d=require('./.data/testnet-demo.json');process.stdout.write(String(d.indexer_window.start_block_hint))") TENDER_END_BLOCK= TENDER_NETWORK=testnet CORS_ORIGIN=* NEAR_RPC_URL=https://near-testnet.drpc.org INDEXER_CONCURRENCY=4 MAX_BLOCKS_PER_SYNC=100 SYNC_INTERVAL_MS=1200 node packages/indexer/dist/src/index.js`,
      url: `http://127.0.0.1:${INDEXER_PORT}/health`,
      cwd: "../..",
      timeout: 300_000,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
