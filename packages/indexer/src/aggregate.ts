import type { TapePrint } from "./derive.js";
import type { WorkerRevealRow, WorkerWinRow } from "./db.js";

export interface MedianStats {
  count: number;
  priced_count: number;
  median_unit_price: string | null;
  median_clearing_price: string | null;
  median_winning_bid: string | null;
  min_unit_price: string | null;
  max_unit_price: string | null;
  volume_clearing: string;
  buyer_savings: string;
  median_savings_bps: number | null;
  median_worker_premium_bps: number | null;
  units: string[];
  categories: string[];
}

export interface SpreadStats {
  count: number;
  min_unit_price: string | null;
  max_unit_price: string | null;
  p25_unit_price: string | null;
  p75_unit_price: string | null;
  median_unit_price: string | null;
  spread: string | null;
  spread_bps: number | null;
  units: string[];
}

export interface WinRateRow {
  worker: string;
  wins: number;
  reveals: number;
  win_rate_bps: number;
  volume_won: string;
}

function toBigInt(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Exact integer median. Even-sized sets return `floor((a + b) / 2)`. */
export function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2n;
}

/** Nearest-rank percentile (`p` in 0..100) over ascending data. */
export function percentile(values: readonly bigint[], p: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

export function computeMedianStats(prints: readonly TapePrint[]): MedianStats {
  const unitPrices: bigint[] = [];
  const clearingPrices: bigint[] = [];
  const winningBids: bigint[] = [];
  const savingsBps: bigint[] = [];
  const premiumBps: bigint[] = [];
  let volume = 0n;
  let savings = 0n;

  for (const print of prints) {
    const unit = toBigInt(print.unit_price);
    const clearing = toBigInt(print.clearing_price);
    const winning = toBigInt(print.winning_bid);
    const reserve = toBigInt(print.reserve_price);
    if (unit !== null) unitPrices.push(unit);
    if (clearing !== null) clearingPrices.push(clearing);
    if (winning !== null) winningBids.push(winning);
    if (clearing !== null) volume += clearing;
    if (reserve !== null && clearing !== null && reserve > clearing) savings += reserve - clearing;
    savingsBps.push(BigInt(print.savings_bps));
    premiumBps.push(BigInt(print.worker_premium_bps));
  }

  const medianSavings = median(savingsBps);
  const medianPremium = median(premiumBps);

  return {
    count: prints.length,
    priced_count: unitPrices.length,
    median_unit_price: median(unitPrices)?.toString() ?? null,
    median_clearing_price: median(clearingPrices)?.toString() ?? null,
    median_winning_bid: median(winningBids)?.toString() ?? null,
    min_unit_price: percentile(unitPrices, 0)?.toString() ?? null,
    max_unit_price: percentile(unitPrices, 100)?.toString() ?? null,
    volume_clearing: volume.toString(),
    buyer_savings: savings.toString(),
    median_savings_bps: medianSavings === null ? null : Number(medianSavings),
    median_worker_premium_bps: medianPremium === null ? null : Number(medianPremium),
    units: unique(prints.map((print) => print.unit_label)),
    categories: unique(prints.map((print) => print.category)),
  };
}

export function computeSpread(prints: readonly TapePrint[]): SpreadStats {
  const unitPrices: bigint[] = [];
  for (const print of prints) {
    const unit = toBigInt(print.unit_price);
    if (unit !== null) unitPrices.push(unit);
  }
  const min = percentile(unitPrices, 0);
  const max = percentile(unitPrices, 100);
  const p25 = percentile(unitPrices, 25);
  const p75 = percentile(unitPrices, 75);
  const med = median(unitPrices);
  const spread = min !== null && max !== null ? max - min : null;
  const spreadBps =
    spread !== null && med !== null && med > 0n ? Number((spread * 10_000n) / med) : null;

  return {
    count: prints.length,
    min_unit_price: min?.toString() ?? null,
    max_unit_price: max?.toString() ?? null,
    p25_unit_price: p25?.toString() ?? null,
    p75_unit_price: p75?.toString() ?? null,
    median_unit_price: med?.toString() ?? null,
    spread: spread?.toString() ?? null,
    spread_bps: spreadBps,
    units: unique(prints.map((print) => print.unit_label)),
  };
}

export function computeWinRates(
  reveals: readonly WorkerRevealRow[],
  wins: readonly WorkerWinRow[],
): WinRateRow[] {
  const winMap = new Map(wins.map((row) => [row.winner, row]));
  const revealMap = new Map(reveals.map((row) => [row.worker, row.reveals]));
  const workers = new Set<string>([...revealMap.keys(), ...winMap.keys()]);

  const rows: WinRateRow[] = [];
  for (const worker of workers) {
    const winRow = winMap.get(worker);
    const winCount = winRow?.wins ?? 0;
    const revealCount = revealMap.get(worker) ?? 0;
    const rate = revealCount > 0 ? Math.min(10_000, Math.floor((winCount * 10_000) / revealCount)) : 0;
    rows.push({
      worker,
      wins: winCount,
      reveals: revealCount,
      win_rate_bps: rate,
      volume_won: winRow?.volume_won ?? "0",
    });
  }

  return rows.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.win_rate_bps - a.win_rate_bps ||
      Number(BigInt(b.volume_won) - BigInt(a.volume_won)),
  );
}

export function groupByCategory(prints: readonly TapePrint[]): Array<{ category: string; stats: MedianStats }> {
  const groups = new Map<string, TapePrint[]>();
  for (const print of prints) {
    if (!print.category) continue;
    const list = groups.get(print.category) ?? [];
    list.push(print);
    groups.set(print.category, list);
  }
  return [...groups.entries()]
    .map(([category, items]) => ({ category, stats: computeMedianStats(items) }))
    .sort((a, b) => b.stats.count - a.stats.count || a.category.localeCompare(b.category));
}

/** Format raw 24-decimal NEAR units without floating point loss. */
export function formatNear(yocto: string): string {
  const value = BigInt(yocto);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10n ** 24n;
  const fraction = (absolute % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${rendered}` : rendered;
}

export function formatBps(value: number | null): string | null {
  if (value === null) return null;
  return `${(value / 100).toFixed(2)}%`;
}