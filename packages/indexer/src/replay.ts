import type { StoredEvent } from "./derive.js";
import type { TapeDb } from "./db.js";

export interface ReplayBlock {
  height: number;
  hash: string;
  timestamp_ns: string;
  events: StoredEvent[];
}

export interface ReplayWindow {
  version: number;
  network: string;
  contract_id: string;
  indexer: {
    start_block: number;
    last_indexed_block: number;
    blocks: number;
    events: number;
    jobs: number;
    prints: number;
  };
  blocks: ReplayBlock[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`replay ${field} must be a non-empty string`);
  }
  return value;
}

/** Replay an explicitly exported chain window through the real event projection path. */
export function applyReplayWindow(db: TapeDb, replay: ReplayWindow): { blocks: number; events: number } {
  if (!Array.isArray(replay.blocks) || replay.blocks.length === 0) {
    throw new Error("replay must contain at least one block");
  }

  let previousHeight: number | null = null;
  let eventCount = 0;
  for (const block of replay.blocks) {
    if (!Number.isSafeInteger(block.height) || block.height < 0) {
      throw new Error("replay block height must be a non-negative safe integer");
    }
    if (previousHeight !== null && block.height !== previousHeight + 1) {
      throw new Error("replay blocks must form one contiguous, ascending window");
    }
    requiredString(block.hash, "block hash");
    requiredString(block.timestamp_ns, "block timestamp");
    if (!Array.isArray(block.events)) throw new Error(`replay block ${block.height} events must be an array`);

    for (const event of block.events) {
      if (event.blockHeight !== block.height) throw new Error("replay event block height does not match its block");
      if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0) {
        throw new Error("replay event log index must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(event.dataIndex) || event.dataIndex < 0) {
        throw new Error("replay event data index must be a non-negative safe integer");
      }
      requiredString(event.contractId, "event contract id");
      requiredString(event.receiptId, "event receipt id");
      requiredString(event.blockTimestampNs, "event timestamp");
      if (event.txHash !== null) requiredString(event.txHash, "event transaction hash");
      if (event.blockTimestampNs !== block.timestamp_ns) {
        throw new Error("replay event timestamp does not match its block");
      }
      requiredString(event.event, "event type");
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        throw new Error("replay event data must be an object");
      }
      eventCount += 1;
    }

    db.applyBlock(
      { height: block.height, hash: block.hash, timestampNs: block.timestamp_ns },
      block.events,
    );
    previousHeight = block.height;
  }

  const expected = replay.indexer;
  if (expected) {
    const { blocks, events, jobs, prints } = db.counts();
    if (
      blocks !== expected.blocks ||
      events !== expected.events ||
      jobs !== expected.jobs ||
      prints !== expected.prints
    ) {
      throw new Error("replay projection does not match the deployment proof counts");
    }
  }

  return { blocks: replay.blocks.length, events: eventCount };
}
