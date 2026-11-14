import {
  fieldObject,
  fieldString,
  fieldUint,
  normalizeEscrowToken,
} from "./events.js";

export interface StoredEvent {
  contractId: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
  txHash: string | null;
  blockHeight: number;
  blockTimestampNs: string;
  event: string;
  data: Record<string, unknown>;
}

export interface JobProjection {
  id: string;
  contract_id: string;
  job_id: string;
  buyer: string | null;
  title: string | null;
  category: string | null;
  spec_sha256: string | null;
  spec_uri: string | null;
  work_units: string | null;
  unit_label: string | null;
  escrow_token: string;
  escrow_token_id: string | null;
  mechanism: string | null;
  reserve_price: string | null;
  min_worker_bond: string | null;
  max_commits: number | null;
  arbiter: string | null;
  commit_deadline_ns: string | null;
  reveal_deadline_ns: string | null;
  delivery_duration_ns: string | null;
  dispute_window_ns: string | null;
  delivery_deadline_ns: string | null;
  created_at_ns: string | null;
  status: string;
  winner: string | null;
  winning_bid: string | null;
  runner_up_bid: string | null;
  clearing_price: string | null;
  unit_price: string | null;
  deliverable_uri: string | null;
  deliverable_sha256: string | null;
  dispute_reason_sha256: string | null;
  settle_trigger: string | null;
  settled_at_ns: string | null;
  surplus_refunded: string | null;
  commit_count: number;
  reveal_count: number;
  last_event_block: number;
  last_event_timestamp_ns: string;
}

export interface TapePrint {
  id: string;
  contract_id: string;
  job_id: string;
  category: string | null;
  title: string | null;
  buyer: string | null;
  winner: string | null;
  mechanism: string | null;
  escrow_token: string;
  escrow_token_id: string | null;
  reserve_price: string;
  winning_bid: string;
  runner_up_bid: string | null;
  clearing_price: string;
  surplus_refunded: string | null;
  unit_price: string | null;
  work_units: string | null;
  unit_label: string | null;
  commit_count: number;
  reveal_count: number;
  spec_sha256: string | null;
  deliverable_sha256: string | null;
  deliverable_uri: string | null;
  trigger: string | null;
  settled_at_ns: string;
  block_height: number;
  receipt_id: string;
  tx_hash: string | null;
  log_index: number;
  savings_bps: number;
  worker_premium_bps: number;
}

const EVENT_PRIORITY: Record<string, number> = {
  job_created: 10,
  bid_committed: 20,
  bid_revealed: 30,
  auction_cleared: 40,
  delivery_submitted: 50,
  job_disputed: 60,
  payout_failed: 70,
  job_refunded: 80,
  job_settled: 90,
};

export function eventPriority(event: string): number {
  return EVENT_PRIORITY[event] ?? 0;
}

export function jobKey(contractId: string, jobId: string): string {
  return `${contractId}:${jobId}`;
}

function toBigInt(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function computeUnitPrice(clearingPrice: string | null, workUnits: string | null): string | null {
  const price = toBigInt(clearingPrice);
  const units = toBigInt(workUnits);
  if (price === null || units === null || units <= 0n) return null;
  return (price / units).toString();
}

export function bps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const value = (part * 10_000n) / whole;
  if (value > 100_000n) return 100_000;
  return Number(value);
}

