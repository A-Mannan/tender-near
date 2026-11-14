import { ArrowRight } from "@phosphor-icons/react";
import { bps, nearAmount, nearFromYocto, nearFromYoctoExact, compactNumber } from "../lib/format";
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
  const unitScope =
    median && median.units.length === 1
      ? `NEAR per ${median.units[0]}`
      : median && median.units.length > 1
        ? `NEAR / unit · ${median.units.length} types`
        : "Normalized across categories";

  return (
    <section
      aria-label="Consolidated market index"
      data-testid="index-strip"
      className="panel metric-grid overflow-hidden"
    >
      <MetricCell
        accent
        label="Median Clearing Price"
        loading={loading}
        value={hasPrints ? `${nearFromYocto(median?.median_clearing_price, 4)} NEAR` : "Awaiting print"}
        sub={
          hasPrints ? (
            <span title={nearFromYoctoExact(median?.median_clearing_price)}>
              {compactNumber(median?.count)} print{median?.count === 1 ? "" : "s"}
              {median?.volume_clearing_near ? ` · ${nearAmount(median.volume_clearing_near, 3)} NEAR vol` : ""}
            </span>
          ) : (
            "No settled NEAR jobs"
          )
        }
      />
      <MetricCell
        label="Median Unit Rate"
        loading={loading}
        value={
          hasPrints && median?.median_unit_price
            ? nearFromYocto(median.median_unit_price, 3)
            : "Awaiting print"
        }
        tooltip={hasPrints ? `${nearFromYoctoExact(median?.median_unit_price)} NEAR` : undefined}
        sub={hasPrints ? unitScope : "Normalized across categories"}
      />
      <MetricCell
        label="Competitive Spread"
        loading={loading}
        value={spread?.spread_bps != null ? bps(spread.spread_bps) : "Awaiting print"}
        sub={
          spread?.spread_near
            ? `${nearAmount(spread.spread_near, 4)} NEAR p25–p75`
            : "Unit-price dispersion"
        }
      />
      <MetricCell
        label="Buyer Vickrey Savings"
        loading={loading}
        value={median?.median_savings_bps != null ? bps(median.median_savings_bps) : "Awaiting print"}
        sub={
          median?.buyer_savings_near
            ? `${nearAmount(median.buyer_savings_near, 4)} NEAR below reserve`
            : "Reserve minus clearing"
        }
      />
    </section>
  );
}

const STEPS = [
  ["01", "Escrow", "Escrow the reserve"],
  ["02", "Seal", "Seal a SHA-256 bid"],
  ["03", "Reveal", "Reveal the sealed bid"],
  ["04", "Clear", "Clear the auction"],
  ["05", "Print", "Deliver, settle, and print"],
] as const;

export function MissionHeader({
  settledPrints,
  onHowItWorks,
}: {
  settledPrints: number;
  onHowItWorks: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-3.5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow">NEAR Testnet · Sealed-Bid AI Labor Clearinghouse</span>
        </div>
        <h1 className="mt-1 text-[25px] font-semibold leading-[1.08] tracking-[-0.035em] text-[var(--text-primary)] md:text-[29px]">
          The public price of AI labor.
        </h1>
        <p className="mt-1.5 max-w-[54ch] text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">
          Escrowed by humans or agents. Cleared between sealed worker-agent bids. Every verified settlement prints to one receipt-backed tape.
        </p>
      </div>

      <div className="min-w-0">
        <ol className="stage-track" aria-label="Five-stage clearing lifecycle">
          {STEPS.map(([num, label, description]) => (
            <li key={num} className="stage-step" data-state="guide" title={description}>
              <span aria-hidden="true" className="stage-bar" />
              <span className="stage-label normal-case tracking-normal">
                <span className="mr-1 text-[var(--accent-primary)]">{num}</span>
                {label}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <button type="button" className="btn btn-sm btn-secondary" onClick={onHowItWorks}>
            How clearing works
            <ArrowRight size={12} />
          </button>
          <span className="font-mono text-[10px] text-[var(--text-muted)]">
            {settledPrints} settled print{settledPrints === 1 ? "" : "s"} · native NEAR index
          </span>
        </div>
      </div>
    </div>
  );
}
