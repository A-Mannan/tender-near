import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  Check,
  Copy,
  FileMagnifyingGlass,
  MagnifyingGlass,
  SealCheck,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import {
  bps,
  hashShort,
  mechanismLabel,
  nearAmount,
  nearFromYocto,
  nearFromYoctoExact,
  timestampShort,
  timestampUtc,
} from "../lib/format";
import type { PrintView } from "../lib/types";
import { EmptyState, SkeletonRows } from "./Primitives";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ratioPercent(partRaw: string | null | undefined, wholeRaw: string | null | undefined): number {
  if (!partRaw || !wholeRaw) return 0;
  try {
    const part = BigInt(partRaw);
    const whole = BigInt(wholeRaw);
    if (whole <= 0n || part <= 0n) return 0;
    if (part >= whole) return 100;
    return Number((part * 10_000n) / whole) / 100;
  } catch {
    return 0;
  }
}

function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string;
  label: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={compact ? "btn btn-sm btn-ghost px-1.5 py-0.5 text-[10.5px]" : "btn btn-sm btn-secondary"}
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_400);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "Copied" : compact ? "Copy" : `Copy ${label}`}
    </button>
  );
}

function ProofField({
  label,
  value,
  mono = true,
  copyLabel,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyLabel?: string;
}) {
  const canCopy = Boolean(copyLabel && value && value !== "—");
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-3 border-b border-[var(--border-hairline)] py-2.5 last:border-b-0">
      <div className="eyebrow pt-1">{label}</div>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className={`min-w-0 pt-0.5 text-[12px] text-[var(--text-primary)] ${mono ? "font-mono hash" : ""}`}>
          {value || "—"}
        </div>
        {canCopy ? <CopyButton value={value} label={copyLabel!} compact /> : null}
      </div>
    </div>
  );
}

function ClearingGeometryCard({ print }: { print: PrintView }) {
  const winPct = ratioPercent(print.winning_bid.raw, print.reserve_price.raw);
  const clrPct = ratioPercent(print.clearing_price.raw, print.reserve_price.raw);
  const rnrPct = print.runner_up_bid.raw
    ? ratioPercent(print.runner_up_bid.raw, print.reserve_price.raw)
    : null;

  return (
    <div className="panel-elevated mt-4 p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="eyebrow">Clearing geometry (0 → reserve)</span>
        <span className="font-mono text-[10px] text-[var(--accent-primary)]">
          {print.savings_bps !== null ? `${bps(print.savings_bps)} below reserve` : "settled"}
        </span>
      </div>

      <div className="relative mt-3 h-2.5 overflow-hidden rounded-[2px] bg-[var(--bg-inset)]" aria-hidden="true">
        <div
          className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--accent-primary)_26%,transparent)]"
          style={{ width: `${Math.max(2, clrPct)}%` }}
        />
        <div
          className="absolute inset-y-0 w-[2px] bg-[var(--status-commit)]"
          style={{ left: `calc(${Math.min(99.5, Math.max(0.5, winPct))}% - 1px)` }}
          title="Winning bid"
        />
        <div
          className="absolute inset-y-0 w-[2.5px] bg-[var(--accent-primary)]"
          style={{ left: `calc(${Math.min(99.5, Math.max(0.5, clrPct))}% - 1px)` }}
          title="Clearing price"
        />
        {rnrPct !== null ? (
          <div
            className="absolute inset-y-0 w-[2px] bg-[var(--text-muted)]"
            style={{ left: `calc(${Math.min(99.5, Math.max(0.5, rnrPct))}% - 1px)` }}
            title="Runner-up bid"
          />
        ) : null}
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div>
          <div className="text-[var(--text-muted)]">Win bid</div>
          <div className="numeric font-semibold text-[var(--text-primary)]">
            {nearFromYocto(print.winning_bid.raw, 4)} NEAR
          </div>
        </div>
        <div className="text-center">
          <div className="text-[var(--accent-primary)]">Cleared</div>
          <div className="numeric font-semibold text-[var(--accent-primary)]">
            {nearFromYocto(print.clearing_price.raw, 4)} NEAR
          </div>
        </div>
        <div className="text-right">
          <div className="text-[var(--text-muted)]">Reserve cap</div>
          <div className="numeric font-semibold text-[var(--text-primary)]">
            {nearFromYocto(print.reserve_price.raw, 4)} NEAR
          </div>
        </div>
      </div>
    </div>
  );
}

