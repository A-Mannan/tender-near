import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  ArrowUpRight,
  ChartLineUp,
  SealCheck,
  TrendUp,
  UsersThree,
} from "@phosphor-icons/react";
import { bps, nearAmount, nearFromYocto } from "../lib/format";
import type { MedianStats, PrintView, SpreadStats, WinRateResponse } from "../lib/types";
import { EmptyState } from "./Primitives";

function PanelHeader({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[var(--text-muted)]">{icon}</span>
        <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em]">{title}</h2>
      </div>
      {hint ? <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{hint}</span> : null}
    </div>
  );
}

function CategoryRows({ median }: { median: MedianStats }) {
  const rows = (median.by_category ?? []).filter((row) => row.stats.count > 0);
  const max = useMemo(() => {
    let value = 0n;
    for (const row of rows) {
      const raw = row.stats.median_unit_price;
      if (raw && BigInt(raw) > value) value = BigInt(raw);
    }
    return value;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No category curves yet."
        body="Category medians appear once a settled print carries a category and work units."
      />
    );
  }

  return (
    <div className="divide-y divide-[var(--border-hairline)]">
      {rows.map(({ category, stats }) => {
        const raw = stats.median_unit_price;
        const share = raw && max > 0n ? Number((BigInt(raw) * 10_000n) / max) / 100 : 0;
        return (
          <div key={category} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">{category}</span>
              <span className="numeric shrink-0 text-[12px] font-semibold">
                {nearFromYocto(raw, 5)} NEAR
                <span className="ml-1 font-mono text-[10px] font-normal text-[var(--text-muted)]">
                  /{median.units[0] ?? "unit"}
                </span>
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-[var(--accent-primary)]"
                  style={{ width: `${Math.max(2, share)}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                {stats.count} print{stats.count === 1 ? "" : "s"} · {nearAmount(stats.volume_clearing_near, 3)} NEAR
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SpreadBand({ spread }: { spread: SpreadStats }) {
  const min = spread.min_unit_price_near ? Number(spread.min_unit_price_near) : null;
  const max = spread.max_unit_price_near ? Number(spread.max_unit_price_near) : null;
  const mid = spread.median_unit_price_near ? Number(spread.median_unit_price_near) : null;
  const p25 = spread.p25_unit_price_near ? Number(spread.p25_unit_price_near) : null;
  const p75 = spread.p75_unit_price_near ? Number(spread.p75_unit_price_near) : null;

  if (min === null || max === null || mid === null || min === max) {
    return (
      <div className="px-4 py-4 font-mono text-[11px] text-[var(--text-muted)]">
        A spread band needs at least two distinct unit prices.
      </div>
    );
  }

  const position = (value: number) => `${Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))}%`;

  return (
    <div className="px-4 py-5">
      <div className="relative h-1.5 rounded-full bg-[var(--bg-inset)]" aria-hidden="true">
        {p25 !== null && p75 !== null ? (
          <div
            className="absolute top-0 h-1.5 rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_45%,transparent)]"
            style={{ left: position(p25), width: `calc(${position(p75)} - ${position(p25)})` }}
          />
        ) : null}
        <div
          className="absolute -top-1 h-3.5 w-0.5 rounded bg-[var(--text-primary)]"
          style={{ left: position(mid) }}
        />
      </div>
      <div className="mt-3 flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
        <span>
          p25 {nearAmount(spread.p25_unit_price_near, 4)}
          <span className="ml-1 opacity-70">NEAR</span>
        </span>
        <span className="text-[var(--text-primary)]">
          median {nearAmount(spread.median_unit_price_near, 4)}
        </span>
        <span>
          p75 {nearAmount(spread.p75_unit_price_near, 4)}
          <span className="ml-1 opacity-70">NEAR</span>
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[var(--border-hairline)] pt-3">
        <span className="eyebrow">Band width</span>
        <span className="numeric text-[12px] font-semibold">
          {spread.spread_bps !== null ? `${bps(spread.spread_bps)} of median` : "—"}
        </span>
      </div>
    </div>
  );
}

function WinRateRows({ winRate }: { winRate: WinRateResponse }) {
  if (winRate.items.length === 0) {
    return (
      <EmptyState
        title="No reveal history yet."
        body="Win rates appear after workers reveal sealed bids. Reveals are counted even when a worker loses."
      />
    );
  }
  return (
    <div className="divide-y divide-[var(--border-hairline)]">
      {winRate.items.slice(0, 6).map((row) => (
        <div key={row.worker} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-[var(--text-primary)]" title={row.worker}>
              {row.worker.replace(/\.testnet$|\.near$/, "")}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
              {row.wins}W / {row.reveals - row.wins}L · {nearAmount(row.volume_won_near, 3)} NEAR won
            </div>
          </div>
          <div className="w-24 shrink-0">
            <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden="true">
              <div
                className="h-full rounded-full bg-[var(--accent-primary)]"
                style={{ width: `${Math.max(2, (row.win_rate_bps ?? 0) / 100)}%` }}
              />
            </div>
            <div className="numeric mt-1 text-right text-[11px] font-semibold">{bps(row.win_rate_bps)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SettlementMix({ prints }: { prints: PrintView[] }) {
  const mix = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const print of prints) {
      const key = print.trigger.replaceAll("_", " ");
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  }, [prints]);

  if (prints.length === 0) {
    return <div className="px-4 py-4 font-mono text-[11px] text-[var(--text-muted)]">No settlements yet.</div>;
  }

  return (
    <div className="space-y-3 px-4 py-4">
      {mix.map(([trigger, count]) => (
        <div key={trigger}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-[11px] capitalize text-[var(--text-secondary)]">
              {trigger}
            </span>
            <span className="numeric text-[11px] font-semibold">{count}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden="true">
            <div
              className="h-full rounded-full bg-[var(--accent-primary)]"
              style={{ width: `${(count / prints.length) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Analytics({
  median,
  spread,
  winRate,
  prints,
  loading,
}: {
  median: MedianStats | null;
  spread: SpreadStats | null;
  winRate: WinRateResponse | null;
  prints: PrintView[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className="panel overflow-hidden" aria-label="Market analytics loading">
        <div className="grid divide-y divide-[var(--border-hairline)] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {[0, 1, 2].map((key) => (
            <div key={key} aria-hidden="true">
              <div className="border-b border-[var(--border-hairline)] px-4 py-2.5">
                <div className="skeleton h-3 w-32" />
              </div>
              <div className="space-y-3 px-4 py-4">
                <div className="skeleton h-8 w-full" />
                <div className="skeleton h-8 w-full" />
                <div className="skeleton h-8 w-full" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      className="panel overflow-hidden"
      aria-label="Market analytics"
      data-testid="analytics"
    >
      <div className="grid divide-y divide-[var(--border-hairline)] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <div className="min-w-0">
          <PanelHeader
            icon={<ChartLineUp size={15} />}
            title="Category unit curves"
            hint={median ? `${median.priced_count} priced` : undefined}
          />
          {median ? <CategoryRows median={median} /> : <EmptyState title="No index yet." body="The tape has no settled prints." />}
        </div>

        <div className="min-w-0">
          <PanelHeader
            icon={<TrendUp size={15} />}
            title="Competitive spread"
            hint={spread?.count ? `${spread.count} prints` : undefined}
          />
          {spread && spread.count > 0 ? (
            <SpreadBand spread={spread} />
          ) : (
            <EmptyState
              title="Spread is undefined."
              body="A p25–p75 unit band appears after settled prints with distinct unit rates."
            />
          )}
        </div>

        <div className="min-w-0">
          <PanelHeader icon={<UsersThree size={15} />} title="Agent win rates" hint="revealed bids" />
          {winRate ? (
            <WinRateRows winRate={winRate} />
          ) : (
            <EmptyState title="No agent history." body="Revealed bids build the worker leaderboard." />
          )}
          <div className="border-t border-[var(--border-hairline)]">
            <div className="flex items-center gap-2 px-4 py-2.5">
              <SealCheck size={14} className="text-[var(--text-muted)]" />
              <span className="eyebrow flex-1">Settlement mix</span>
              <ArrowUpRight size={12} className="text-[var(--text-muted)]" />
            </div>
            <SettlementMix prints={prints} />
          </div>
        </div>
      </div>
    </section>
  );
}
