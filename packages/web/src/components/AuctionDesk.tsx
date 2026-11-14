import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  Clock,
  FileArrowUp,
  Gavel,
  LockKey,
  Scales,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { CONTRACT_ID, NEAR_NETWORK } from "../lib/api";
import {
  bps,
  computePhase,
  countdown,
  hashShort,
  humanDuration,
  mechanismLabel,
  nearFromYocto,
  nearFromYoctoExact,
  phaseLabel,
  secondsUntil,
  statusTone,
  timestampShort,
} from "../lib/format";
import {
  buildCommitPreimage,
  executeCall,
  nearToYocto,
  randomSaltHex,
  sha256Hex,
  yoctoToNearInput,
  type Signer,
} from "../lib/near";
import type { JobView } from "../lib/types";
import { Dialog, Field, TxLink } from "./Dialog";
import { EmptyState, SkeletonRows, StatusPill } from "./Primitives";

type ActionMode = "bid" | "reveal" | "deliver" | "accept" | "dispute" | "resolve" | "timeout" | "finalize";
type StageState = "done" | "active" | "active-warn" | "settled" | "halted" | "idle";
type DeskFilter = "all" | "active" | "terminal";

interface SealedBid {
  bid: string;
  etaSeconds: string;
  salt: string;
  commitHash: string;
  savedAt: number;
}

const TERMINAL_STATUSES = new Set(["Settled", "Refunded", "CancelledZeroReveals", "ExpiredNoDelivery"]);
const STAGE_LABELS = ["Escrow", "Seal", "Reveal", "Clear", "Print"] as const;

const sealKey = (jobId: string, accountId: string) =>
  `tender.seal.${CONTRACT_ID}.${jobId}.${accountId}`;

function readSeal(jobId: string, accountId: string): SealedBid | null {
  try {
    const raw = window.localStorage.getItem(sealKey(jobId, accountId));
    return raw ? (JSON.parse(raw) as SealedBid) : null;
  } catch {
    return null;
  }
}

function stageStatesFor(status: string, phase: string): [StageState, StageState, StageState, StageState, StageState] {
  if (status === "Settled") {
    return ["settled", "settled", "settled", "settled", "settled"];
  }
  if (status === "CancelledZeroReveals") {
    return ["done", "done", "halted", "idle", "idle"];
  }
  if (status === "ExpiredNoDelivery" || status === "Refunded") {
    return ["done", "done", "done", "halted", "idle"];
  }
  if (status === "Disputed" || phase === "DisputeResolutionExpired") {
    return ["done", "done", "done", "done", "halted"];
  }
  if (status === "Delivered" || phase === "ReadyAutoSettle") {
    return ["done", "done", "done", "done", "active-warn"];
  }
  if (status === "Assigned") {
    return phase === "DeliveryExpired"
      ? ["done", "done", "done", "halted", "idle"]
      : ["done", "done", "done", "active", "idle"];
  }
  if (phase === "CommitOpen") {
    return ["done", "active", "idle", "idle", "idle"];
  }
  if (phase === "RevealOpen") {
    return ["done", "done", "active-warn", "idle", "idle"];
  }
  return ["done", "done", "done", "active-warn", "idle"];
}