function PrintProof({ print, onClose }: { print: PrintView; onClose: () => void }) {
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab" && asideRef.current) {
        const nodes = Array.from(asideRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === asideRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    asideRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`Print proof for job ${print.job_id}`}
      data-testid="print-proof"
    >
      <button type="button" className="drawer-backdrop" aria-label="Close proof" tabIndex={-1} onClick={onClose} />
      <aside ref={asideRef} tabIndex={-1} className="drawer-panel scroll-thin">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-5 py-3.5">
          <div>
            <div className="eyebrow">Settlement proof · NEP-297</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="numeric text-[16px] font-semibold">Print #{print.job_id}</span>
              <span className="font-mono text-[11px] text-[var(--text-muted)]">
                blk {print.block_height.toLocaleString("en-US")}
              </span>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close proof drawer">
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="pill pill-good">
              <SealCheck size={12} weight="bold" /> Settled
            </span>
            <span className="pill">{mechanismLabel(print.mechanism)}</span>
            <span className="pill">{print.trigger.replaceAll("_", " ")}</span>
            <span className="pill">
              {print.escrow.kind === "near" ? "Native NEAR" : `FT ${print.escrow.token_id}`}
            </span>
          </div>

          <div className="mt-3.5 grid grid-cols-2 gap-3">
            <div className="panel-elevated px-3.5 py-2.5">
              <div className="eyebrow">Clearing price</div>
              <div
                className="numeric mt-1 text-[19px] font-semibold text-[var(--text-primary)]"
                title={`${nearFromYoctoExact(print.clearing_price.raw)} NEAR`}
              >
                {nearFromYocto(print.clearing_price.raw, 5)} NEAR
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--accent-primary)]">
                {print.surplus_refunded.raw
                  ? `${nearFromYocto(print.surplus_refunded.raw, 4)} NEAR refunded`
                  : "exact reserve"}
              </div>
            </div>
            <div className="panel-elevated px-3.5 py-2.5">
              <div className="eyebrow">Normalized unit rate</div>
              <div
                className="numeric mt-1 text-[19px] font-semibold text-[var(--text-primary)]"
                title={`${nearFromYoctoExact(print.unit_price.raw)} NEAR`}
              >
                {nearFromYocto(print.unit_price.raw, 5)} NEAR
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                per {print.unit_label} ({print.work_units} total)
              </div>
            </div>
          </div>

          <ClearingGeometryCard print={print} />

          <div className="mt-5">
            <div className="eyebrow mb-1.5">Market economics</div>
            <div className="panel-elevated px-3.5">
              <ProofField label="Reserve" value={`${nearFromYocto(print.reserve_price.raw, 5)} NEAR`} />
              <ProofField label="Winning bid" value={`${nearFromYocto(print.winning_bid.raw, 5)} NEAR`} />
              <ProofField
                label="Runner-up"
                value={print.runner_up_bid.raw ? `${nearFromYocto(print.runner_up_bid.raw, 5)} NEAR` : "Single reveal"}
              />
              <ProofField label="Surplus" value={`${nearFromYocto(print.surplus_refunded.raw, 5)} NEAR refunded`} />
              <ProofField label="Buyer saved" value={bps(print.savings_bps)} />
              <ProofField label="Worker premium" value={bps(print.worker_premium_bps)} />
            </div>
          </div>

          <div className="mt-5">
            <div className="eyebrow mb-1.5">Work &amp; participants</div>
            <div className="panel-elevated px-3.5">
              <ProofField label="Title" value={print.title} mono={false} />
              <ProofField label="Category" value={print.category} />
              <ProofField label="Work units" value={`${print.work_units} ${print.unit_label}`} />
              <ProofField label="Sealed bids" value={`${print.commit_count} committed · ${print.reveal_count} revealed`} />
              <ProofField label="Buyer" value={print.buyer} copyLabel="buyer account" />
              <ProofField label="Winner" value={print.winner} copyLabel="winner account" />
              <ProofField label="Deliverable" value={print.deliverable_uri} copyLabel="deliverable URI" />
            </div>
          </div>

          <div className="mt-5">
            <div className="eyebrow mb-1.5">On-chain proof</div>
            <div className="panel-elevated px-3.5">
              <ProofField label="Settled" value={timestampUtc(print.settled_at_ns)} mono={false} />
              <ProofField label="Block" value={print.block_height.toLocaleString("en-US")} />
              <ProofField label="Tx hash" value={print.tx_hash ?? "—"} copyLabel="transaction hash" />
              <ProofField label="Receipt" value={print.receipt_id} copyLabel="receipt id" />
              <ProofField label="Spec SHA-256" value={print.spec_sha256} copyLabel="spec sha256" />
              <ProofField label="Deliverable SHA-256" value={print.deliverable_sha256} copyLabel="deliverable sha256" />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-hairline)] pt-4">
            {print.explorer_url ? (
              <a className="btn btn-sm btn-primary" href={print.explorer_url} target="_blank" rel="noreferrer">
                Verify on Nearblocks
                <ArrowSquareOut size={13} />
              </a>
            ) : null}
            {print.tx_hash ? <CopyButton value={print.tx_hash} label="tx hash" /> : null}
            <CopyButton value={print.receipt_id} label="receipt" />
          </div>
        </div>
      </aside>
    </div>
  );
}