/** Deterministically fold all events for a job into a single projection. */
export function projectJob(events: readonly StoredEvent[]): JobProjection | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => {
    if (a.blockHeight !== b.blockHeight) return a.blockHeight - b.blockHeight;
    const priority = eventPriority(a.event) - eventPriority(b.event);
    if (priority !== 0) return priority;
    return a.logIndex - b.logIndex;
  });

  const first = sorted[0];
  if (!first) return null;
  const created = sorted.find((event) => event.event === "job_created");
  const baseData = created?.data ?? first.data;
  const jobId = fieldUint(baseData, "job_id") ?? fieldUint(first.data, "job_id");
  if (jobId === null) return null;

  const escrowRaw = baseData["escrow_token"];
  const escrow = normalizeEscrowToken(escrowRaw);
  const escrowToken = escrowRaw === undefined ? "unknown" : JSON.stringify(escrowRaw);

  const projection: JobProjection = {
    id: jobKey(first.contractId, jobId),
    contract_id: first.contractId,
    job_id: jobId,
    buyer: fieldString(baseData, "buyer"),
    title: fieldString(baseData, "title"),
    category: fieldString(baseData, "category"),
    spec_sha256: fieldString(baseData, "spec_sha256"),
    spec_uri: fieldString(baseData, "spec_uri"),
    work_units: fieldUint(baseData, "work_units"),
    unit_label: fieldString(baseData, "unit_label"),
    escrow_token: escrowToken,
    escrow_token_id: escrow?.kind === "ft" ? escrow.token_id : null,
    mechanism: fieldString(baseData, "mechanism"),
    reserve_price: fieldUint(baseData, "reserve_price"),
    min_worker_bond: fieldUint(baseData, "min_worker_bond"),
    max_commits: (() => {
      const raw = fieldUint(baseData, "max_commits");
      return raw === null ? null : Number(raw);
    })(),
    arbiter: fieldString(baseData, "arbiter"),
    commit_deadline_ns: fieldUint(baseData, "commit_deadline_ns"),
    reveal_deadline_ns: fieldUint(baseData, "reveal_deadline_ns"),
    delivery_duration_ns: fieldUint(baseData, "delivery_duration_ns"),
    dispute_window_ns: fieldUint(baseData, "dispute_window_ns"),
    delivery_deadline_ns: null,
    created_at_ns: fieldUint(baseData, "created_at_ns"),
    status: created ? "Open" : "Unknown",
    winner: null,
    winning_bid: null,
    runner_up_bid: null,
    clearing_price: null,
    unit_price: null,
    deliverable_uri: null,
    deliverable_sha256: null,
    dispute_reason_sha256: null,
    settle_trigger: null,
    settled_at_ns: null,
    surplus_refunded: null,
    commit_count: 0,
    reveal_count: 0,
    last_event_block: first.blockHeight,
    last_event_timestamp_ns: first.blockTimestampNs,
  };

  for (const event of sorted) {
    const data = event.data;
    projection.last_event_block = event.blockHeight;
    projection.last_event_timestamp_ns = event.blockTimestampNs;

    switch (event.event) {
      case "bid_committed": {
        const count = fieldUint(data, "commit_count");
        if (count !== null) projection.commit_count = Math.max(projection.commit_count, Number(count));
        break;
      }
      case "bid_revealed": {
        const count = fieldUint(data, "reveal_count");
        if (count !== null) projection.reveal_count = Math.max(projection.reveal_count, Number(count));
        break;
      }
      case "auction_cleared": {
        projection.status = "Assigned";
        projection.winner = fieldString(data, "winner") ?? projection.winner;
        projection.winning_bid = fieldUint(data, "winning_bid") ?? projection.winning_bid;
        projection.runner_up_bid = fieldUint(data, "runner_up_bid");
        projection.clearing_price = fieldUint(data, "clearing_price") ?? projection.clearing_price;
        projection.unit_price =
          computeUnitPrice(projection.clearing_price, projection.work_units) ?? projection.unit_price;
        projection.delivery_deadline_ns = fieldUint(data, "delivery_deadline_ns");
        const commits = fieldUint(data, "commit_count");
        const reveals = fieldUint(data, "reveal_count");
        if (commits !== null) projection.commit_count = Math.max(projection.commit_count, Number(commits));
        if (reveals !== null) projection.reveal_count = Math.max(projection.reveal_count, Number(reveals));
        break;
      }
      case "delivery_submitted": {
        projection.status = "Delivered";
        projection.deliverable_uri = fieldString(data, "deliverable_uri") ?? projection.deliverable_uri;
        projection.deliverable_sha256 =
          fieldString(data, "deliverable_sha256") ?? projection.deliverable_sha256;
        break;
      }
      case "job_disputed": {
        projection.status = "Disputed";
        projection.dispute_reason_sha256 = fieldString(data, "reason_sha256");
        break;
      }
      case "payout_failed": {
        const rolledBack = fieldString(data, "rolled_back_to");
        if (rolledBack) projection.status = rolledBack;
        break;
      }
      case "job_refunded": {
        projection.status = fieldString(data, "status") ?? "Refunded";
        break;
      }
      case "job_settled": {
        projection.status = "Settled";
        projection.winner = fieldString(data, "winner") ?? projection.winner;
        projection.buyer = fieldString(data, "buyer") ?? projection.buyer;
        projection.title = fieldString(data, "title") ?? projection.title;
        projection.category = fieldString(data, "category") ?? projection.category;
        projection.mechanism = fieldString(data, "mechanism") ?? projection.mechanism;
        projection.spec_sha256 = fieldString(data, "spec_sha256") ?? projection.spec_sha256;
        projection.work_units = fieldUint(data, "work_units") ?? projection.work_units;
        projection.unit_label = fieldString(data, "unit_label") ?? projection.unit_label;
        projection.reserve_price = fieldUint(data, "reserve_price") ?? projection.reserve_price;
        projection.winning_bid = fieldUint(data, "winning_bid") ?? projection.winning_bid;
        projection.runner_up_bid = fieldUint(data, "runner_up_bid");
        projection.clearing_price = fieldUint(data, "clearing_price") ?? projection.clearing_price;
        projection.surplus_refunded = fieldUint(data, "surplus_refunded");
        projection.unit_price =
          fieldUint(data, "unit_price") ??
          computeUnitPrice(projection.clearing_price, projection.work_units);
        projection.deliverable_uri = fieldString(data, "deliverable_uri") ?? projection.deliverable_uri;
        projection.deliverable_sha256 =
          fieldString(data, "deliverable_sha256") ?? projection.deliverable_sha256;
        projection.settle_trigger = fieldString(data, "trigger");
        projection.settled_at_ns = fieldUint(data, "settled_at_ns") ?? projection.settled_at_ns;
        const commits = fieldUint(data, "commit_count");
        const reveals = fieldUint(data, "reveal_count");
        if (commits !== null) projection.commit_count = Math.max(projection.commit_count, Number(commits));
        if (reveals !== null) projection.reveal_count = Math.max(projection.reveal_count, Number(reveals));
        break;
      }
      default:
        break;
    }
  }

  return projection;
}

