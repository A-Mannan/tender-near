import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  dataFromJson,
  projectJob,
  projectPrint,
  type JobProjection,
  type StoredEvent,
  type TapePrint,
} from "./derive.js";
import { fieldString } from "./events.js";

export interface BlockMeta {
  height: number;
  hash: string;
  timestampNs: string;
}

export interface ApplyResult {
  insertedEvents: number;
  rebuiltJobs: number;
  prints: number;
}

export interface PrintFilter {
  contract?: string | null;
  category?: string | null;
  unit?: string | null;
  escrow?: "near" | "ft" | null;
  sinceNs?: string | null;
  limit?: number;
  offset?: number;
}

export interface JobFilter {
  contract?: string | null;
  category?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}

export interface WorkerRevealRow {
  worker: string;
  reveals: number;
}

export interface WorkerWinRow {
  winner: string;
  wins: number;
  volume_won: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  timestamp_ns TEXT NOT NULL,
  events_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  contract_id TEXT NOT NULL,
  job_id TEXT,
  actor TEXT,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  data_index INTEGER NOT NULL,
  tx_hash TEXT,
  block_height INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp_ns TEXT NOT NULL,
  event TEXT NOT NULL,
  data_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, log_index, data_index)
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events (contract_id, job_id, block_height);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event, block_height);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events (actor);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  buyer TEXT,
  title TEXT,
  category TEXT,
  spec_sha256 TEXT,
  spec_uri TEXT,
  work_units TEXT,
  unit_label TEXT,
  escrow_token TEXT NOT NULL,
  escrow_token_id TEXT,
  mechanism TEXT,
  reserve_price TEXT,
  min_worker_bond TEXT,
  max_commits INTEGER,
  arbiter TEXT,
  commit_deadline_ns TEXT,
  reveal_deadline_ns TEXT,
  delivery_duration_ns TEXT,
  dispute_window_ns TEXT,
  delivery_deadline_ns TEXT,
  created_at_ns TEXT,
  status TEXT NOT NULL,
  winner TEXT,
  winning_bid TEXT,
  runner_up_bid TEXT,
  clearing_price TEXT,
  unit_price TEXT,
  deliverable_uri TEXT,
  deliverable_sha256 TEXT,
  dispute_reason_sha256 TEXT,
  settle_trigger TEXT,
  settled_at_ns TEXT,
  surplus_refunded TEXT,
  commit_count INTEGER NOT NULL,
  reveal_count INTEGER NOT NULL,
  last_event_block INTEGER NOT NULL,
  last_event_timestamp_ns TEXT NOT NULL,
  UNIQUE (contract_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at_ns DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs (category, created_at_ns DESC);

CREATE TABLE IF NOT EXISTS prints (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  category TEXT,
  title TEXT,
  buyer TEXT,
  winner TEXT,
  mechanism TEXT,
  escrow_token TEXT NOT NULL,
  escrow_token_id TEXT,
  escrow_kind TEXT NOT NULL,
  reserve_price TEXT NOT NULL,
  winning_bid TEXT NOT NULL,
  runner_up_bid TEXT,
  clearing_price TEXT NOT NULL,
  surplus_refunded TEXT,
  unit_price TEXT,
  work_units TEXT,
  unit_label TEXT,
  commit_count INTEGER NOT NULL,
  reveal_count INTEGER NOT NULL,
  spec_sha256 TEXT,
  deliverable_sha256 TEXT,
  deliverable_uri TEXT,
  trigger TEXT,
  settled_at_ns TEXT NOT NULL,
  block_height INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  tx_hash TEXT,
  log_index INTEGER NOT NULL,
  savings_bps INTEGER NOT NULL,
  worker_premium_bps INTEGER NOT NULL,
  UNIQUE (contract_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_prints_settled ON prints (settled_at_ns DESC);
CREATE INDEX IF NOT EXISTS idx_prints_category ON prints (category, settled_at_ns DESC);
CREATE INDEX IF NOT EXISTS idx_prints_winner ON prints (winner);
CREATE INDEX IF NOT EXISTS idx_prints_unit ON prints (unit_label);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const JOB_COLUMNS: Array<keyof JobProjection> = [
  "id", "contract_id", "job_id", "buyer", "title", "category", "spec_sha256", "spec_uri",
  "work_units", "unit_label", "escrow_token", "escrow_token_id", "mechanism", "reserve_price",
  "min_worker_bond", "max_commits", "arbiter", "commit_deadline_ns", "reveal_deadline_ns",
  "delivery_duration_ns", "dispute_window_ns", "delivery_deadline_ns", "created_at_ns", "status",
  "winner", "winning_bid", "runner_up_bid", "clearing_price", "unit_price", "deliverable_uri",
  "deliverable_sha256", "dispute_reason_sha256", "settle_trigger", "settled_at_ns",
  "surplus_refunded", "commit_count", "reveal_count", "last_event_block", "last_event_timestamp_ns",
];

const PRINT_COLUMNS: Array<keyof TapePrint | "escrow_kind"> = [
  "id", "contract_id", "job_id", "category", "title", "buyer", "winner", "mechanism",
  "escrow_token", "escrow_token_id", "escrow_kind", "reserve_price", "winning_bid", "runner_up_bid",
  "clearing_price", "surplus_refunded", "unit_price", "work_units", "unit_label", "commit_count",
  "reveal_count", "spec_sha256", "deliverable_sha256", "deliverable_uri", "trigger", "settled_at_ns",
  "block_height", "receipt_id", "tx_hash", "log_index", "savings_bps", "worker_premium_bps",
];

function jobValues(job: JobProjection): Array<string | number | null> {
  return JOB_COLUMNS.map((column) => job[column] as string | number | null);
}

function printValues(print: TapePrint): Array<string | number | null> {
  const escrowKind = print.escrow_token_id === null ? "near" : "ft";
  return PRINT_COLUMNS.map((column) => {
    if (column === "escrow_kind") return escrowKind;
    return print[column as keyof TapePrint] as string | number | null;
  });
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export class TapeDb {
  readonly db: DatabaseSync;
  private readonly upsertJobStmt: StatementSync;
  private readonly upsertPrintStmt: StatementSync;
  private readonly insertEventStmt: StatementSync;
  private readonly markBlockStmt: StatementSync;
  private readonly blockExistsStmt: StatementSync;
  private readonly eventsForJobStmt: StatementSync;
  private readonly deletePrintStmt: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);

    const jobUpdate = JOB_COLUMNS.filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    this.upsertJobStmt = this.db.prepare(
      `INSERT INTO jobs (${JOB_COLUMNS.join(", ")}) VALUES (${placeholders(JOB_COLUMNS.length)})
       ON CONFLICT(id) DO UPDATE SET ${jobUpdate}`,
    );

    const printUpdate = PRINT_COLUMNS.filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    this.upsertPrintStmt = this.db.prepare(
      `INSERT INTO prints (${PRINT_COLUMNS.join(", ")}) VALUES (${placeholders(PRINT_COLUMNS.length)})
       ON CONFLICT(id) DO UPDATE SET ${printUpdate}`,
    );

    this.insertEventStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events
       (contract_id, job_id, actor, receipt_id, log_index, data_index, tx_hash, block_height, block_hash,
        block_timestamp_ns, event, data_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.markBlockStmt = this.db.prepare(
      `INSERT INTO blocks (height, hash, timestamp_ns, events_count, indexed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(height) DO UPDATE SET hash = excluded.hash, timestamp_ns = excluded.timestamp_ns,
         events_count = excluded.events_count, indexed_at = excluded.indexed_at`,
    );

    this.blockExistsStmt = this.db.prepare("SELECT 1 AS present FROM blocks WHERE height = ?");
    this.eventsForJobStmt = this.db.prepare(
      `SELECT contract_id, receipt_id, log_index, data_index, tx_hash, block_height, block_timestamp_ns,
              event, data_json
       FROM events WHERE contract_id = ? AND job_id = ? ORDER BY block_height ASC, log_index ASC`,
    );
    this.deletePrintStmt = this.db.prepare("DELETE FROM prints WHERE id = ?");
  }

  close(): void {
    this.db.close();
  }

  hasBlock(height: number): boolean {
    return this.blockExistsStmt.get(height) !== undefined;
  }

  lastProcessedHeight(): number | null {
    const row = this.db
      .prepare("SELECT MAX(height) AS height FROM blocks")
      .get() as { height: number | bigint | null } | undefined;
    if (!row || row.height === null) return null;
    return Number(row.height);
  }

  blockCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM blocks").get() as
      | { count: number | bigint }
      | undefined;
    return row ? Number(row.count) : 0;
  }

  counts(): { events: number; jobs: number; prints: number; blocks: number } {
    const row = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(*) FROM jobs) AS jobs,
                (SELECT COUNT(*) FROM prints) AS prints,
                (SELECT COUNT(*) FROM blocks) AS blocks`,
      )
      .get() as { events: number | bigint; jobs: number | bigint; prints: number | bigint; blocks: number | bigint };
    return {
      events: Number(row.events),
      jobs: Number(row.jobs),
      prints: Number(row.prints),
      blocks: Number(row.blocks),
    };
  }

  latestBlock(): { height: number; hash: string; timestamp_ns: string } | null {
    const row = this.db
      .prepare("SELECT height, hash, timestamp_ns FROM blocks ORDER BY height DESC LIMIT 1")
      .get() as { height: number | bigint; hash: string; timestamp_ns: string } | undefined;
    if (!row) return null;
    return { height: Number(row.height), hash: row.hash, timestamp_ns: row.timestamp_ns };
  }

  contractIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT contract_id FROM events ORDER BY contract_id ASC")
      .all() as Array<{ contract_id: string }>;
    return rows.map((row) => row.contract_id);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Atomically persist a block's events and rebuild affected job/print projections. */
  applyBlock(block: BlockMeta, events: readonly StoredEvent[]): ApplyResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const recordedAt = new Date().toISOString();
      const jobIds = new Set<string>();
      let insertedEvents = 0;
      for (const event of events) {
        const jobKey = event.data["job_id"];
        const jobId = jobKey === undefined ? null : fieldString(event.data, "job_id");
        const actor = fieldString(event.data, "worker") ?? fieldString(event.data, "winner");
        const result = this.insertEventStmt.run(
          event.contractId,
          jobId,
          actor,
          event.receiptId,
          event.logIndex,
          event.dataIndex,
          event.txHash,
          event.blockHeight,
          block.hash,
          event.blockTimestampNs,
          event.event,
          JSON.stringify(event.data),
          recordedAt,
        );
        insertedEvents += Number(result.changes);
        if (jobId !== null) jobIds.add(`${event.contractId}\u0000${jobId}`);
      }

      let prints = 0;
      for (const composite of jobIds) {
        const [contractId, jobId] = composite.split("\u0000");
        if (!contractId || !jobId) continue;
        const projection = this.rebuildJob(contractId, jobId);
        if (projection) prints += 1;
      }

      this.markBlockStmt.run(
        block.height,
        block.hash,
        block.timestampNs,
        events.length,
        recordedAt,
      );
      this.db.exec("COMMIT");
      return { insertedEvents, rebuiltJobs: jobIds.size, prints };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuildJob(contractId: string, jobId: string): JobProjection | null {
    const rows = this.eventsForJobStmt.all(contractId, jobId) as Array<{
      contract_id: string;
      receipt_id: string;
      log_index: number | bigint;
      data_index: number | bigint;
      tx_hash: string | null;
      block_height: number | bigint;
      block_timestamp_ns: string;
      event: string;
      data_json: string;
    }>;
    const events: StoredEvent[] = rows.map((row) => ({
      contractId: row.contract_id,
      receiptId: row.receipt_id,
      logIndex: Number(row.log_index),
      dataIndex: Number(row.data_index),
      txHash: row.tx_hash,
      blockHeight: Number(row.block_height),
      blockTimestampNs: row.block_timestamp_ns,
      event: row.event,
      data: dataFromJson(row.data_json),
    }));
    const projection = projectJob(events);
    if (!projection) return null;

    this.upsertJobStmt.run(...jobValues(projection));
    const print = projectPrint(projection, events);
    if (print) {
      this.upsertPrintStmt.run(...printValues(print));
    } else {
      this.deletePrintStmt.run(projection.id);
    }
    return projection;
  }

  rebuildAll(): number {
    const rows = this.db
      .prepare("SELECT DISTINCT contract_id, job_id FROM events WHERE job_id IS NOT NULL")
      .all() as Array<{ contract_id: string; job_id: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) this.rebuildJob(row.contract_id, row.job_id);
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private printWhere(filter: PrintFilter): { sql: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.contract) {
      clauses.push("contract_id = ?");
      params.push(filter.contract);
    }
    if (filter.category) {
      clauses.push("category = ?");
      params.push(filter.category);
    }
    if (filter.unit) {
      clauses.push("unit_label = ?");
      params.push(filter.unit);
    }
    if (filter.escrow) {
      clauses.push("escrow_kind = ?");
      params.push(filter.escrow);
    }
    if (filter.sinceNs) {
      clauses.push("CAST(settled_at_ns AS INTEGER) >= ?");
      params.push(filter.sinceNs);
    }
    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listPrints(filter: PrintFilter = {}): { items: TapePrint[]; total: number } {
    const where = this.printWhere(filter);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM prints ${where.sql}`)
      .get(...where.params) as { count: number | bigint };
    const rows = this.db
      .prepare(
        `SELECT * FROM prints ${where.sql}
         ORDER BY CAST(settled_at_ns AS INTEGER) DESC, block_height DESC, log_index DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset) as unknown as TapePrint[];
    return { items: rows.map(normalizePrintRow), total: Number(totalRow.count) };
  }

  listPrintsForStats(filter: PrintFilter = {}): TapePrint[] {
    const where = this.printWhere(filter);
    const limit = Math.min(Math.max(filter.limit ?? 5_000, 1), 20_000);
    const rows = this.db
      .prepare(
        `SELECT * FROM prints ${where.sql}
         ORDER BY CAST(settled_at_ns AS INTEGER) ASC, block_height ASC, log_index ASC LIMIT ?`,
      )
      .all(...where.params, limit) as unknown as TapePrint[];
    return rows.map(normalizePrintRow);
  }

  getPrint(id: string): TapePrint | null {
    const row = this.db.prepare("SELECT * FROM prints WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? normalizePrintRow(row as TapePrint) : null;
  }

  listJobs(filter: JobFilter = {}): { items: JobProjection[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.contract) {
      clauses.push("contract_id = ?");
      params.push(filter.contract);
    }
    if (filter.category) {
      clauses.push("category = ?");
      params.push(filter.category);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs ${where}`)
      .get(...params) as { count: number | bigint };
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs ${where}
         ORDER BY CAST(COALESCE(created_at_ns, '0') AS INTEGER) DESC, job_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as JobProjection[];
    return { items: rows.map(normalizeJobRow), total: Number(totalRow.count) };
  }

  getJobById(id: string): JobProjection | null {
    const normalized = id.trim();
    let row: unknown;
    if (normalized.includes(":")) {
      row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(normalized);
    } else if (/^\d+$/.test(normalized)) {
      const matches = this.db
        .prepare("SELECT * FROM jobs WHERE job_id = ? ORDER BY contract_id ASC")
        .all(normalized) as unknown[];
      if (matches.length === 1) row = matches[0];
    }
    return row ? normalizeJobRow(row as JobProjection) : null;
  }

  findJobIdByShortId(jobId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM jobs WHERE job_id = ? ORDER BY contract_id ASC")
      .all(jobId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  jobEvents(contractId: string, jobId: string): StoredEvent[] {
    return this.eventsForJobStmt.all(contractId, jobId).map((raw) => {
      const row = raw as {
        contract_id: string;
        receipt_id: string;
        log_index: number | bigint;
        data_index: number | bigint;
        tx_hash: string | null;
        block_height: number | bigint;
        block_timestamp_ns: string;
        event: string;
        data_json: string;
      };
      return {
        contractId: row.contract_id,
        receiptId: row.receipt_id,
        logIndex: Number(row.log_index),
        dataIndex: Number(row.data_index),
        txHash: row.tx_hash,
        blockHeight: Number(row.block_height),
        blockTimestampNs: row.block_timestamp_ns,
        event: row.event,
        data: dataFromJson(row.data_json),
      };
    });
  }

  eventsForReceipt(receiptId: string): Array<{
    receipt_id: string;
    log_index: number;
    data_index: number;
    contract_id: string;
    tx_hash: string | null;
    block_height: number;
    event: string;
    data_json: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT receipt_id, log_index, data_index, contract_id, tx_hash, block_height, event, data_json
         FROM events WHERE receipt_id = ? ORDER BY log_index ASC, data_index ASC`,
      )
      .all(receiptId) as Array<{
      receipt_id: string;
      log_index: number | bigint;
      data_index: number | bigint;
      contract_id: string;
      tx_hash: string | null;
      block_height: number | bigint;
      event: string;
      data_json: string;
    }>;
    return rows.map((row) => ({
      ...row,
      log_index: Number(row.log_index),
      data_index: Number(row.data_index),
      block_height: Number(row.block_height),
    }));
  }

  recentEvents(limit: number, contract?: string | null): StoredEvent[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    const rows = (
      contract
        ? this.db
            .prepare(
              `SELECT contract_id, receipt_id, log_index, data_index, tx_hash, block_height, block_timestamp_ns,
                      event, data_json
               FROM events WHERE contract_id = ?
               ORDER BY block_height DESC, log_index DESC LIMIT ?`,
            )
            .all(contract, capped)
        : this.db
            .prepare(
              `SELECT contract_id, receipt_id, log_index, data_index, tx_hash, block_height, block_timestamp_ns,
                      event, data_json
               FROM events ORDER BY block_height DESC, log_index DESC LIMIT ?`,
            )
            .all(capped)
    ) as Array<{
      contract_id: string;
      receipt_id: string;
      log_index: number | bigint;
      data_index: number | bigint;
      tx_hash: string | null;
      block_height: number | bigint;
      block_timestamp_ns: string;
      event: string;
      data_json: string;
    }>;
    return rows.map((row) => ({
      contractId: row.contract_id,
      receiptId: row.receipt_id,
      logIndex: Number(row.log_index),
      dataIndex: Number(row.data_index),
      txHash: row.tx_hash,
      blockHeight: Number(row.block_height),
      blockTimestampNs: row.block_timestamp_ns,
      event: row.event,
      data: dataFromJson(row.data_json),
    }));
  }

  workerReveals(filter: PrintFilter = {}): WorkerRevealRow[] {
    const clauses = ["e.event = 'bid_revealed'", "e.actor IS NOT NULL"];
    const params: Array<string | number> = [];

    if (filter.contract) {
      clauses.push("e.contract_id = ?");
      params.push(filter.contract);
    }
    if (filter.category) {
      clauses.push("j.category = ?");
      params.push(filter.category);
    }
    if (filter.unit) {
      clauses.push("j.unit_label = ?");
      params.push(filter.unit);
    }
    if (filter.escrow === "near") clauses.push("j.escrow_token_id IS NULL");
    if (filter.escrow === "ft") clauses.push("j.escrow_token_id IS NOT NULL");
    if (filter.sinceNs) {
      clauses.push("CAST(e.block_timestamp_ns AS INTEGER) >= ?");
      params.push(filter.sinceNs);
    }
    const rows = this.db
      .prepare(
        `SELECT e.actor AS worker, COUNT(*) AS reveals FROM events e
         JOIN jobs j ON j.contract_id = e.contract_id AND j.job_id = e.job_id
         WHERE ${clauses.join(" AND ")} GROUP BY e.actor ORDER BY reveals DESC`,
      )
      .all(...params) as Array<{ worker: string; reveals: number | bigint }>;
    return rows.map((row) => ({ worker: row.worker, reveals: Number(row.reveals) }));
  }

  workerWins(filter: PrintFilter = {}): WorkerWinRow[] {
    const clauses = ["winner IS NOT NULL"];
    const params: Array<string | number> = [];
    if (filter.contract) {
      clauses.push("contract_id = ?");
      params.push(filter.contract);
    }
    if (filter.category) {
      clauses.push("category = ?");
      params.push(filter.category);
    }
    if (filter.unit) {
      clauses.push("unit_label = ?");
      params.push(filter.unit);
    }
    if (filter.escrow) {
      clauses.push("escrow_kind = ?");
      params.push(filter.escrow);
    }
    if (filter.sinceNs) {
      clauses.push("CAST(settled_at_ns AS INTEGER) >= ?");
      params.push(filter.sinceNs);
    }
    // yoctoNEAR prices exceed SQLite's signed 64-bit SUM range: aggregate in BigInt.
    const rows = this.db
      .prepare(
        `SELECT winner, clearing_price FROM prints WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params) as Array<{ winner: string; clearing_price: string }>;
    const totals = new Map<string, { wins: number; volume: bigint }>();
    for (const row of rows) {
      const current = totals.get(row.winner) ?? { wins: 0, volume: 0n };
      current.wins += 1;
      current.volume += BigInt(row.clearing_price);
      totals.set(row.winner, current);
    }
    return [...totals.entries()]
      .map(([winner, value]) => ({
        winner,
        wins: value.wins,
        volume_won: value.volume.toString(),
      }))
      .sort((a, b) => b.wins - a.wins || a.winner.localeCompare(b.winner));
  }

  distinctCategories(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT category FROM prints WHERE category IS NOT NULL ORDER BY category ASC`,
      )
      .all() as Array<{ category: string }>;
    return rows.map((row) => row.category);
  }

  distinctUnits(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT unit_label FROM prints WHERE unit_label IS NOT NULL ORDER BY unit_label ASC`,
      )
      .all() as Array<{ unit_label: string }>;
    return rows.map((row) => row.unit_label);
  }
}

function normalizePrintRow(row: TapePrint): TapePrint {
  return {
    ...row,
    commit_count: Number(row.commit_count),
    reveal_count: Number(row.reveal_count),
    block_height: Number(row.block_height),
    log_index: Number(row.log_index),
    savings_bps: Number(row.savings_bps),
    worker_premium_bps: Number(row.worker_premium_bps),
  };
}

function normalizeJobRow(row: JobProjection): JobProjection {
  return {
    ...row,
    max_commits: row.max_commits === null ? null : Number(row.max_commits),
    commit_count: Number(row.commit_count),
    reveal_count: Number(row.reveal_count),
    last_event_block: Number(row.last_event_block),
  };
}