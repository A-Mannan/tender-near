import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  computeMedianStats,
  computeSpread,
  computeWinRates,
  formatNear,
  groupByCategory,
  type MedianStats,
  type SpreadStats,
} from "./aggregate.js";
import type { IndexerConfig } from "./config.js";
import type { TapeDb, PrintFilter } from "./db.js";
import type { Indexer, IndexerStatus } from "./poller.js";
import type { JobProjection, StoredEvent, TapePrint } from "./derive.js";
import { dataFromJson } from "./derive.js";

const STARTED_AT = Date.now();
const MAX_LIMIT = 200;

export interface ApiContext {
  config: IndexerConfig;
  db: TapeDb;
  indexer: Indexer;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: IndexerConfig): void {
  const origin = req.headers.origin;
  if (config.corsOrigins.includes("*")) {
    res.setHeader("access-control-allow-origin", "*");
  } else if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "86400");
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a non-negative integer`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return value;
}

function stringParam(url: URL, name: string, maxLength: number): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) throw new HttpError(400, `${name} must be <= ${maxLength} characters`);
  return trimmed;
}

function parseFilter(url: URL): PrintFilter {
  const category = stringParam(url, "category", 64);
  const unit = stringParam(url, "unit", 32);
  const contract = stringParam(url, "contract", 64);
  if (contract !== null && !/^[a-zA-Z0-9_.-]{2,64}$/.test(contract)) {
    throw new HttpError(400, "contract must be a valid NEAR account id");
  }
  const escrowRaw = stringParam(url, "escrow", 8);
  let escrow: "near" | "ft" | null = null;
  if (escrowRaw !== null) {
    if (escrowRaw !== "near" && escrowRaw !== "ft") {
      throw new HttpError(400, "escrow must be 'near' or 'ft'");
    }
    escrow = escrowRaw;
  }

  let sinceNs: string | null = null;
  const windowHours = url.searchParams.get("window_hours");
  if (windowHours !== null) {
    if (!/^\d+(\.\d+)?$/.test(windowHours)) throw new HttpError(400, "window_hours must be a positive number");
    const hours = Number(windowHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
      throw new HttpError(400, "window_hours must be within (0, 8760]");
    }
    sinceNs = (BigInt(Date.now() - Math.floor(hours * 3_600_000)) * 1_000_000n).toString();
  }

  return { category, unit, contract, escrow, sinceNs };
}

function isNearPrint(print: TapePrint): boolean {
  return print.escrow_token_id === null;
}

function priceView(raw: string | null, isNear: boolean): { raw: string | null; near: string | null } {
  return { raw, near: isNear && raw !== null ? formatNear(raw) : null };
}

function explorerUrl(config: IndexerConfig, print: TapePrint): string | null {
  if (config.network !== "testnet" && config.network !== "mainnet") return null;
  const host = config.network === "testnet" ? "testnet.nearblocks.io" : "nearblocks.io";
  if (print.tx_hash) return `https://${host}/txns/${print.tx_hash}`;
  return `https://${host}/blocks/${print.block_height}`;
}

function serializePrint(print: TapePrint, config: IndexerConfig): Record<string, unknown> {
  const near = isNearPrint(print);
  const escrow = near
    ? { kind: "near" as const }
    : { kind: "ft" as const, token_id: print.escrow_token_id };
  return {
    id: print.id,
    contract_id: print.contract_id,
    job_id: print.job_id,
    category: print.category,
    title: print.title,
    buyer: print.buyer,
    winner: print.winner,
    mechanism: print.mechanism,
    escrow,
    reserve_price: priceView(print.reserve_price, near),
    winning_bid: priceView(print.winning_bid, near),
    runner_up_bid: priceView(print.runner_up_bid, near),
    clearing_price: priceView(print.clearing_price, near),
    surplus_refunded: priceView(print.surplus_refunded, near),
    unit_price: priceView(print.unit_price, near),
    work_units: print.work_units,
    unit_label: print.unit_label,
    commit_count: print.commit_count,
    reveal_count: print.reveal_count,
    savings_bps: print.savings_bps,
    worker_premium_bps: print.worker_premium_bps,
    spec_sha256: print.spec_sha256,
    deliverable_sha256: print.deliverable_sha256,
    deliverable_uri: print.deliverable_uri,
    trigger: print.trigger,
    settled_at_ns: print.settled_at_ns,
    block_height: print.block_height,
    receipt_id: print.receipt_id,
    tx_hash: print.tx_hash,
    log_index: print.log_index,
    explorer_url: explorerUrl(config, print),
  };
}