/** Build the settled print (trade record) for a job, if it has settled. */
export function projectPrint(
  projection: JobProjection,
  events: readonly StoredEvent[],
): TapePrint | null {
  if (projection.status !== "Settled") return null;
  const settled = [...events]
    .filter((event) => event.event === "job_settled")
    .sort((a, b) => b.blockHeight - a.blockHeight || b.logIndex - a.logIndex)[0];
  if (!settled) return null;

  const clearingPrice = projection.clearing_price;
  const winningBid = projection.winning_bid;
  const reservePrice = projection.reserve_price;
  if (clearingPrice === null || winningBid === null || reservePrice === null) return null;

  const reserve = toBigInt(reservePrice) ?? 0n;
  const clearing = toBigInt(clearingPrice) ?? 0n;
  const winning = toBigInt(winningBid) ?? 0n;

  return {
    id: projection.id,
    contract_id: projection.contract_id,
    job_id: projection.job_id,
    category: projection.category,
    title: projection.title,
    buyer: projection.buyer,
    winner: projection.winner,
    mechanism: projection.mechanism,
    escrow_token: projection.escrow_token,
    escrow_token_id: projection.escrow_token_id,
    reserve_price: reservePrice,
    winning_bid: winningBid,
    runner_up_bid: projection.runner_up_bid,
    clearing_price: clearingPrice,
    surplus_refunded: projection.surplus_refunded,
    unit_price: projection.unit_price,
    work_units: projection.work_units,
    unit_label: projection.unit_label,
    commit_count: projection.commit_count,
    reveal_count: projection.reveal_count,
    spec_sha256: fieldString(settled.data, "spec_sha256") ?? projection.spec_sha256,
    deliverable_sha256: projection.deliverable_sha256,
    deliverable_uri: projection.deliverable_uri,
    trigger: projection.settle_trigger,
    settled_at_ns: projection.settled_at_ns ?? settled.blockTimestampNs,
    block_height: settled.blockHeight,
    receipt_id: settled.receiptId,
    tx_hash: settled.txHash,
    log_index: settled.logIndex,
    savings_bps: bps(reserve > clearing ? reserve - clearing : 0n, reserve),
    worker_premium_bps: bps(clearing > winning ? clearing - winning : 0n, winning),
  };
}

export function escrowTokenIdFromJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const normalized = normalizeEscrowToken(parsed);
    return normalized?.kind === "ft" ? normalized.token_id : null;
  } catch {
    return null;
  }
}

export function dataFromJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export { fieldObject, fieldString, fieldUint };