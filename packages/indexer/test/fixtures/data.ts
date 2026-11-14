import type { StoredEvent } from "../../src/derive.js";

export const CONTRACT = "tender.testnet";
export const NEAR = 10n ** 24n;

export function near(amount: number): string {
  return BigInt(Math.round(amount * 1_000_000)) * (NEAR / 1_000_000n) + "";
}

export function nearExact(milliNear: number): string {
  return (BigInt(milliNear) * NEAR) / 1000n + "";
}

let receiptCounter = 0;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function receiptId(): string {
  receiptCounter += 1;
  let value = "";
  let seed = receiptCounter * 7919 + 104729;
  for (let index = 0; index < 44; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    value += BASE58[seed % BASE58.length];
  }
  return value;
}

export function event(
  eventName: string,
  blockHeight: number,
  data: Record<string, unknown>,
  options: { timestampNs?: string; logIndex?: number; contract?: string } = {},
): StoredEvent {
  return {
    contractId: options.contract ?? CONTRACT,
    receiptId: receiptId(),
    logIndex: options.logIndex ?? 0,
    dataIndex: 0,
    txHash: `Tx${receiptCounter.toString(36).toUpperCase()}${"1".repeat(30)}`,
    blockHeight,
    blockTimestampNs: options.timestampNs ?? String(1_700_000_000_000_000_000n + BigInt(blockHeight) * 1_000_000_000n),
    event: eventName,
    data,
  };
}

const SPEC_HASH = "a".repeat(64);
const DELIV_HASH = "b".repeat(64);

export function jobCreated(
  jobId: number,
  blockHeight: number,
  options: {
    buyer?: string;
    title?: string;
    category?: string;
    workUnits?: number;
    unitLabel?: string;
    reserveNear?: number;
    mechanism?: string;
    minWorkerBond?: string;
    escrowToken?: unknown;
    contract?: string;
  } = {},
): StoredEvent {
  const reserve = nearExact(Math.round((options.reserveNear ?? 3) * 1000));
  return event(
    "job_created",
    blockHeight,
    {
      job_id: String(jobId),
      buyer: options.buyer ?? "buyer.testnet",
      title: options.title ?? `Job ${jobId}`,
      category: options.category ?? "smart-contract-audit",
      spec_sha256: SPEC_HASH,
      spec_uri: `ipfs://spec-${jobId}`,
      work_units: String(options.workUnits ?? 3),
      unit_label: options.unitLabel ?? "kloc",
      escrow_token: options.escrowToken ?? "Near",
      mechanism: options.mechanism ?? "VickreySecondPrice",
      reserve_price: reserve,
      min_worker_bond: options.minWorkerBond ?? "0",
      max_commits: 16,
      arbiter: null,
      commit_deadline_ns: "1700000100000000000",
      reveal_deadline_ns: "1700000200000000000",
      delivery_duration_ns: "1700000300000000000",
      dispute_window_ns: "1700000400000000000",
      created_at_ns: "1700000000000000000",
    },
    { timestampNs: "1700000000000000000", contract: options.contract },
  );
}

export function committed(
  jobId: number,
  blockHeight: number,
  worker: string,
  commitCount: number,
  commitSeq: number,
): StoredEvent {
  return event("bid_committed", blockHeight, {
    job_id: String(jobId),
    worker,
    commit_hash: "c".repeat(64),
    commit_seq: commitSeq,
    commit_count: commitCount,
    committed_at_ns: "1700000050000000000",
  });
}

export function revealed(
  jobId: number,
  blockHeight: number,
  worker: string,
  bid: string,
  revealCount: number,
  commitSeq: number,
  options: { category?: string; contract?: string } = {},
): StoredEvent {
  return event("bid_revealed", blockHeight, {
    job_id: String(jobId),
    category: options.category ?? "smart-contract-audit",
    worker,
    bid_yocto: bid,
    eta_seconds: "120",
    commit_seq: commitSeq,
    reveal_count: revealCount,
    revealed_at_ns: "1700000100000000000",
  }, { contract: options.contract });
}

