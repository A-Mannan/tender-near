import type { IndexerConfig } from "./config.js";
import type { BlockMeta, TapeDb } from "./db.js";
import { parseTenderLog } from "./events.js";
import type { StoredEvent } from "./derive.js";
import { NearRpc, type FinalExecutionOutcomeView, type TransactionView } from "./rpc.js";

export const TENDER_METHODS = new Set([
  "new",
  "create_job",
  "ft_on_transfer",
  "commit_bid",
  "reveal_bid",
  "finalize_auction",
  "submit_delivery",
  "set_payout_account",
  "accept_delivery",
  "finalize_after_timeout",
  "claim_delivery_timeout",
  "dispute_delivery",
  "resolve_dispute",
  "deposit_bond",
  "withdraw_bond",
  "register_ft_job_storage",
  "withdraw_claimable",
  "on_settlement_complete",
  "on_refund_complete",
  "on_surplus_refund_complete",
  "on_bond_withdraw_complete",
  "on_claimable_withdraw_complete",
]);

export interface SyncSummary {
  from: number | null;
  to: number | null;
  blocks: number;
  events: number;
  prints: number;
  skipped: number;
  warnings: string[];
}

export interface IndexerStatus {
  running: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  last_rpc_height: number | null;
  last_indexed_height: number | null;
  syncs: number;
  total_events: number;
  total_blocks: number;
}

function hasFunctionCall(tx: TransactionView): boolean {
  return tx.actions.some((action) => action.FunctionCall !== undefined);
}

function isTenderMethod(tx: TransactionView): boolean {
  return tx.actions.some(
    (action) => action.FunctionCall !== undefined && TENDER_METHODS.has(action.FunctionCall.method_name),
  );
}

function isFungibleTokenPush(tx: TransactionView): boolean {
  return tx.actions.some(
    (action) =>
      action.FunctionCall !== undefined &&
      (action.FunctionCall.method_name === "ft_transfer_call" ||
        action.FunctionCall.method_name === "ft_transfer"),
  );
}

function isSuccess(outcome: FinalExecutionOutcomeView["receipts_outcome"][number]): boolean {
  const status = outcome.outcome.status;
  return typeof status === "object" && status !== null && "SuccessValue" in status;
}

/** Extracts Tender NEP-297 events from one transaction's receipt tree. */
export function eventsFromTxOutcome(
  txHash: string,
  outcome: FinalExecutionOutcomeView,
  block: BlockMeta,
  contractFilter: readonly string[] = [],
): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const receiptOutcome of outcome.receipts_outcome) {
    if (!isSuccess(receiptOutcome)) continue;
    const executor = receiptOutcome.outcome.executor_id;
    if (contractFilter.length > 0 && !contractFilter.includes(executor)) continue;
    const logs = receiptOutcome.outcome.logs;
    for (let logIndex = 0; logIndex < logs.length; logIndex += 1) {
      const log = logs[logIndex];
      if (log === undefined) continue;
      const parsed = parseTenderLog(log);
      if (!parsed) continue;
      for (let dataIndex = 0; dataIndex < parsed.data.length; dataIndex += 1) {
        const data = parsed.data[dataIndex];
        if (!data) continue;
        events.push({
          contractId: executor,
          receiptId: receiptOutcome.id,
          logIndex,
          dataIndex,
          txHash,
          blockHeight: block.height,
          blockTimestampNs: block.timestampNs,
          event: parsed.event,
          data,
        });
      }
    }
  }
  return events;
}

export class Indexer {
  private readonly rpc: NearRpc;
  private readonly db: TapeDb;
  private readonly config: IndexerConfig;
  private readonly log: (line: string) => void;
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastRpcHeight: number | null = null;
  private syncs = 0;
  private totalEvents = 0;
  private totalBlocks = 0;

  constructor(options: {
    rpc: NearRpc;
    db: TapeDb;
    config: IndexerConfig;
    logger?: (line: string) => void;
  }) {
    this.rpc = options.rpc;
    this.db = options.db;
    this.config = options.config;
    this.log = options.logger ?? ((line) => console.log(line));
  }

  status(): IndexerStatus {
    return {
      running: this.running,
      last_sync_at: this.lastSyncAt,
      last_error: this.lastError,
      last_rpc_height: this.lastRpcHeight,
      last_indexed_height: this.db.lastProcessedHeight(),
      syncs: this.syncs,
      total_events: this.totalEvents,
      total_blocks: this.totalBlocks,
    };
  }

