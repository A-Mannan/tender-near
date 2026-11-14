export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorShape) {
    super(error.message);
    this.name = "RpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface BlockHeaderView {
  height: number;
  hash: string;
  /** Exact nanoseconds (string) on current nearcore; `timestamp` is a lossy JSON number. */
  timestamp_nanosec?: string;
  timestamp_ns?: string;
  timestamp?: number;
}

export interface BlockView {
  author: string;
  header: BlockHeaderView;
  chunks: Array<{
    chunk_hash: string;
    shard_id: number;
    height_included: number;
    /** 8 bytes for an empty chunk; larger when it carries transactions/receipts. */
    encoded_length?: number;
    /** Base58 zero hash when the chunk carries no transactions. */
    tx_root?: string;
  }>;
}

export interface TransactionActionJson {
  FunctionCall?: {
    method_name: string;
    args: string;
    gas: number;
    deposit: string;
  };
}

export interface TransactionView {
  hash: string;
  signer_id: string;
  receiver_id: string;
  actions: TransactionActionJson[];
}

export interface ChunkView {
  header: { height_included: number; chunk_hash: string };
  transactions: TransactionView[];
  receipts: unknown[];
}

export interface ReceiptView {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  receipt: {
    Action?: {
      signer_id: string;
      actions: TransactionActionJson[];
    };
  };
}

export type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown };

export interface ExecutionOutcomeView {
  executor_id: string;
  logs: string[];
  gas_burnt: number;
  tokens_burnt: string;
  status: ExecutionStatus;
}

export interface ExecutionOutcomeWithIdView {
  id: string;
  block_hash: string;
  outcome: ExecutionOutcomeView;
}

export interface FinalExecutionOutcomeView {
  final_execution_status: string;
  receipts: ReceiptView[];
  receipts_outcome: ExecutionOutcomeWithIdView[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 5;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_INTERVAL_MS = 125;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal typed NEAR JSON-RPC client with bounded retries, timeouts, concurrency and request-rate caps. */
export class NearRpc {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private active = 0;
  private nextRequestAt = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxConcurrency = DEFAULT_CONCURRENCY,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  ) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.minIntervalMs = Math.max(0, minIntervalMs);
  }

  get endpoint(): string {
    return this.url;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  async call<T>(
    method: string,
    params: Record<string, unknown>,
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryAfterMs = 0;
      let delayMs = 0;

      // Space request starts globally so free public RPC quotas are respected.
      const startAt = Math.max(Date.now(), this.nextRequestAt);
      this.nextRequestAt = startAt + this.minIntervalMs;
      if (startAt > Date.now()) await sleep(startAt - Date.now());
      await this.acquire();

      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method, params }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const header = response.headers.get("retry-after");
          if (header) {
            const seconds = Number(header);
            if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds * 1_000);
          }
          throw new Error(`RPC HTTP ${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as {
          result?: T;
          error?: RpcErrorShape;
        };
        if (body.error) {
          const rpcError = new RpcError(body.error);
          // Unknown / pruned transaction is not worth retrying.
          if (rpcError.message.includes("UNKNOWN_TRANSACTION")) {
            rpcError.name = "NonRetryableRpcError";
          }
          throw rpcError;
        }
        if (body.result === undefined) {
          throw new Error("Malformed JSON-RPC response: missing result");
        }
        return body.result;
      } catch (error) {
        lastError = error;
        if (attempt === retries || (error instanceof RpcError && error.name === "NonRetryableRpcError")) break;
        const base = retryAfterMs > 0 ? retryAfterMs : 500 * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 250);
        delayMs = Math.min(15_000, base + jitter);
      } finally {
        this.release();
        clearTimeout(timer);
      }

      // Back off outside the concurrency slot so other queued requests can proceed.
      if (delayMs > 0) await sleep(delayMs);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  getLatestBlock(): Promise<BlockView> {
    return this.call<BlockView>("block", { finality: "final" });
  }

  getBlockByHeight(height: number): Promise<BlockView> {
    return this.call<BlockView>("block", { block_id: height });
  }

  getChunk(chunkHash: string): Promise<ChunkView> {
    return this.call<ChunkView>("chunk", { chunk_id: chunkHash });
  }

  getTxStatus(txHash: string, senderAccountId: string): Promise<FinalExecutionOutcomeView> {
    return this.call<FinalExecutionOutcomeView>("EXPERIMENTAL_tx_status", {
      tx_hash: txHash,
      sender_account_id: senderAccountId,
      wait_until: "FINAL",
    });
  }

  getReceipt(receiptId: string): Promise<{
    receipt: ReceiptView;
    outcome: ExecutionOutcomeView;
  }> {
    return this.call("EXPERIMENTAL_receipt", { receipt_id: receiptId });
  }
}