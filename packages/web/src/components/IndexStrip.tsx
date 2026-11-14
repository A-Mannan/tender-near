import { ArrowRight } from "@phosphor-icons/react";
import { bps, nearFromYocto, nearFromYoctoExact, compactNumber } from "../lib/format";
import type { MedianStats, SpreadStats } from "../lib/types";
import { MetricCell } from "./Primitives";

export function IndexStrip({
  median,
  spread,
  loading,
}: {
  median: MedianStats | null;
  spread: SpreadStats | null;
  loading: boolean;
}) {
  const hasPrints = (median?.count ?? 0) > 0;
  return (
    <section aria-label="Consolidated market index" data-testid="index-strip" className="panel metric-grid px-4 md:px-5">
      <MetricCell
        label="Median Clearing Price"
        loading={loading}
        value={hasPrints ? `${nearFromYocto(median?.median_clearing_price, 4)} NEAR` : "Awaiting print"}
        sub={
          hasPrints ? (
            <span title={nearFromYoctoExact(median?.median_clearing_price)}>
              {compactNumber(median?.count)} settled prints
            </span>
          ) : (
            "No settled NEAR-escrowed jobs yet"
          )
        }
      />
      <MetricCell
        label="Median Unit Rate"
        loading={loading}
        value={
          hasPrints && median?.median_unit_price
            ? `${nearFromYocto(median.median_unit_price, 5)} NEAR`
            : "Awaiting print"
        }
        sub={hasPrints ? `per ${median?.units[0] ?? "unit"}` : "Normalized across categories"}
      />
      <MetricCell
        label="Competitive Spread"
        loading={loading}
        value={spread?.spread_bps != null ? bps(spread.spread_bps) : "Awaiting print"}
        sub={
          spread?.spread_near
            ? `${nearFromYocto(spread.spread_near, 4)} NEAR p25–p75 unit band`
            : "Unit-price dispersion"
        }
      />
      <MetricCell
        label="Buyer Vickrey Savings"
        loading={loading}
        value={median?.median_savings_bps != null ? bps(median.median_savings_bps) : "Awaiting print"}
        sub={
          median?.buyer_savings_near
            ? `${nearFromYocto(median.buyer_savings_near, 4)} NEAR below reserve`
            : "Reserve minus clearing"
        }
      />
    </section>
  );
}

const STEPS = ["Escrow Job", "Sealed Commit", "Hash Reveal", "Vickrey Clear", "Deliver & Print"];

export function MissionHeader({
  settledPrints,
  onHowItWorks,
}: {
  settledPrints: number;
  onHowItWorks: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-5 py-1">
      <div>
        <div className="eyebrow">NEAR Protocol · AI labor clearing</div>
        <h1 className="mt-2 max-w-[22ch] text-[28px] font-semibold leading-[1.08] tracking-[-0.03em] md:text-[34px]">
          The public price of AI labor.
        </h1>
        <p className="mt-2.5 max-w-[46ch] text-[13px] leading-relaxed text-[var(--text-secondary)] md:text-[14px]">
          Sealed-bid reverse auctions settle agent work on NEAR, then print every clearing price to one open tape.
        </p>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="Clearing lifecycle">
          {STEPS.map((step, index) => (
            <div key={step} className="lifecycle-step">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg-surface)] font-mono text-[10px] text-[var(--text-secondary)]">
                {index + 1}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                {step}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-sm btn-secondary" onClick={onHowItWorks}>
            How clearing works
            <ArrowRight size={13} />
          </button>
          <span className="font-mono text-[10px] text-[var(--text-muted)]">
            {settledPrints} settled print{settledPrints === 1 ? "" : "s"} · Vickrey & first-price
          </span>
        </div>
      </div>
    </div>
  );
}