  /** Process one bounded batch of finalized blocks. */
  async syncOnce(): Promise<SyncSummary> {
    const latest = await this.rpc.getLatestBlock();
    this.lastRpcHeight = latest.header.height;
    const lastIndexed = this.db.lastProcessedHeight();
    const from = lastIndexed === null ? (this.config.startBlock ?? latest.header.height) : lastIndexed + 1;
    const target = Math.min(latest.header.height, this.config.endBlock ?? latest.header.height);
    const warnings: string[] = [];

    if (from > target) {
      this.lastSyncAt = new Date().toISOString();
      return { from: null, to: null, blocks: 0, events: 0, prints: 0, skipped: 0, warnings };
    }

    const to = Math.min(target, from + this.config.maxBlocksPerSync - 1);
    const heights: number[] = [];
    let skipped = 0;
    for (let height = from; height <= to; height += 1) {
      if (this.db.hasBlock(height)) skipped += 1;
      else heights.push(height);
    }

    let blocks = 0;
    let events = 0;
    let prints = 0;

    try {
      const results = await mapLimit(heights, this.config.concurrency, async (height) => {
        const result = await this.ingestBlock(height, warnings);
        return { height, result };
      });
      for (const entry of results) {
        blocks += 1;
        events += entry.result.events;
        prints += entry.result.prints;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      throw new Error(message);
    }

    this.syncs += 1;
    this.totalBlocks += blocks;
    this.totalEvents += events;
    this.lastSyncAt = new Date().toISOString();
    this.lastError = null;
    if (blocks > 0) {
      this.log(
        `[indexer] blocks ${from}..${to} (+${blocks}) events=${events} prints=${prints} rpc=${latest.header.height}`,
      );
    }
    return { from, to, blocks, events, prints, skipped, warnings };
  }

  private async ingestBlock(
    height: number,
    warnings: string[],
  ): Promise<{ events: number; prints: number }> {
    try {
      const block = await this.rpc.getBlockByHeight(height);
      if (block.header.height !== height) {
        throw new Error(`requested block ${height} but RPC returned ${block.header.height}`);
      }

      // Skip empty chunks (8 bytes on the wire) and chunks whose transaction
      // root is the zero hash. The indexer is transaction-centric: a chunk with
      // no transactions cannot originate a Tender event, and delayed receipts
      // are already included in their originating transaction's outcome tree.
      const EMPTY_TX_ROOT = "11111111111111111111111111111111";
      const chunkRefs = block.chunks.filter(
        (chunkRef) =>
          (typeof chunkRef.encoded_length !== "number" || chunkRef.encoded_length > 8) &&
          chunkRef.tx_root !== EMPTY_TX_ROOT,
      );
      const chunks = await mapLimit(chunkRefs, 4, (chunkRef) => this.rpc.getChunk(chunkRef.chunk_hash));

      const candidates: Array<{ hash: string; signerId: string }> = [];
      for (const chunk of chunks) {
        for (const tx of chunk.transactions) {
          if (candidates.length >= this.config.maxTxsPerBlock) {
            warnings.push(`block ${height}: transaction cap ${this.config.maxTxsPerBlock} reached`);
            break;
          }
          if (!hasFunctionCall(tx)) continue;
          if (!this.shouldInspectTx(tx)) continue;
          candidates.push({ hash: tx.hash, signerId: tx.signer_id });
        }
      }

      const outcomes = await mapLimit(candidates, 4, async (tx) => {
        try {
          const outcome = await this.rpc.getTxStatus(tx.hash, tx.signerId);
          return eventsFromTxOutcome(tx.hash, outcome, blockMeta(block), this.config.contractFilter);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Ancient blocks are pruned from tx status. NEP-297 events cannot be
          // reconstructed from a pruned transaction, so skip with a warning.
          warnings.push(`block ${height} tx ${tx.hash}: ${message}`);
          return [];
        }
      });

      const result = this.db.applyBlock(blockMeta(block), outcomes.flat());
      return { events: result.insertedEvents, prints: result.prints };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to index block ${height}: ${message}`);
    }
  }

  private shouldInspectTx(tx: TransactionView): boolean {
    if (isTenderMethod(tx)) return true;
    if (this.config.contractFilter.length === 0) return true;
    if (this.config.contractFilter.includes(tx.receiver_id)) return true;
    return isFungibleTokenPush(tx);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log(`[indexer] sync error: ${this.lastError}`);
      }
      if (this.stopping) break;
      await new Promise((resolve) => setTimeout(resolve, this.config.intervalMs));
    }
  }
}

/** Run an async mapper with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function blockTimestampNs(header: {
  timestamp_nanosec?: string;
  timestamp_ns?: string;
  timestamp?: number;
}): string {
  if (header.timestamp_nanosec) return header.timestamp_nanosec;
  if (header.timestamp_ns) return header.timestamp_ns;
  if (typeof header.timestamp === "number") return BigInt(Math.trunc(header.timestamp)).toString();
  throw new Error("block header is missing a timestamp");
}

function blockMeta(block: { header: { height: number; hash: string } & Parameters<typeof blockTimestampNs>[0] }): BlockMeta {
  return {
    height: block.header.height,
    hash: block.header.hash,
    timestampNs: blockTimestampNs(block.header),
  };
}