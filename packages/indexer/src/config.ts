import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface IndexerConfig {
  /** NEAR JSON-RPC endpoint (testnet, mainnet, localnet or near-sandbox). */
  rpcUrl: string;
  /** SQLite database file. */
  dbPath: string;
  /** HTTP API bind host. */
  host: string;
  /** HTTP API port. */
  port: number;
  /** First block to index when the database is empty. `null` = latest final block. */
  startBlock: number | null;
  /** Last block to index (inclusive). `null` = follow the chain head. */
  endBlock: number | null;
  /** Hard cap on blocks processed per sync cycle. */
  maxBlocksPerSync: number;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Allowed CORS origins; `["*"]` allows any (read-only public tape data). */
  corsOrigins: string[];
  /** Network label surfaced by `/config`. */
  network: string;
  /** When set, only receipts executed by one of these contracts are indexed. */
  contractFilter: string[];
  /** Enable demo/sandbox relay endpoints. Never enable on public deployments. */
  demoMode: boolean;
  /** Max transactions inspected per block (griefing / runaway guard). */
  maxTxsPerBlock: number;
  /** Blocks fetched and parsed concurrently. */
  concurrency: number;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function inferNetwork(rpcUrl: string): string {
  if (rpcUrl.includes("testnet")) return "testnet";
  if (rpcUrl.includes("mainnet")) return "mainnet";
  try {
    const { hostname } = new URL(rpcUrl);
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "0.0.0.0") {
      return "sandbox";
    }
  } catch {
    /* fall through */
  }
  return "custom";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const rpcUrl = env.NEAR_RPC_URL?.trim() || "https://near-testnet.drpc.org";
  const dbPath = resolve(env.TENDER_DB?.trim() || ".data/tender.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });

  const cors = (env.CORS_ORIGIN?.trim() || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    rpcUrl,
    dbPath,
    host: env.HOST?.trim() || "127.0.0.1",
    port: intEnv(env.PORT, 8787),
    startBlock: optionalInt(env.TENDER_START_BLOCK),
    endBlock: optionalInt(env.TENDER_END_BLOCK),
    maxBlocksPerSync: Math.max(1, intEnv(env.MAX_BLOCKS_PER_SYNC, 30)),
    intervalMs: Math.max(250, intEnv(env.SYNC_INTERVAL_MS, 1500)),
    corsOrigins: cors.length > 0 ? cors : ["*"],
    network: env.TENDER_NETWORK?.trim() || inferNetwork(rpcUrl),
    contractFilter: (env.TENDER_CONTRACTS?.trim() || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    demoMode: env.TENDER_DEMO_MODE === "1",
    maxTxsPerBlock: Math.max(1, intEnv(env.MAX_TXS_PER_BLOCK, 250)),
    concurrency: Math.max(1, Math.min(32, intEnv(env.INDEXER_CONCURRENCY, 8))),
  };
}