export function cleared(
  jobId: number,
  blockHeight: number,
  options: {
    winner: string;
    reserve: string;
    winning: string;
    runnerUp: string | null;
    clearing: string;
    commits: number;
    reveals: number;
    mechanism?: string;
    category?: string;
  },
): StoredEvent {
  return event("auction_cleared", blockHeight, {
    job_id: String(jobId),
    category: options.category ?? "smart-contract-audit",
    mechanism: options.mechanism ?? "VickreySecondPrice",
    winner: options.winner,
    reserve_price: options.reserve,
    winning_bid: options.winning,
    runner_up_bid: options.runnerUp,
    clearing_price: options.clearing,
    commit_count: options.commits,
    reveal_count: options.reveals,
    delivery_deadline_ns: "1700000300000000000",
    cleared_at_ns: "1700000120000000000",
  });
}

export function delivered(jobId: number, blockHeight: number, worker: string): StoredEvent {
  return event("delivery_submitted", blockHeight, {
    job_id: String(jobId),
    worker,
    deliverable_uri: `ipfs://deliverable-${jobId}`,
    deliverable_sha256: DELIV_HASH,
    delivered_at_ns: "1700000140000000000",
    dispute_deadline_ns: "1700000160000000000",
  });
}

export function settled(
  jobId: number,
  blockHeight: number,
  options: {
    title: string;
    category: string;
    winner: string;
    reserve: string;
    winning: string;
    runnerUp: string;
    clearing: string;
    workUnits: number;
    unitLabel: string;
    mechanism?: string;
    commits?: number;
    reveals?: number;
    escrowToken?: unknown;
  },
): StoredEvent {
  const unit = (BigInt(options.clearing) / BigInt(options.workUnits)).toString();
  const surplus = (BigInt(options.reserve) - BigInt(options.clearing)).toString();
  return event(
    "job_settled",
    blockHeight,
    {
      job_id: String(jobId),
      title: options.title,
      category: options.category,
      mechanism: options.mechanism ?? "VickreySecondPrice",
      escrow_token: options.escrowToken ?? "Near",
      buyer: "buyer.testnet",
      winner: options.winner,
      reserve_price: options.reserve,
      winning_bid: options.winning,
      runner_up_bid: options.runnerUp,
      clearing_price: options.clearing,
      surplus_refunded: surplus,
      unit_price: unit,
      work_units: String(options.workUnits),
      unit_label: options.unitLabel,
      commit_count: options.commits ?? 3,
      reveal_count: options.reveals ?? 3,
      spec_sha256: SPEC_HASH,
      deliverable_sha256: DELIV_HASH,
      deliverable_uri: `ipfs://deliverable-${jobId}`,
      trigger: "timeout_auto_settled",
      settled_at_ns: "1700000180000000000",
    },
    { timestampNs: "1700000180000000000" },
  );
}

export function ftJobCreated(
  jobId: number,
  blockHeight: number,
  options: { buyer: string; tokenId: string; category: string; contract: string },
): StoredEvent {
  return jobCreated(jobId, blockHeight, {
    buyer: options.buyer,
    category: options.category,
    escrowToken: { Ft: { token_id: options.tokenId } },
    contract: options.contract,
  });
}

export function refunded(jobId: number, blockHeight: number): StoredEvent {
  return event("job_refunded", blockHeight, {
    job_id: String(jobId),
    buyer: "buyer.testnet",
    amount: nearExact(2000),
    reason: "ZeroReveals",
    status: "CancelledZeroReveals",
    refunded_at_ns: "1700000190000000000",
  });
}

export function payoutFailed(jobId: number, blockHeight: number): StoredEvent {
  return event("payout_failed", blockHeight, {
    job_id: String(jobId),
    receiver: "worker4.testnet",
    rolled_back_to: "Delivered",
    failed_at_ns: "1700000200000000000",
  });
}

export interface Fixture {
  blocks: Array<{ height: number; hash: string; timestampNs: string; events: StoredEvent[] }>;
  expected: {
    prints: number;
    medianUnitPrice: string;
    medianClearingPrice: string;
    volumeClearing: string;
    buyerSavings: string;
    spread: string;
    spreadBps: number;
    medianSavingsBps: number;
  };
}