function PrintRow({ print, onOpen }: { print: PrintView; onOpen: () => void }) {
  const savings = print.savings_bps;
  const clrPct = ratioPercent(print.clearing_price.raw, print.reserve_price.raw);
  const winPct = ratioPercent(print.winning_bid.raw, print.reserve_price.raw);

  return (
    <>
      {/* Desktop table row */}
      <tr
        data-testid="tape-row"
        className="tape-tr group hidden border-t border-[var(--border-hairline)] align-middle md:table-row"
      >
        <td className="whitespace-nowrap px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="numeric text-[13px] font-semibold text-[var(--text-primary)]">#{print.job_id}</span>
            <span className="numeric font-mono text-[10px] text-[var(--text-muted)]">
              {timestampShort(print.settled_at_ns)}
            </span>
          </div>
          <div className="numeric mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            blk {print.block_height.toLocaleString("en-US")}
          </div>
        </td>

        <td className="max-w-[250px] px-3.5 py-3">
          <div className="truncate text-[13px] font-medium text-[var(--text-primary)]" title={print.title}>
            {print.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="pill">{print.category}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {print.work_units} {print.unit_label}
            </span>
          </div>
        </td>

        <td className="whitespace-nowrap px-3.5 py-3 text-right">
          <div
            className="numeric text-[14px] font-semibold text-[var(--text-primary)]"
            title={`${nearFromYoctoExact(print.clearing_price.raw)} NEAR`}
          >
            {nearFromYocto(print.clearing_price.raw, 4)} NEAR
          </div>
          <div className="numeric mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {nearFromYocto(print.unit_price.raw, 4)} / {print.unit_label}
          </div>
        </td>

        <td className="whitespace-nowrap px-3.5 py-3 text-right">
          <div className="numeric font-mono text-[11px] text-[var(--text-secondary)]">
            {nearFromYocto(print.winning_bid.raw, 3)} →{" "}
            {print.runner_up_bid.raw ? nearFromYocto(print.runner_up_bid.raw, 3) : "single"}
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">
              / {nearFromYocto(print.reserve_price.raw, 2)}
            </span>
          </div>
          <div className="ml-auto mt-1 flex w-28 items-center gap-1.5" aria-hidden="true">
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-[2px] bg-[var(--bg-inset)]">
              <div
                className="absolute inset-y-0 left-0 bg-[var(--accent-primary)]"
                style={{ width: `${Math.max(4, clrPct)}%` }}
              />
              <div
                className="absolute inset-y-0 w-[1.5px] bg-[var(--text-primary)]"
                style={{ left: `${Math.min(98, Math.max(1, winPct))}%` }}
              />
            </div>
          </div>
          <div className="numeric mt-0.5 font-mono text-[10px] font-medium text-[var(--accent-primary)]">
            {savings !== null ? `${bps(savings)} saved` : "0.00% saved"}
          </div>
        </td>

        <td className="whitespace-nowrap px-3.5 py-3">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] text-[var(--text-primary)]" title={print.winner}>
                {hashShort(print.winner, 10, 7)}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                {mechanismLabel(print.mechanism)} · {print.reveal_count}/{print.commit_count} rev
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary shrink-0 px-2 py-1"
              onClick={onOpen}
              aria-label={`Open proof for print ${print.job_id}`}
            >
              <FileMagnifyingGlass size={13} />
              <span>Proof</span>
            </button>
          </div>
        </td>
      </tr>

      {/* Mobile structured card (single button inside tr[data-testid="tape-card"] for clean mobile tap & E2E) */}
      <tr data-testid="tape-card" className="border-t border-[var(--border-hairline)] md:hidden">
        <td className="p-0">
          <button
            type="button"
            className="block w-full px-3.5 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)]"
            onClick={onOpen}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="numeric text-[13px] font-semibold text-[var(--text-primary)]">#{print.job_id}</span>
                  <span className="numeric font-mono text-[10px] text-[var(--text-muted)]">
                    {timestampShort(print.settled_at_ns)}
                  </span>
                  <span className="numeric font-mono text-[10px] text-[var(--text-muted)]">
                    · blk {print.block_height.toLocaleString("en-US")}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] font-medium text-[var(--text-primary)]">{print.title}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="numeric text-[14px] font-semibold text-[var(--text-primary)]">
                  {nearFromYocto(print.clearing_price.raw, 4)} NEAR
                </div>
                <div className="numeric font-mono text-[10px] text-[var(--text-muted)]">
                  {nearFromYocto(print.unit_price.raw, 3)} / {print.unit_label}
                </div>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="pill">{print.category}</span>
              <span className="pill pill-good">{savings !== null ? `${bps(savings)} saved` : "settled"}</span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">{mechanismLabel(print.mechanism)}</span>
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold text-[var(--accent-primary)]">
                Proof <ArrowRight size={11} />
              </span>
            </div>
          </button>
        </td>
      </tr>
    </>
  );
}

