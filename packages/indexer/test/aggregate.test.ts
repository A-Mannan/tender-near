import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeMedianStats,
  computeSpread,
  computeWinRates,
  formatNear,
  median,
  percentile,
} from "../src/aggregate.js";
import type { TapePrint } from "../src/derive.js";

test("median is exact for odd and even integer sets", () => {
  assert.equal(median([]), null);
  assert.equal(median([5n]), 5n);
  assert.equal(median([9n, 3n, 5n]), 5n);
  assert.equal(median([4n, 7n]), 5n);
  assert.equal(median([1n, 2n]), 1n, "floor of an exact .5 midpoint");
  assert.equal(median([10n, 2n, 8n, 4n]), 6n);
});

test("percentile uses nearest-rank with clamped bounds", () => {
  assert.equal(percentile([10n, 20n, 30n, 40n], 0), 10n);
  assert.equal(percentile([10n, 20n, 30n, 40n], 25), 10n);
  assert.equal(percentile([10n, 20n, 30n, 40n], 50), 20n);
  assert.equal(percentile([10n, 20n, 30n, 40n], 75), 30n);
  assert.equal(percentile([10n, 20n, 30n, 40n], 100), 40n);
});

test("formatNear renders 24-decimal amounts without float loss", () => {
  assert.equal(formatNear("1000000000000000000000000"), "1");
  assert.equal(formatNear("1800000000000000000000000"), "1.8");
  assert.equal(formatNear("1234567890123456789012345"), "1.234567890123456789012345");
  assert.equal(formatNear("1"), "0.000000000000000000000001");
  assert.equal(formatNear("0"), "0");
});

function print(overrides: Partial<TapePrint>): TapePrint {
  return {
    id: "tender.testnet:0",
    contract_id: "tender.testnet",
    job_id: "0",
    category: "smart-contract-audit",
    title: "Job",
    buyer: "buyer.testnet",
    winner: "worker1.testnet",
    mechanism: "VickreySecondPrice",
    escrow_token: "\"Near\"",
    escrow_token_id: null,
    reserve_price: "3000000000000000000000000",
    winning_bid: "1200000000000000000000000",
    runner_up_bid: "1800000000000000000000000",
    clearing_price: "1800000000000000000000000",
    surplus_refunded: "1200000000000000000000000",
    unit_price: "600000000000000000000000",
    work_units: "3",
    unit_label: "kloc",
    commit_count: 3,
    reveal_count: 3,
    spec_sha256: null,
    deliverable_sha256: null,
    deliverable_uri: null,
    trigger: "timeout_auto_settled",
    settled_at_ns: "1700000180000000000",
    block_height: 105,
    receipt_id: "r1",
    tx_hash: "t1",
    log_index: 0,
    savings_bps: 4000,
    worker_premium_bps: 5000,
    ...overrides,
  };
}

test("median stats aggregate exact prices, volume and savings", () => {
  const prints = [
    print({}),
    print({
      id: "tender.testnet:1",
      job_id: "1",
      category: "data-labeling",
      unit_label: "1k-rows",
      unit_price: "500000000000000000000000",
      clearing_price: "1000000000000000000000000",
      reserve_price: "2000000000000000000000000",
      winning_bid: "1000000000000000000000000",
      savings_bps: 5000,
      worker_premium_bps: 0,
    }),
  ];
  const stats = computeMedianStats(prints);
  assert.equal(stats.count, 2);
  assert.equal(stats.priced_count, 2);
  assert.equal(stats.median_unit_price, "550000000000000000000000");
  assert.equal(stats.median_clearing_price, "1400000000000000000000000");
  assert.equal(stats.volume_clearing, "2800000000000000000000000");
  assert.equal(stats.buyer_savings, "2200000000000000000000000");
  assert.equal(stats.median_savings_bps, 4500);
  assert.deepEqual(stats.categories, ["data-labeling", "smart-contract-audit"]);
  assert.deepEqual(stats.units, ["1k-rows", "kloc"]);
});

test("spread reports min, quartiles, max and bps of median", () => {
  const prints = [
    print({}),
    print({
      id: "tender.testnet:1",
      job_id: "1",
      unit_price: "500000000000000000000000",
    }),
  ];
  const spread = computeSpread(prints);
  assert.equal(spread.min_unit_price, "500000000000000000000000");
  assert.equal(spread.max_unit_price, "600000000000000000000000");
  assert.equal(spread.p25_unit_price, "500000000000000000000000");
  assert.equal(spread.p75_unit_price, "600000000000000000000000");
  assert.equal(spread.spread, "100000000000000000000000");
  assert.equal(spread.spread_bps, 1818);
});

test("win rate merges reveals and wins, including losers", () => {
  const rows = computeWinRates(
    [
      { worker: "w1", reveals: 2 },
      { worker: "w2", reveals: 4 },
      { worker: "w3", reveals: 1 },
    ],
    [
      { winner: "w1", wins: 2, volume_won: "20" },
      { winner: "w2", wins: 1, volume_won: "10" },
    ],
  );
  assert.equal(rows[0]?.worker, "w1");
  assert.equal(rows[0]?.win_rate_bps, 10_000);
  assert.equal(rows[1]?.worker, "w2");
  assert.equal(rows[1]?.win_rate_bps, 2500);
  assert.equal(rows[2]?.worker, "w3");
  assert.equal(rows[2]?.win_rate_bps, 0);
});

test("empty dataset returns null statistics, not NaN", () => {
  const stats = computeMedianStats([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.median_unit_price, null);
  assert.equal(stats.volume_clearing, "0");
  const spread = computeSpread([]);
  assert.equal(spread.spread, null);
  assert.equal(spread.spread_bps, null);
});