function JobStageRail({ status, phase }: { status: string; phase: string }) {
  const states = stageStatesFor(status, phase);
  return (
    <div className="stage-track mt-2.5" aria-label={`Lifecycle stage: ${phaseLabel(phase)}`}>
      {STAGE_LABELS.map((label, idx) => (
        <div key={label} className="stage-step" data-state={states[idx]}>
          <div className="stage-bar" />
          <span className="stage-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

const ACTION_COPY: Record<ActionMode, { title: string; eyebrow: string; submit: string }> = {
  bid: { title: "Commit a sealed bid", eyebrow: "Step 1 of 2 · Commit", submit: "Commit sealed bid" },
  reveal: { title: "Reveal your bid", eyebrow: "Step 2 of 2 · Reveal", submit: "Reveal bid" },
  deliver: { title: "Submit deliverable", eyebrow: "Winner delivery", submit: "Submit delivery" },
  accept: { title: "Accept delivery", eyebrow: "Buyer settlement", submit: "Accept & settle" },
  dispute: { title: "Dispute delivery", eyebrow: "Buyer protection", submit: "Open dispute" },
  resolve: { title: "Resolve dispute", eyebrow: "Arbiter ruling", submit: "Resolve" },
  timeout: { title: "Timeout settlement", eyebrow: "Permissionless liveness", submit: "Settle after timeout" },
  finalize: { title: "Finalize auction", eyebrow: "Permissionless clearing", submit: "Finalize auction" },
};

export function AuctionDesk({
  jobs,
  loading,
  accountId,
  signer,
  onNeedSigner,
  onRefresh,
  onPostJob,
}: {
  jobs: JobView[] | null;
  loading: boolean;
  accountId: string | null;
  signer: Signer | null;
  onNeedSigner: () => void;
  onRefresh: () => Promise<void> | void;
  onPostJob: () => void;
}) {
  const [nowNs, setNowNs] = useState(() => BigInt(Date.now()) * 1_000_000n);
  const [sealTick, setSealTick] = useState(0);
  const [deskFilter, setDeskFilter] = useState<DeskFilter>("all");
  const [mode, setMode] = useState<ActionMode | null>(null);
  const [active, setActive] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string | null; label: string } | null>(null);

  // Bid / reveal form
  const [bidNear, setBidNear] = useState("");
  const [etaSeconds, setEtaSeconds] = useState("900");
  const [salt, setSalt] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [revealDigest, setRevealDigest] = useState("");
  const [sealedPreview, setSealedPreview] = useState<SealedBid | null>(null);

  // Delivery / dispute / resolve forms
  const [deliverableUri, setDeliverableUri] = useState("");
  const [deliverableText, setDeliverableText] = useState("");
  const [deliverableHash, setDeliverableHash] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [winnerBps, setWinnerBps] = useState("5000");

  useEffect(() => {
    const timer = window.setInterval(() => setNowNs(BigInt(Date.now()) * 1_000_000n), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(`tender.seal.${CONTRACT_ID}.`)) {
        setSealTick((current) => current + 1);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (mode !== "bid" || !active || !salt || !bidNear || !etaSeconds) {
      if (mode === "bid" && (!bidNear || !etaSeconds || !salt)) setCommitHash("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const preimage = buildCommitPreimage({
          jobId: active.job_id,
          workerId: accountId ?? "<connect-worker>",
          bidYocto: nearToYocto(bidNear),
          etaSeconds,
          salt,
        });
        const digest = await sha256Hex(preimage);
        if (!cancelled) setCommitHash(digest);
      } catch {
        if (!cancelled) setCommitHash("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, accountId, bidNear, etaSeconds, mode, salt]);

  useEffect(() => {
    if (mode !== "reveal" || !active || !accountId || !salt || !bidNear || !etaSeconds) {
      setRevealDigest("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const preimage = buildCommitPreimage({
          jobId: active.job_id,
          workerId: accountId,
          bidYocto: nearToYocto(bidNear),
          etaSeconds,
          salt,
        });
        const digest = await sha256Hex(preimage);
        if (!cancelled) setRevealDigest(digest);
      } catch {
        if (!cancelled) setRevealDigest("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, accountId, bidNear, etaSeconds, mode, salt]);

  const rows = useMemo(() => {
    const list = jobs ?? [];
    return [...list].sort((a, b) => {
      const aOpen = TERMINAL_STATUSES.has(a.status) ? 1 : 0;
      const bOpen = TERMINAL_STATUSES.has(b.status) ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return Number(BigInt(b.job_id) - BigInt(a.job_id));
    });
  }, [jobs]);

  const activeCount = useMemo(() => rows.filter((j) => !TERMINAL_STATUSES.has(j.status)).length, [rows]);
  const terminalCount = rows.length - activeCount;

  const sealVault = useMemo(() => {
    const vault = new Map<string, SealedBid>();
    if (!accountId) return vault;
    for (const job of rows) {
      const seal = readSeal(job.job_id, accountId);
      if (seal) vault.set(job.job_id, seal);
    }
    return vault;
  }, [rows, accountId, sealTick]);

  const visibleRows = useMemo(() => {
    if (deskFilter === "active") return rows.filter((j) => !TERMINAL_STATUSES.has(j.status));
    if (deskFilter === "terminal") return rows.filter((j) => TERMINAL_STATUSES.has(j.status));
    return rows;
  }, [rows, deskFilter]);

  const open = (job: JobView, next: ActionMode) => {
    setActive(job);
    setMode(next);
    setError(null);
    setDone(null);
    setSealedPreview(null);
    setRevealDigest("");
    setDeliverableUri(job.deliverable_uri ?? "");
    setDeliverableText("");
    setDeliverableHash(job.deliverable_sha256 ?? "");
    setReasonText("");
    setWinnerBps("5000");
    setBidNear(job.reserve_price.raw ? yoctoToNearInput(((BigInt(job.reserve_price.raw) * 9n) / 10n).toString()) : "");
    setEtaSeconds("900");
    const freshSalt = randomSaltHex(16);
    setSalt(freshSalt);
    setCommitHash("");
    if (next === "reveal" && accountId) {
      const stored = readSeal(job.job_id, accountId);
      if (stored) {
        setSealedPreview(stored);
        setBidNear(yoctoToNearInput(stored.bid));
        setEtaSeconds(stored.etaSeconds);
        setSalt(stored.salt);
        setCommitHash(stored.commitHash);
      }
    }
  };

  const close = () => {
    if (busy) return;
    setMode(null);
    setActive(null);
    setSealedPreview(null);
    setError(null);
    setDone(null);
  };

  const submit = useCallback(async () => {
    if (!active || !mode) return;
    if (!signer) {
      onNeedSigner();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let hash: string | null = null;
      if (mode === "bid") {
        if (!bidNear.trim()) throw new Error("Enter a bid in NEAR.");
        const bidYocto = nearToYocto(bidNear);
        if (BigInt(bidYocto) <= 0n) throw new Error("Bid must be positive.");
        if (active.reserve_price.raw && BigInt(bidYocto) > BigInt(active.reserve_price.raw)) {
          throw new Error("Bid cannot exceed the reserve price.");
        }
        if (Number(etaSeconds) <= 0) throw new Error("ETA must be at least 1 second.");
        if (salt.length < 8) throw new Error("Salt must be at least 8 characters.");
        const digest = await sha256Hex(
          buildCommitPreimage({
            jobId: active.job_id,
            workerId: accountId ?? signer.accountId,
            bidYocto,
            etaSeconds,
            salt,
          }),
        );
        hash = await executeCall(signer, {
          methodName: "commit_bid",
          args: { job_id: active.job_id, commit_hash: digest },
          gasTgas: 60,
        });
        try {
          window.localStorage.setItem(
            sealKey(active.job_id, accountId ?? signer.accountId),
            JSON.stringify({
              bid: bidYocto,
              etaSeconds,
              salt,
              commitHash: digest,
              savedAt: Date.now(),
            } satisfies SealedBid),
          );
        } catch {
          // Private mode can block storage; the reveal dialog still accepts manual input.
        }
        setSealTick((current) => current + 1);
        setCommitHash(digest);
      } else if (mode === "reveal") {
        const sealed = sealedPreview ?? readSeal(active.job_id, accountId ?? signer.accountId);
        const bidYocto = bidNear.trim() ? nearToYocto(bidNear) : sealed?.bid;
        const eta = etaSeconds || sealed?.etaSeconds;
        const useSalt = salt || sealed?.salt;
        if (!bidYocto || !eta || !useSalt) {
          throw new Error("No sealed bid found. Enter the bid, ETA and salt you committed.");
        }
        hash = await executeCall(signer, {
          methodName: "reveal_bid",
          args: {
            job_id: active.job_id,
            bid_yocto: bidYocto,
            eta_seconds: eta,
            salt: useSalt,
          },
          gasTgas: 80,
        });
      } else if (mode === "deliver") {
        if (!deliverableUri.trim()) throw new Error("Enter a deliverable URI.");
        let digest = deliverableHash.trim();
        if (deliverableText.trim()) digest = await sha256Hex(deliverableText);
        if (!/^[0-9a-f]{64}$/.test(digest)) {
          throw new Error("Provide deliverable text or a 64-character lowercase hex SHA-256.");
        }
        hash = await executeCall(signer, {
          methodName: "submit_delivery",
          args: { job_id: active.job_id, deliverable_uri: deliverableUri.trim(), deliverable_sha256: digest },
          gasTgas: 60,
        });
      } else if (mode === "accept") {
        hash = await executeCall(signer, {
          methodName: "accept_delivery",
          args: { job_id: active.job_id },
          gasTgas: 120,
        });
      } else if (mode === "dispute") {
        if (!reasonText.trim()) throw new Error("Describe the dispute reason.");
        const digest = await sha256Hex(reasonText.trim());
        hash = await executeCall(signer, {
          methodName: "dispute_delivery",
          args: { job_id: active.job_id, reason_sha256: digest },
          gasTgas: 60,
        });
      } else if (mode === "resolve") {
        const value = Number(winnerBps);
        if (!Number.isInteger(value) || value < 0 || value > 10_000) {
          throw new Error("Winner share must be an integer from 0 to 10000 bps.");
        }
        hash = await executeCall(signer, {
          methodName: "resolve_dispute",
          args: { job_id: active.job_id, winner_bps: value },
          gasTgas: 120,
        });
      } else if (mode === "timeout") {
        hash = await executeCall(signer, {
          methodName: active.status === "Assigned" ? "claim_delivery_timeout" : "finalize_after_timeout",
          args: { job_id: active.job_id },
          gasTgas: 150,
        });
      } else if (mode === "finalize") {
        hash = await executeCall(signer, {
          methodName: "finalize_auction",
          args: { job_id: active.job_id },
          gasTgas: 100,
        });
      }
      setDone({ hash, label: ACTION_COPY[mode].submit });
      void onRefresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }, [
    accountId,
    active,
    bidNear,
    deliverableHash,
    deliverableText,
    deliverableUri,
    etaSeconds,
    mode,
    onNeedSigner,
    onRefresh,
    reasonText,
    salt,
    sealedPreview,
    signer,
    winnerBps,
  ]);

  const actionsFor = (
    job: JobView,
  ): Array<{ mode: ActionMode; label: string; icon: ReactNode; variant: "primary" | "secondary" | "danger" }> => {
    const phase = computePhase(job, nowNs);
    if (job.status === "Open") {
      if (phase === "CommitOpen") {
        return accountId === job.buyer
          ? []
          : [{ mode: "bid", label: "Commit bid", icon: <LockKey size={13} />, variant: "primary" }];
      }
      if (phase === "RevealOpen") {
        return accountId === job.buyer
          ? [{ mode: "finalize", label: "Clear early", icon: <Gavel size={13} />, variant: "secondary" }]
          : [{ mode: "reveal", label: "Reveal bid", icon: <Gavel size={13} />, variant: "primary" }];
      }
      return [{ mode: "finalize", label: "Finalize", icon: <Gavel size={13} />, variant: "primary" }];
    }
    if (job.status === "Assigned") {
      if (phase === "DeliveryExpired") {
        return [{ mode: "timeout", label: "Refund buyer", icon: <Clock size={13} />, variant: "secondary" }];
      }
      return accountId === job.winner
        ? [{ mode: "deliver", label: "Deliver", icon: <FileArrowUp size={13} />, variant: "primary" }]
        : [];
    }
    if (job.status === "Delivered") {
      if (accountId === job.buyer) {
        return [
          { mode: "accept", label: "Accept", icon: <CheckCircle size={13} />, variant: "primary" },
          { mode: "dispute", label: "Dispute", icon: <Warning size={13} />, variant: "danger" },
        ];
      }
      return [{ mode: "timeout", label: "Timeout settle", icon: <ShieldCheck size={13} />, variant: "secondary" }];
    }
    if (job.status === "Disputed") {
      return accountId && job.arbiter === accountId
        ? [{ mode: "resolve", label: "Resolve", icon: <Scales size={13} />, variant: "primary" }]
        : [{ mode: "timeout", label: "Liveness settle", icon: <Clock size={13} />, variant: "secondary" }];
    }
    return [];
  };

  return (
    <section aria-label="Live auction desk" data-testid="auction-desk" className="panel flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--border-hairline)] px-4 py-2.5">
        <div>
          <div className="eyebrow">Auction Desk · Order Book</div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-[-0.015em]">Live clearing lifecycle</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void onRefresh()}>
            <ArrowClockwise size={13} />
            Sync
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onPostJob}>
            Post job
          </button>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2">
          <div className="seg-group" role="group" aria-label="Filter auction book">
            {(
              [
                ["all", `Book (${rows.length})`],
                ["active", `Live (${activeCount})`],
                ["terminal", `Closed (${terminalCount})`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="seg-btn"
                aria-pressed={deskFilter === value}
                onClick={() => setDeskFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] text-[var(--text-muted)]">
            {activeCount > 0 ? `${activeCount} open window${activeCount === 1 ? "" : "s"}` : "all windows settled"}
          </span>
        </div>
      ) : null}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          eyebrow="Empty Order Book"
          title="No jobs on the book."
          body="Post an escrowed job to open the first sealed-bid auction. Every phase transition emits a NEP-297 event."
          action={
            <button type="button" className="btn btn-sm btn-primary" onClick={onPostJob}>
              Post the first job
            </button>
          }
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          eyebrow={deskFilter === "active" ? "No Active Windows" : "No Closed Jobs"}
          title={deskFilter === "active" ? "No live auctions right now." : "No closed auctions yet."}
          body={
            deskFilter === "active"
              ? "All indexed jobs have reached a terminal state. Post an escrowed job or switch back to the full book."
              : "Active jobs are still moving through commit, reveal, or delivery windows."
          }
          action={
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDeskFilter("all")}>
              Show full book
            </button>
          }
        />
      ) : (
        <div className="divide-y divide-[var(--border-hairline)]">
          {visibleRows.slice(0, 8).map((job) => {
            const phase = job.phase ?? computePhase(job, nowNs);
            const tone = statusTone(job.status);
            const actions = actionsFor(job);
            const deadline =
              phase === "CommitOpen"
                ? job.commit_deadline_ns
                : phase === "RevealOpen"
                  ? job.reveal_deadline_ns
                  : phase === "Assigned"
                    ? job.delivery_deadline_ns
                    : null;
            const remaining = secondsUntil(deadline, nowNs);
            const mySeal = sealVault.get(job.job_id) ?? null;

            return (
              <div key={job.id} data-testid="job-row" className="px-4 py-3.5 transition-colors hover:bg-[var(--bg-elevated)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="numeric text-[12.5px] font-semibold text-[var(--text-primary)]">
                        #{job.job_id}
                      </span>
                      <StatusPill tone={tone}>{phaseLabel(phase)}</StatusPill>
                      <span className="pill">{mechanismLabel(job.mechanism)}</span>
                      {mySeal && job.status === "Open" ? (
                        <span className="pill pill-reveal" title={`Local seal stored for ${accountId}`}>
                          seal vaulted
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-1.5 truncate text-[13.5px] font-medium text-[var(--text-primary)]" title={job.title}>
                      {job.title}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-[var(--text-muted)]">
                      <span className="text-[var(--text-secondary)]">{job.category}</span>
                      <span>·</span>
                      <span title={`${nearFromYoctoExact(job.reserve_price.raw)} NEAR`}>
                        cap {nearFromYocto(job.reserve_price.raw, 4)} NEAR
                      </span>
                      <span>·</span>
                      <span>
                        {job.commit_count}c / {job.reveal_count}r
                      </span>
                      {deadline ? (
                        <>
                          <span>·</span>
                          <span className="numeric font-semibold text-[var(--text-primary)]">
                            {remaining && remaining > 0 ? `T-${countdown(remaining)}` : "window closed"}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {job.status === "Settled" && job.clearing_price.raw ? (
                      <div className="text-right">
                        <div
                          className="numeric text-[14px] font-semibold text-[var(--text-primary)]"
                          title={`${nearFromYoctoExact(job.clearing_price.raw)} NEAR`}
                        >
                          {nearFromYocto(job.clearing_price.raw, 4)} NEAR
                        </div>
                        <div className="font-mono text-[10px] font-semibold text-[var(--accent-primary)]">
                          cleared
                        </div>
                      </div>
                    ) : actions.length > 0 ? (
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {actions.map((act) => (
                          <button
                            key={act.mode}
                            type="button"
                            className={`btn btn-sm ${
                              act.variant === "primary"
                                ? "btn-primary"
                                : act.variant === "danger"
                                  ? "btn-danger-outline"
                                  : "btn-secondary"
                            }`}
                            onClick={() => open(job, act.mode)}
                          >
                            {act.icon}
                            {act.label}
                          </button>
                        ))}
                      </div>
                    ) : TERMINAL_STATUSES.has(job.status) ? (
                      <div className="text-right">
                        <span className="font-mono text-[10.5px] font-medium text-[var(--text-muted)]">
                          {job.status === "CancelledZeroReveals" ? "reserve refunded" : phaseLabel(phase).toLowerCase()}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {job.status === "Assigned"
                          ? "winner working"
                          : accountId === job.buyer
                            ? "awaiting bids"
                            : "waiting"}
                      </span>
                    )}
                  </div>
                </div>

                <JobStageRail status={job.status} phase={phase} />

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-[var(--text-muted)]">
                  <span className="truncate">
                    {job.winner
                      ? `winner ${hashShort(job.winner, 12, 6)}`
                      : `${job.work_units} ${job.unit_label} · min bond ${nearFromYocto(job.min_worker_bond.raw, 3)} NEAR`}
                  </span>
                  <span className="shrink-0">
                    {job.arbiter
                      ? `arbiter ${hashShort(job.arbiter, 8, 4)}`
                      : `buyer ${hashShort(job.buyer, 9, 5)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2">
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          {accountId ? `signer ${hashShort(accountId, 12, 6)}` : "read-only · connect to bid or post"}
        </span>
        <a
          className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          href={`https://${NEAR_NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/address/${CONTRACT_ID}`}
          target="_blank"
          rel="noreferrer"
        >
          {hashShort(CONTRACT_ID, 10, 6)}
          <ArrowSquareOut size={11} />
        </a>
      </div>

      <Dialog
        open={mode !== null}
        eyebrow={mode ? ACTION_COPY[mode].eyebrow : undefined}
        title={mode ? `${ACTION_COPY[mode].title}${active ? ` · job #${active.job_id}` : ""}` : ""}
        onClose={close}
        width="560px"
      >
        {active && mode ? (
          <div className="px-5 py-4">
            {!signer ? (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-[4px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3.5 py-2.5">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                  Connect a NEAR account to sign this protocol call.
                </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={onNeedSigner}>
                  Connect
                </button>
              </div>
            ) : null}

            <div className="mb-4 grid grid-cols-3 gap-2 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3.5 py-2.5">
              <div>
                <div className="eyebrow">Reserve Cap</div>
                <div className="numeric mt-0.5 text-[12.5px] font-semibold">
                  {nearFromYocto(active.reserve_price.raw, 4)} NEAR
                </div>
              </div>
              <div>
                <div className="eyebrow">Mechanism</div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-primary)]">
                  {mechanismLabel(active.mechanism)}
                </div>
              </div>
              <div>
                <div className="eyebrow">Phase</div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-primary)]">
                  {phaseLabel(active.phase ?? computePhase(active, nowNs))}
                </div>
              </div>
            </div>

            {mode === "bid" ? (
              <div className="space-y-4">
                <Field
                  label="Sealed bid (NEAR)"
                  htmlFor="bid-amount"
                  help="Bid at or below reserve. Hidden on-chain until the reveal window opens."
                >
                  <input
                    id="bid-amount"
                    className="input"
                    inputMode="decimal"
                    value={bidNear}
                    onChange={(event) => {
                      setBidNear(event.target.value);
                      setCommitHash("");
                    }}
                    placeholder="0.95"
                  />
                </Field>
                <Field
                  label="Estimated completion ETA (seconds)"
                  htmlFor="bid-eta"
                  help="Bound into the SHA-256 preimage alongside your bid and salt."
                >
                  <input
                    id="bid-eta"
                    className="input"
                    inputMode="numeric"
                    value={etaSeconds}
                    onChange={(event) => {
                      setEtaSeconds(event.target.value.replace(/[^0-9]/g, ""));
                      setCommitHash("");
                    }}
                  />
                </Field>
                <Field
                  label="Cryptographic salt"
                  htmlFor="bid-salt"
                  help="Stored in browser localStorage for reveal. Keep this tab's origin intact until reveal."
                >
                  <div className="flex gap-2">
                    <input
                      id="bid-salt"
                      className="input"
                      value={salt}
                      onChange={(event) => {
                        setSalt(event.target.value);
                        setCommitHash("");
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary shrink-0"
                      onClick={() => {
                        setSalt(randomSaltHex(16));
                        setCommitHash("");
                      }}
                    >
                      New salt
                    </button>
                  </div>
                </Field>
                <div className="panel-inset p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="eyebrow">Commitment hash</div>
                    <span className="font-mono text-[10px] text-[var(--accent-primary)]">0 NEAR attached</span>
                  </div>
                  <div className="hash mt-1.5 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                    {commitHash || "—"}
                  </div>
                  <p className="field-help">
                    Preimage:{" "}
                    <span className="font-mono">
                      tender:v1:{CONTRACT_ID}:{active.job_id}:{accountId ?? "<worker>"}:&lt;yocto&gt;:{etaSeconds || "0"}:&lt;salt&gt;
                    </span>
                  </p>
                </div>
              </div>
            ) : null}

            {mode === "reveal" ? (
              <div className="space-y-4">
                {sealedPreview ? (
                  <div className="rounded-[4px] border border-[color-mix(in_srgb,var(--accent-primary)_32%,transparent)] bg-[var(--accent-subtle)] px-3.5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--accent-primary)]">
                        <ShieldCheck size={15} weight="bold" />
                        Local seal found
                      </div>
                      {revealDigest && sealedPreview.commitHash === revealDigest ? (
                        <span className="font-mono text-[10px] font-semibold text-[var(--accent-primary)]">
                          SHA-256 verified
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 font-mono text-[10.5px] text-[var(--text-secondary)]">
                      bid {nearFromYocto(sealedPreview.bid, 4)} NEAR · eta {sealedPreview.etaSeconds}s · saved{" "}
                      {timestampShort(String(sealedPreview.savedAt * 1_000_000))}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-[4px] border border-[color-mix(in_srgb,var(--status-reveal)_38%,transparent)] bg-[var(--status-reveal-subtle)] px-3.5 py-2.5 text-[12px] text-[var(--status-reveal)]">
                    No local seal found. Enter the exact bid, ETA and salt used at commit time.
                  </div>
                )}
                <Field label="Bid (NEAR)" htmlFor="reveal-bid">
                  <input
                    id="reveal-bid"
                    className="input"
                    inputMode="decimal"
                    value={bidNear}
                    onChange={(event) => setBidNear(event.target.value)}
                  />
                </Field>
                <Field label="ETA (seconds)" htmlFor="reveal-eta">
                  <input
                    id="reveal-eta"
                    className="input"
                    inputMode="numeric"
                    value={etaSeconds}
                    onChange={(event) => setEtaSeconds(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <Field label="Salt" htmlFor="reveal-salt">
                  <input id="reveal-salt" className="input" value={salt} onChange={(event) => setSalt(event.target.value)} />
                </Field>
              </div>
            ) : null}

            {mode === "deliver" ? (
              <div className="space-y-4">
                <Field label="Deliverable URI" htmlFor="deliverable-uri" help="IPFS, Arweave, HTTPS, or any stable artifact URI.">
                  <input
                    id="deliverable-uri"
                    className="input"
                    value={deliverableUri}
                    onChange={(event) => setDeliverableUri(event.target.value)}
                    placeholder="ipfs://bafy…"
                  />
                </Field>
                <Field
                  label="Deliverable contents (optional)"
                  htmlFor="deliverable-text"
                  help="Hashed locally in WebCrypto; only the 64-hex SHA-256 digest is sent on-chain."
                >
                  <textarea
                    id="deliverable-text"
                    className="textarea font-mono"
                    rows={4}
                    value={deliverableText}
                    onChange={(event) => {
                      setDeliverableText(event.target.value);
                      if (event.target.value.trim()) setDeliverableHash("");
                    }}
                    placeholder="Paste the deliverable payload to compute its SHA-256 locally…"
                  />
                </Field>
                <Field label="Deliverable SHA-256" htmlFor="deliverable-hash" help="64 lowercase hex characters.">
                  <input
                    id="deliverable-hash"
                    className="input"
                    value={deliverableHash}
                    onChange={(event) => setDeliverableHash(event.target.value.trim())}
                    placeholder="64 hex characters"
                  />
                </Field>
              </div>
            ) : null}

            {mode === "dispute" ? (
              <Field
                label="Dispute reason"
                htmlFor="dispute-reason"
                help="Hashed locally with SHA-256; freezes automatic timeout settlement until arbiter ruling or resolution expiry."
              >
                <textarea
                  id="dispute-reason"
                  className="textarea"
                  rows={4}
                  value={reasonText}
                  onChange={(event) => setReasonText(event.target.value)}
                  placeholder="Deliverable does not satisfy specification criteria…"
                />
              </Field>
            ) : null}

            {mode === "resolve" ? (
              <div className="space-y-4">
                <Field
                  label="Winner share (bps)"
                  htmlFor="resolve-bps"
                  help="10000 = 100% of clearing price to worker; 0 = 100% refunded to buyer."
                >
                  <input
                    id="resolve-bps"
                    className="input"
                    inputMode="numeric"
                    value={winnerBps}
                    onChange={(event) => setWinnerBps(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ["0", "0% worker"],
                    ["2500", "25%"],
                    ["5000", "50 / 50"],
                    ["7500", "75%"],
                    ["10000", "100% worker"],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className="filter-pill"
                      aria-pressed={winnerBps === val}
                      onClick={() => setWinnerBps(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2">
                  <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                    worker {bps(Math.min(10_000, Number(winnerBps) || 0))} · buyer{" "}
                    {bps(Math.max(0, 10_000 - (Number(winnerBps) || 0)))}
                  </span>
                </div>
              </div>
            ) : null}

            {mode === "accept" || mode === "timeout" || mode === "finalize" ? (
              <div className="panel-elevated px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                {mode === "accept"
                  ? "Releases escrowed settlement to the winning worker at the recorded clearing price and refunds any Vickrey surplus to the buyer. Emits a permanent NEP-297 clearing print."
                  : mode === "timeout"
                    ? "Permissionless liveness settlement: callable once the active delivery, dispute, or arbiter resolution window has elapsed so escrowed funds can never freeze."
                    : "Finalizes the sealed-bid auction, selects the lowest valid revealed bid (Vickrey clears at min(runner-up, reserve)), slashes unrevealed bonds, and assigns the job."}
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-[4px] border border-[color-mix(in_srgb,var(--status-danger)_38%,transparent)] bg-[var(--status-danger-subtle)] px-3 py-2.5 text-[12px] text-[var(--status-danger)]"
              >
                <Warning size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            ) : null}

            {done ? (
              <div
                role="status"
                className="mt-4 rounded-[4px] border border-[color-mix(in_srgb,var(--accent-primary)_32%,transparent)] bg-[var(--accent-subtle)] px-3.5 py-3"
              >
                <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--accent-primary)]">
                  <CheckCircle size={15} weight="bold" />
                  {done.label} submitted
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {done.hash ? (
                    <>
                      <span className="hash font-mono text-[10px] text-[var(--text-secondary)]">{done.hash}</span>
                      <TxLink hash={done.hash} network={NEAR_NETWORK} />
                    </>
                  ) : (
                    <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                      Signed via wallet · indexer will project on next poll.
                    </span>
                  )}
                  <button type="button" className="btn btn-sm btn-secondary ml-auto" onClick={close}>
                    Done
                  </button>
                </div>
              </div>
            ) : null}

            {!done ? (
              <div className="mt-5 flex items-center justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void submit()}
                  disabled={busy || !signer}
                >
                  {busy ? (
                    <>
                      <Clock size={14} className="animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    ACTION_COPY[mode].submit
                  )}
                </button>
              </div>
            ) : null}

            <div className="mt-4 border-t border-[var(--border-hairline)] pt-3 font-mono text-[9.5px] leading-relaxed text-[var(--text-muted)]">
              Window schedule: commit closes {timestampShort(active.commit_deadline_ns)} · reveal window{" "}
              {humanDuration(String(BigInt(active.reveal_deadline_ns) - BigInt(active.commit_deadline_ns)))} · delivery{" "}
              {humanDuration(active.delivery_duration_ns)} · dispute {humanDuration(active.dispute_window_ns)}
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