/** Three jobs: one Vickrey settled print, one FirstPrice settled print, one zero-reveal refund. */
export function buildFixture(): Fixture {
  const b1Reserve = nearExact(3000);
  const b1Clearing = nearExact(1800);
  const b1Winning = nearExact(1200);
  const b1Runner = nearExact(1800);
  const b2Reserve = nearExact(2000);
  const b2Clearing = nearExact(1000);

  const blocks: Fixture["blocks"] = [
    {
      height: 100,
      hash: "Blk100",
      timestampNs: "1700000000000000000",
      events: [
        jobCreated(0, 100, { reserveNear: 3 }),
        jobCreated(1, 100, {
          title: "Dataset labeling",
          category: "data-labeling",
          workUnits: 2,
          unitLabel: "1k-rows",
          reserveNear: 2,
          mechanism: "FirstPrice",
        }),
        jobCreated(2, 100, { title: "Zero reveal job", reserveNear: 2 }),
        jobCreated(3, 100, { title: "Rollback job", reserveNear: 2 }),
      ],
    },
    {
      height: 101,
      hash: "Blk101",
      timestampNs: "1700000050000000000",
      events: [
        committed(0, 101, "worker1.testnet", 1, 1),
        committed(0, 101, "worker2.testnet", 2, 2),
        committed(0, 101, "worker3.testnet", 3, 3),
        committed(1, 101, "worker1.testnet", 1, 4),
        committed(1, 101, "worker2.testnet", 2, 5),
      ],
    },
    {
      height: 102,
      hash: "Blk102",
      timestampNs: "1700000100000000000",
      events: [
        revealed(0, 102, "worker1.testnet", b1Winning, 1, 1),
        revealed(0, 102, "worker2.testnet", b1Runner, 2, 2),
        revealed(0, 102, "worker3.testnet", nearExact(2400), 3, 3),
        revealed(1, 102, "worker1.testnet", nearExact(1100), 1, 4),
        revealed(1, 102, "worker2.testnet", b2Clearing, 2, 5),
      ],
    },
    {
      height: 103,
      hash: "Blk103",
      timestampNs: "1700000120000000000",
      events: [
        cleared(0, 103, {
          winner: "worker1.testnet",
          reserve: b1Reserve,
          winning: b1Winning,
          runnerUp: b1Runner,
          clearing: b1Clearing,
          commits: 3,
          reveals: 3,
        }),
        cleared(1, 103, {
          winner: "worker2.testnet",
          reserve: b2Reserve,
          winning: b2Clearing,
          runnerUp: nearExact(1100),
          clearing: b2Clearing,
          commits: 2,
          reveals: 2,
          mechanism: "FirstPrice",
          category: "data-labeling",
        }),
      ],
    },
    {
      height: 104,
      hash: "Blk104",
      timestampNs: "1700000140000000000",
      events: [delivered(0, 104, "worker1.testnet"), delivered(1, 104, "worker2.testnet")],
    },
    {
      height: 105,
      hash: "Blk105",
      timestampNs: "1700000180000000000",
      events: [
        settled(0, 105, {
          title: "Job 0",
          category: "smart-contract-audit",
          winner: "worker1.testnet",
          reserve: b1Reserve,
          winning: b1Winning,
          runnerUp: b1Runner,
          clearing: b1Clearing,
          workUnits: 3,
          unitLabel: "kloc",
        }),
        settled(1, 105, {
          title: "Dataset labeling",
          category: "data-labeling",
          winner: "worker2.testnet",
          reserve: b2Reserve,
          winning: b2Clearing,
          runnerUp: nearExact(1100),
          clearing: b2Clearing,
          workUnits: 2,
          unitLabel: "1k-rows",
          mechanism: "FirstPrice",
          commits: 2,
          reveals: 2,
        }),
        payoutFailed(3, 105),
      ],
    },
    {
      height: 106,
      hash: "Blk106",
      timestampNs: "1700000190000000000",
      events: [refunded(2, 106)],
    },
  ];

  const expected = {
    prints: 2,
    medianUnitPrice: "550000000000000000000000",
    medianClearingPrice: "1400000000000000000000000",
    volumeClearing: "2800000000000000000000000",
    buyerSavings: "2200000000000000000000000",
    spread: "100000000000000000000000",
    spreadBps: 1818,
    medianSavingsBps: 4500,
  };

  return { blocks, expected };
}

export function applyFixture(db: { applyBlock: (block: { height: number; hash: string; timestampNs: string }, events: StoredEvent[]) => unknown }, fixture: Fixture): void {
  for (const block of fixture.blocks) {
    db.applyBlock(
      { height: block.height, hash: block.hash, timestampNs: block.timestampNs },
      block.events,
    );
  }
}