export function Tape({
  prints,
  loading,
  categories,
  onPostJob,
}: {
  prints: PrintView[];
  loading: boolean;
  categories: string[];
  onPostJob: () => void;
}) {
  const [category, setCategory] = useState("all");
  const [mechanism, setMechanism] = useState("all");
  const [query, setQuery] = useState("");
  const [proof, setProof] = useState<PrintView | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prints.filter((print) => {
      if (category !== "all" && print.category !== category) return false;
      if (mechanism !== "all" && print.mechanism !== mechanism) return false;
      if (!needle) return true;
      return [
        print.job_id,
        print.title,
        print.category,
        print.buyer,
        print.winner,
        print.tx_hash ?? "",
        print.receipt_id,
        print.unit_label,
        String(print.block_height),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [prints, category, mechanism, query]);

  const categoryOptions = useMemo(
    () => ["all", ...Array.from(new Set([...categories, ...prints.map((print) => print.category)])).sort()],
    [categories, prints],
  );

  const totalClearedYocto = useMemo(() => {
    let sum = 0n;
    for (const print of filtered) {
      if (print.escrow.kind === "near" && print.clearing_price.raw) {
        try {
          sum += BigInt(print.clearing_price.raw);
        } catch {
          // ignore malformed yocto
        }
      }
    }
    return sum;
  }, [filtered]);

  return (
    <section aria-label="Consolidated settled tape" data-testid="tape" className="panel flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <div>
            <div className="eyebrow">The Tape · NEP-297 Index</div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-[-0.015em]">Settled clearing prints</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="numeric rounded-[3px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--text-secondary)]">
            {filtered.length} / {prints.length} prints
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onPostJob}>
            Add print
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3.5 py-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="tape-search mr-1">
            <label className="sr-only" htmlFor="print-search">
              Find a settled print
            </label>
            <MagnifyingGlass size={12} aria-hidden="true" className="tape-search-icon" />
            <input
              id="print-search"
              type="search"
              className="input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find job, account, tx…"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="tape-search-clear"
                aria-label="Clear print search"
                onClick={() => setQuery("")}
              >
                <X size={11} />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by category">
            {categoryOptions.map((option) => (
              <button
                key={option}
                type="button"
                className="filter-pill"
                aria-pressed={category === option}
                onClick={() => setCategory(option)}
              >
                {option === "all" ? "All categories" : option}
              </button>
            ))}
          </div>
        </div>

        <div className="seg-group self-start lg:self-auto" role="group" aria-label="Filter by mechanism">
          {(
            [
              ["all", "All mechanisms"],
              ["VickreySecondPrice", "Vickrey"],
              ["FirstPrice", "First-price"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="seg-btn"
              aria-pressed={mechanism === value}
              onClick={() => setMechanism(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        prints.length === 0 ? (
          <EmptyState
            eyebrow="Zero Prints"
            title="No settled prints yet."
            body="Post an escrowed job, run a sealed-bid auction, and the first clearing print appears here from real on-chain settlement."
            action={
              <button type="button" className="btn btn-sm btn-primary" onClick={onPostJob}>
                Post the first job
              </button>
            }
          />
        ) : (
          <EmptyState
            eyebrow="Filtered View"
            title="No prints match these filters."
            body="Clear the search, category, or mechanism filters to restore settled prints on the tape."
            action={
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setCategory("all");
                  setMechanism("all");
                  setQuery("");
                }}
              >
                Clear filters
              </button>
            }
          />
        )
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-left md:min-w-[660px]">
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                <th scope="col" className="eyebrow px-3.5 py-2 font-semibold">
                  Print / Block
                </th>
                <th scope="col" className="eyebrow px-3.5 py-2 font-semibold">
                  Job &amp; Scope
                </th>
                <th scope="col" className="eyebrow px-3.5 py-2 text-right font-semibold">
                  Clearing Price
                </th>
                <th scope="col" className="eyebrow px-3.5 py-2 text-right font-semibold">
                  Win → 2nd / Cap
                </th>
                <th scope="col" className="eyebrow px-3.5 py-2 font-semibold">
                  Winner &amp; Proof
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((print) => (
                <PrintRow key={print.id} print={print} onOpen={() => setProof(print)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2 font-mono text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-[var(--accent-primary)]" />
          Every print is derived from finalized NEAR receipts (native NEAR escrow)
        </span>
        <span className="numeric text-[var(--text-secondary)]">
          {filtered.length > 0
            ? `shown volume ${nearAmount(nearFromYoctoExact(totalClearedYocto.toString()), 4)} NEAR`
            : "0 NEAR shown"}
        </span>
      </div>

      {proof ? <PrintProof print={proof} onClose={() => setProof(null)} /> : null}
    </section>
  );
}