function serializeStats(stats: MedianStats): Record<string, unknown> {
  return {
    count: stats.count,
    priced_count: stats.priced_count,
    units: stats.units,
    categories: stats.categories,
    median_unit_price: stats.median_unit_price,
    median_unit_price_near: stats.median_unit_price === null ? null : formatNear(stats.median_unit_price),
    median_clearing_price: stats.median_clearing_price,
    median_clearing_price_near:
      stats.median_clearing_price === null ? null : formatNear(stats.median_clearing_price),
    median_winning_bid: stats.median_winning_bid,
    median_winning_bid_near:
      stats.median_winning_bid === null ? null : formatNear(stats.median_winning_bid),
    min_unit_price: stats.min_unit_price,
    min_unit_price_near: stats.min_unit_price === null ? null : formatNear(stats.min_unit_price),
    max_unit_price: stats.max_unit_price,
    max_unit_price_near: stats.max_unit_price === null ? null : formatNear(stats.max_unit_price),
    volume_clearing: stats.volume_clearing,
    volume_clearing_near: formatNear(stats.volume_clearing),
    buyer_savings: stats.buyer_savings,
    buyer_savings_near: formatNear(stats.buyer_savings),
    median_savings_bps: stats.median_savings_bps,
    median_worker_premium_bps: stats.median_worker_premium_bps,
  };
}

function serializeSpread(spread: SpreadStats): Record<string, unknown> {
  return {
    count: spread.count,
    units: spread.units,
    min_unit_price: spread.min_unit_price,
    min_unit_price_near: spread.min_unit_price === null ? null : formatNear(spread.min_unit_price),
    max_unit_price: spread.max_unit_price,
    max_unit_price_near: spread.max_unit_price === null ? null : formatNear(spread.max_unit_price),
    p25_unit_price: spread.p25_unit_price,
    p25_unit_price_near: spread.p25_unit_price === null ? null : formatNear(spread.p25_unit_price),
    p75_unit_price: spread.p75_unit_price,
    p75_unit_price_near: spread.p75_unit_price === null ? null : formatNear(spread.p75_unit_price),
    median_unit_price: spread.median_unit_price,
    median_unit_price_near:
      spread.median_unit_price === null ? null : formatNear(spread.median_unit_price),
    spread: spread.spread,
    spread_near: spread.spread === null ? null : formatNear(spread.spread),
    spread_bps: spread.spread_bps,
  };
}

function serializeEvent(event: StoredEvent): Record<string, unknown> {
  return {
    contract_id: event.contractId,
    job_id: event.data["job_id"] ?? null,
    event: event.event,
    data: event.data,
    receipt_id: event.receiptId,
    tx_hash: event.txHash,
    block_height: event.blockHeight,
    block_timestamp_ns: event.blockTimestampNs,
    log_index: event.logIndex,
    data_index: event.dataIndex,
  };
}

