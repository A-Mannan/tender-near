import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  Check,
  Copy,
  FileMagnifyingGlass,
  SealCheck,
  X,
} from "@phosphor-icons/react";
import {
  bps,
  hashShort,
  mechanismLabel,
  nearFromYocto,
  timestampShort,
  timestampUtc,
} from "../lib/format";
import type { PrintView } from "../lib/types";
import { EmptyState, SkeletonRows } from "./Primitives";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
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
      {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ProofField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-[var(--border-hairline)] py-2.5 last:border-b-0">
      <div className="eyebrow pt-0.5">{label}</div>
      <div className={`min-w-0 text-[12px] text-[var(--text-primary)] ${mono ? "font-mono hash" : ""}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function PrintProof({ print, onClose }: { print: PrintView; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Print proof for job ${print.job_id}`} data-testid="print-proof">
      <button type="button" className="drawer-backdrop" aria-label="Close proof" onClick={onClose} />
      <aside className="drawer-panel scroll-thin">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-5 py-4">
          <div>
            <div className="eyebrow">Settlement proof</div>
            <div className="mt-0.5 text-[16px] font-semibold">Print #{print.job_id}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close proof drawer">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill pill-good">
              <SealCheck size={12} weight="bold" /> Settled
            </span>
            <span className="pill">{mechanismLabel(print.mechanism)}</span>
            <span className="pill">{print.trigger.replaceAll("_", " ")}</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="panel-elevated px-3 py-2.5">
              <div className="eyebrow">Clearing price</div>
              <div className="numeric mt-1 text-[18px] font-semibold">{nearFromYocto(print.clearing_price.raw, 5)} NEAR</div>
            </div>
            <div className="panel-elevated px-3 py-2.5">
              <div className="eyebrow">Unit rate</div>
              <div className="numeric mt-1 text-[18px] font-semibold">{nearFromYocto(print.unit_price.raw, 5)} NEAR</div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">per {print.unit_label}</div>
            </div>
          </div>

          <div className="mt-5">
            <div className="eyebrow mb-1.5">Market economics</div>
            <div className="panel-elevated px-3">
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
            <div className="eyebrow mb-1.5">Work & participants</div>
            <div className="panel-elevated px-3">
              <ProofField label="Title" value={print.title} mono={false} />
              <ProofField label="Category" value={print.category} />
              <ProofField label="Work units" value={`${print.work_units} ${print.unit_label}`} />
              <ProofField
                label="Bids"
                value={`${print.commit_count} committed · ${print.reveal_count} revealed`}
              />
              <ProofField label="Buyer" value={print.buyer} />
              <ProofField label="Winner" value={print.winner} />
              <ProofField label="Escrow" value={print.escrow.kind === "near" ? "Native NEAR" : `FT ${print.escrow.token_id}`} />
              <ProofField label="Deliverable" value={print.deliverable_uri} />
            </div>
          </div>

          <div className="mt-5">
            <div className="eyebrow mb-1.5">On-chain proof</div>
            <div className="panel-elevated px-3">
              <ProofField label="Settled" value={timestampUtc(print.settled_at_ns)} mono={false} />
              <ProofField label="Block" value={print.block_height.toLocaleString("en-US")} />
              <ProofField label="Tx hash" value={print.tx_hash ?? "—"} />
              <ProofField label="Receipt" value={print.receipt_id} />
              <ProofField label="Spec SHA-256" value={print.spec_sha256} />
              <ProofField label="Deliverable SHA-256" value={print.deliverable_sha256} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {print.tx_hash ? <CopyButton value={print.tx_hash} label="transaction hash" /> : null}
            <CopyButton value={print.receipt_id} label="receipt id" />
            {print.explorer_url ? (
              <a className="btn btn-sm btn-secondary" href={print.explorer_url} target="_blank" rel="noreferrer">
                <ArrowSquareOut size={14} /> Nearblocks
              </a>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

function PrintRow({ print, onOpen }: { print: PrintView; onOpen: () => void }) {
  const savings = print.savings_bps;
  return (
    <>
      {/* Desktop table row */}
      <tr data-testid="tape-row" className="group hidden border-t border-[var(--border-hairline)] align-top transition-colors hover:bg-[var(--bg-elevated)] md:table-row">
        <td className="px-4 py-3.5">
          <div className="flex items-baseline gap-2">
            <span className="numeric text-[13px] font-semibold">#{print.job_id}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">{timestampShort(print.settled_at_ns)}</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">blk {print.block_height.toLocaleString("en-US")}</div>
        </td>
        <td className="max-w-[280px] px-4 py-3.5">
          <div className="truncate text-[13px] font-medium text-[var(--text-primary)]" title={print.title}>
            {print.title}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="pill">{print.category}</span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {print.work_units} {print.unit_label}
            </span>
          </div>
        </td>
        <td className="px-4 py-3.5 text-right">
          <div className="numeric text-[14px] font-semibold">{nearFromYocto(print.clearing_price.raw, 4)} NEAR</div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {nearFromYocto(print.unit_price.raw, 4)} / {print.unit_label}
          </div>
        </td>
        <td className="px-4 py-3.5 text-right">
          <div className="numeric text-[12px] text-[var(--text-secondary)]">
            {nearFromYocto(print.winning_bid.raw, 3)} → {print.runner_up_bid.raw ? nearFromYocto(print.runner_up_bid.raw, 3) : "single"}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--accent-primary)]">
            {savings !== null ? `${bps(savings)} saved` : "—"}
          </div>
        </td>
        <td className="px-4 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]" title={print.winner}>
                {hashShort(print.winner, 8, 6)}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">{mechanismLabel(print.mechanism)}</div>
            </div>
            <button
              type="button"
              className="icon-btn h-7 w-7 shrink-0"
              onClick={onOpen}
              aria-label={`Open proof for print ${print.job_id}`}
            >
              <FileMagnifyingGlass size={14} />
            </button>
          </div>
        </td>
      </tr>

      {/* Mobile card */}
      <tr data-testid="tape-card" className="border-t border-[var(--border-hairline)] md:hidden">
        <td className="p-0">
          <button type="button" className="block w-full px-4 py-3.5 text-left" onClick={onOpen}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="numeric text-[13px] font-semibold">#{print.job_id}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">{timestampShort(print.settled_at_ns)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] font-medium">{print.title}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="numeric text-[14px] font-semibold">{nearFromYocto(print.clearing_price.raw, 4)}</div>
                <div className="font-mono text-[10px] text-[var(--text-muted)]">NEAR</div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="pill">{print.category}</span>
              <span className="pill pill-good">{savings !== null ? `${bps(savings)} saved` : "settled"}</span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">{mechanismLabel(print.mechanism)}</span>
              <CaretDown size={12} className="ml-auto text-[var(--text-muted)]" />
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
  const [proof, setProof] = useState<PrintView | null>(null);

  const filtered = useMemo(
    () =>
      prints.filter(
        (print) =>
          (category === "all" || print.category === category) &&
          (mechanism === "all" || print.mechanism === mechanism),
      ),
    [prints, category, mechanism],
  );

  const categoryOptions = useMemo(
    () => ["all", ...Array.from(new Set([...categories, ...prints.map((print) => print.category)])).sort()],
    [categories, prints],
  );

  return (
    <section aria-label="Consolidated settled tape" data-testid="tape" className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-4 py-3">
        <div>
          <div className="eyebrow">The Tape</div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-[-0.01em]">Settled clearing prints</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--text-muted)]">{filtered.length} / {prints.length}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onPostJob}>
            Add print
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-hairline)] px-4 py-2.5">
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
        <span className="mx-1 hidden h-4 w-px bg-[var(--border-hairline)] sm:block" />
        {([
          ["all", "All mechanisms"],
          ["VickreySecondPrice", "Vickrey"],
          ["FirstPrice", "First-price"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="filter-pill"
            aria-pressed={mechanism === value}
            onClick={() => setMechanism(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        prints.length === 0 ? (
          <EmptyState
            title="No settled prints yet."
            body="Post an escrowed job, run a sealed-bid auction, and the first clearing print appears here from real on-chain settlement."
            action={
              <button type="button" className="btn btn-sm btn-primary mt-2" onClick={onPostJob}>
                Post the first job
              </button>
            }
          />
        ) : (
          <EmptyState
            title="No prints match these filters."
            body="Clear the category or mechanism filter to see the rest of the tape."
            action={
              <button
                type="button"
                className="btn btn-sm btn-secondary mt-2"
                onClick={() => {
                  setCategory("all");
                  setMechanism("all");
                }}
              >
                Clear filters
              </button>
            }
          />
        )
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-left md:min-w-[640px]">
            <thead className="hidden md:table-header-group">
              <tr className="bg-[var(--bg-elevated)]">
                {["Print / Block", "Work", "Clearing", "Bid band", "Winner / Proof"].map((label, index) => (
                  <th
                    key={label}
                    scope="col"
                    className={`eyebrow px-4 py-2 font-medium ${index >= 2 ? "text-right" : ""} ${index === 4 ? "!text-left" : ""}`}
                  >
                    {label}
                  </th>
                ))}
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

      {proof ? <PrintProof print={proof} onClose={() => setProof(null)} /> : null}
    </section>
  );
}