function serializeJob(job: JobProjection, config: IndexerConfig): Record<string, unknown> {
  const near = job.escrow_token_id === null;
  const escrow = near ? { kind: "near" as const } : { kind: "ft" as const, token_id: job.escrow_token_id };
  return {
    id: job.id,
    contract_id: job.contract_id,
    job_id: job.job_id,
    buyer: job.buyer,
    title: job.title,
    category: job.category,
    spec_sha256: job.spec_sha256,
    spec_uri: job.spec_uri,
    work_units: job.work_units,
    unit_label: job.unit_label,
    escrow,
    mechanism: job.mechanism,
    reserve_price: priceView(job.reserve_price, near),
    min_worker_bond: priceView(job.min_worker_bond, near),
    max_commits: job.max_commits,
    arbiter: job.arbiter,
    commit_deadline_ns: job.commit_deadline_ns,
    reveal_deadline_ns: job.reveal_deadline_ns,
    delivery_duration_ns: job.delivery_duration_ns,
    dispute_window_ns: job.dispute_window_ns,
    delivery_deadline_ns: job.delivery_deadline_ns,
    created_at_ns: job.created_at_ns,
    status: job.status,
    winner: job.winner,
    winning_bid: priceView(job.winning_bid, near),
    runner_up_bid: priceView(job.runner_up_bid, near),
    clearing_price: priceView(job.clearing_price, near),
    unit_price: priceView(job.unit_price, near),
    deliverable_uri: job.deliverable_uri,
    deliverable_sha256: job.deliverable_sha256,
    dispute_reason_sha256: job.dispute_reason_sha256,
    settle_trigger: job.settle_trigger,
    settled_at_ns: job.settled_at_ns,
    surplus_refunded: priceView(job.surplus_refunded, near),
    commit_count: job.commit_count,
    reveal_count: job.reveal_count,
    last_event_block: job.last_event_block,
    last_event_timestamp_ns: job.last_event_timestamp_ns,
    network: config.network,
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<void> {
  const { db, indexer, config } = ctx;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && path === "/") {
    json(res, 200, {
      name: "Tender indexer",
      version: "1.0.0",
      endpoints: [
        "/health",
        "/config",
        "/facets",
        "/tape",
        "/tape/median",
        "/tape/spread",
        "/tape/win-rate",
        "/jobs",
        "/jobs/:id",
        "/events",
        "/receipts/:receiptId",
        "POST /sync",
      ],
    });
    return;
  }

  if (method === "GET" && path === "/health") {
    const counts = db.counts();
    const latest = db.latestBlock();
    const status: IndexerStatus = indexer.status();
    json(res, 200, {
      ok: status.last_error === null,
      network: config.network,
      rpc_url: config.rpcUrl,
      contracts: db.contractIds(),
      counts,
      latest_block: latest,
      indexer: status,
      uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
      server_time: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && path === "/config") {
    json(res, 200, {
      network: config.network,
      rpc_url: config.rpcUrl,
      contracts: db.contractIds(),
      configured_contracts: config.contractFilter,
      demo_mode: config.demoMode,
      start_block: config.startBlock,
      version: "1.0.0",
    });
    return;
  }

  if (method === "GET" && path === "/facets") {
    json(res, 200, {
      categories: db.distinctCategories(),
      units: db.distinctUnits(),
      contracts: db.contractIds(),
      escrows: ["near", "ft"],
    });
    return;
  }

  if (method === "GET" && path === "/tape") {
    const filter = parseFilter(url);
    const limit = intParam(url, "limit", 50, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, 1_000_000);
    const { items, total } = db.listPrints({ ...filter, limit, offset });
    json(res, 200, {
      network: config.network,
      count: items.length,
      total,
      limit,
      offset,
      filters: filter,
      items: items.map((print) => serializePrint(print, config)),
    });
    return;
  }

  if (method === "GET" && path === "/tape/median") {
    const filter = parseFilter(url);
    const prints = db.listPrintsForStats(filter);
    const stats = computeMedianStats(prints);
    const response: Record<string, unknown> = {
      network: config.network,
      filters: filter,
      ...serializeStats(stats),
    };
    if (url.searchParams.get("group_by") === "category") {
      response.by_category = groupByCategory(prints);
    }
    json(res, 200, response);
    return;
  }

  if (method === "GET" && path === "/tape/spread") {
    const filter = parseFilter(url);
    const prints = db.listPrintsForStats(filter);
    json(res, 200, {
      network: config.network,
      filters: filter,
      ...serializeSpread(computeSpread(prints)),
    });
    return;
  }

  if (method === "GET" && path === "/tape/win-rate") {
    const filter = parseFilter(url);
    const limit = intParam(url, "limit", 25, 1, MAX_LIMIT);
    const reveals = db.workerReveals(filter);
    const wins = db.workerWins(filter);
    const rows = computeWinRates(reveals, wins).slice(0, limit);
    json(res, 200, {
      network: config.network,
      filters: filter,
      count: rows.length,
      items: rows.map((row) => ({
        worker: row.worker,
        wins: row.wins,
        reveals: row.reveals,
        win_rate_bps: row.win_rate_bps,
        volume_won: row.volume_won,
        volume_won_near: formatNear(row.volume_won),
      })),
    });
    return;
  }

  if (method === "GET" && path === "/jobs") {
    const contract = stringParam(url, "contract", 64);
    const category = stringParam(url, "category", 64);
    const status = stringParam(url, "status", 32);
    const limit = intParam(url, "limit", 50, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, 1_000_000);
    const { items, total } = db.listJobs({ contract, category, status, limit, offset });
    json(res, 200, {
      network: config.network,
      count: items.length,
      total,
      limit,
      offset,
      items: items.map((job) => serializeJob(job, config)),
    });
    return;
  }

  if (method === "GET" && path.startsWith("/jobs/")) {
    const rawId = decodeURIComponent(path.slice("/jobs/".length));
    if (rawId.length === 0 || rawId.length > 160) throw new HttpError(400, "invalid job id");
    const job = db.getJobById(rawId);
    if (!job) {
      if (/^\d+$/.test(rawId)) {
        const matches = db.findJobIdByShortId(rawId);
        if (matches.length > 1) {
          throw new HttpError(409, `job id ${rawId} is ambiguous; use <contract>:<job_id>`);
        }
      }
      throw new HttpError(404, "job not found");
    }
    const events = db.jobEvents(job.contract_id, job.job_id);
    json(res, 200, {
      job: serializeJob(job, config),
      print: db.getPrint(job.id) ? serializePrint(db.getPrint(job.id) as TapePrint, config) : null,
      events: events.map(serializeEvent),
    });
    return;
  }

  if (method === "GET" && path === "/events") {
    const limit = intParam(url, "limit", 50, 1, 500);
    const contract = stringParam(url, "contract", 64);
    const events = db.recentEvents(limit, contract);
    json(res, 200, { count: events.length, items: events.map(serializeEvent) });
    return;
  }

  if (method === "GET" && path.startsWith("/receipts/")) {
    const receiptId = decodeURIComponent(path.slice("/receipts/".length));
    if (!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(receiptId)) {
      throw new HttpError(400, "invalid receipt id");
    }
    const rows = db.eventsForReceipt(receiptId);
    if (rows.length === 0) throw new HttpError(404, "receipt not found");
    json(res, 200, {
      receipt_id: receiptId,
      items: rows.map((row) => ({
        ...row,
        data: dataFromJson(row.data_json),
      })),
    });
    return;
  }

  if (method === "POST" && path === "/sync") {
    const summary = await indexer.syncOnce();
    json(res, 200, summary);
    return;
  }

  throw new HttpError(404, `no route for ${method} ${path}`);
}

export function createApiServer(ctx: ApiContext): Server {
  return createServer((req, res) => {
    applyCors(req, res, ctx.config);
    const url = new URL(req.url ?? "/", "http://localhost");
    route(req, res, url, ctx).catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[api] unhandled error:", error);
      json(res, 500, { error: "internal error", detail: message });
    });
  });
}