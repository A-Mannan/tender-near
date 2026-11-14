import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  Clock,
  FileArrowUp,
  Gavel,
  Lightning,
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

interface SealedBid {
  bid: string;
  etaSeconds: string;
  salt: string;
  commitHash: string;
  savedAt: number;
}

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

const ACTION_COPY: Record<ActionMode, { title: string; eyebrow: string; submit: string }> = {
  bid: { title: "Commit a sealed bid", eyebrow: "Step 1 of 2", submit: "Commit sealed bid" },
  reveal: { title: "Reveal your bid", eyebrow: "Step 2 of 2", submit: "Reveal bid" },
  deliver: { title: "Submit deliverable", eyebrow: "Winner delivery", submit: "Submit delivery" },
  accept: { title: "Accept delivery", eyebrow: "Buyer settlement", submit: "Accept & settle" },
  dispute: { title: "Dispute delivery", eyebrow: "Buyer protection", submit: "Open dispute" },
  resolve: { title: "Resolve dispute", eyebrow: "Arbiter", submit: "Resolve" },
  timeout: { title: "Timeout settlement", eyebrow: "Permissionless", submit: "Settle after timeout" },
  finalize: { title: "Finalize auction", eyebrow: "Permissionless", submit: "Finalize auction" },
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
  const [mode, setMode] = useState<ActionMode | null>(null);
  const [active, setActive] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string | null; label: string } | null>(null);

  // Bid form
  const [bidNear, setBidNear] = useState("");
  const [etaSeconds, setEtaSeconds] = useState("900");
  const [salt, setSalt] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [sealedPreview, setSealedPreview] = useState<SealedBid | null>(null);

  // Delivery / dispute forms
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
    if (!commitHash && active && salt && bidNear && etaSeconds) {
      void (async () => {
        try {
          const preimage = buildCommitPreimage({
            jobId: active.job_id,
            workerId: accountId ?? "",
            bidYocto: nearToYocto(bidNear),
            etaSeconds,
            salt,
          });
          setCommitHash(await sha256Hex(preimage));
        } catch {
          setCommitHash("");
        }
      })();
    }
  }, [active, accountId, bidNear, commitHash, etaSeconds, salt]);

  const rows = useMemo(() => {
    const list = jobs ?? [];
    const settled = new Set(["Settled", "Refunded", "CancelledZeroReveals", "ExpiredNoDelivery"]);
    return [...list].sort((a, b) => {
      const aOpen = settled.has(a.status) ? 1 : 0;
      const bOpen = settled.has(b.status) ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return Number(BigInt(b.job_id) - BigInt(a.job_id));
    });
  }, [jobs]);

  const open = (job: JobView, next: ActionMode) => {
    setActive(job);
    setMode(next);
    setError(null);
    setDone(null);
    setSealedPreview(null);
    setDeliverableUri(job.deliverable_uri ?? "");
    setDeliverableText("");
    setDeliverableHash(job.deliverable_sha256 ?? "");
    setReasonText("");
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
          methodName: "finalize_after_timeout",
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

  const actionFor = (job: JobView): { mode: ActionMode; label: string; icon: ReactNode } | null => {
    const phase = computePhase(job, nowNs);
    if (job.status === "Open") {
      if (phase === "CommitOpen") {
        return accountId === job.buyer
          ? null
          : { mode: "bid", label: "Commit bid", icon: <LockKey size={13} /> };
      }
      if (phase === "RevealOpen") {
        return accountId === job.buyer
          ? { mode: "finalize", label: "Clear early", icon: <Gavel size={13} /> }
          : { mode: "reveal", label: "Reveal bid", icon: <Gavel size={13} /> };
      }
      return { mode: "finalize", label: "Finalize", icon: <Gavel size={13} /> };
    }
    if (job.status === "Assigned") {
      if (phase === "DeliveryExpired") {
        return { mode: "timeout", label: "Refund buyer", icon: <Clock size={13} /> };
      }
      return accountId === job.winner
        ? { mode: "deliver", label: "Deliver", icon: <FileArrowUp size={13} /> }
        : null;
    }
    if (job.status === "Delivered") {
      if (accountId === job.buyer) {
        return { mode: "accept", label: "Accept", icon: <CheckCircle size={13} /> };
      }
      return { mode: "timeout", label: "Timeout settle", icon: <ShieldCheck size={13} /> };
    }
    if (job.status === "Disputed") {
      return accountId && job.arbiter === accountId
        ? { mode: "resolve", label: "Resolve", icon: <Scales size={13} /> }
        : { mode: "timeout", label: "Liveness settle", icon: <Clock size={13} /> };
    }
    return null;
  };

  return (
    <section aria-label="Live auction desk" data-testid="auction-desk" className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-4 py-3">
        <div>
          <div className="eyebrow">Auction desk</div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-[-0.01em]">Live clearing lifecycle</h2>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onRefresh()}>
            <ArrowClockwise size={13} />
            Sync
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onPostJob}>
            Post job
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonRows rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No jobs on the book."
          body="Post an escrowed job to open the first sealed-bid auction. Every phase transition emits a NEP-297 event."
          action={
            <button type="button" className="btn btn-sm btn-primary mt-2" onClick={onPostJob}>
              Post the first job
            </button>
          }
        />
      ) : (
        <div className="divide-y divide-[var(--border-hairline)]">
          {rows.slice(0, 8).map((job) => {
            const phase = job.phase ?? computePhase(job, nowNs);
            const tone = statusTone(job.status);
            const action = actionFor(job);
            const deadline =
              phase === "CommitOpen"
                ? job.commit_deadline_ns
                : phase === "RevealOpen"
                  ? job.reveal_deadline_ns
                  : phase === "Assigned"
                    ? job.delivery_deadline_ns
                    : null;
            const remaining = secondsUntil(deadline, nowNs);
            const mySeal = accountId ? readSeal(job.job_id, accountId) : null;

            return (
              <div key={job.id} data-testid="job-row" className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="numeric text-[12px] font-semibold">#{job.job_id}</span>
                      <StatusPill tone={tone}>{phaseLabel(phase)}</StatusPill>
                      <span className="hidden font-mono text-[10px] text-[var(--text-muted)] sm:inline">
                        {mechanismLabel(job.mechanism)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[13px] font-medium" title={job.title}>
                      {job.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text-muted)]">
                      <span>{job.category}</span>
                      <span>reserve {nearFromYocto(job.reserve_price.raw, 4)} NEAR</span>
                      <span>
                        {job.commit_count} commits · {job.reveal_count} reveals
                      </span>
                      {deadline ? <span>closes in {countdown(remaining)}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {job.status === "Settled" && job.clearing_price.raw ? (
                      <div className="text-right">
                        <div className="numeric text-[14px] font-semibold">
                          {nearFromYocto(job.clearing_price.raw, 4)} NEAR
                        </div>
                        <div className="font-mono text-[10px] text-[var(--accent-primary)]">cleared</div>
                      </div>
                    ) : action ? (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => open(job, action.mode)}>
                        {action.icon}
                        {action.label}
                      </button>
                    ) : (
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">waiting</span>
                    )}
                    {mySeal && phase === "RevealOpen" ? (
                      <span className="font-mono text-[9px] text-[var(--status-reveal)]">seal saved locally</span>
                    ) : null}
                  </div>
                </div>

                {job.status === "Open" || job.status === "Assigned" || job.status === "Delivered" ? (
                  <div className="mt-2.5 flex items-center gap-2">
                    <Lightning size={11} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                      {job.winner
                        ? `winner ${hashShort(job.winner, 12, 6)}`
                        : `unit ${job.work_units} ${job.unit_label} · bond ${nearFromYocto(job.min_worker_bond.raw, 3)} NEAR`}
                    </span>
                    {job.arbiter ? (
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
                        arbiter {hashShort(job.arbiter, 8, 4)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2">
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          {accountId ? `acting as ${hashShort(accountId, 12, 6)}` : "read-only · connect to transact"}
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
              <div className="mb-4 flex items-center justify-between gap-3 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5">
                <span className="text-[12px] text-[var(--text-secondary)]">
                  Connect a NEAR account to sign this action.
                </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={onNeedSigner}>
                  Connect
                </button>
              </div>
            ) : null}

            <div className="mb-4 grid grid-cols-2 gap-2 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5">
              <div>
                <div className="eyebrow">Reserve</div>
                <div className="numeric mt-0.5 text-[12px] font-semibold">
                  {nearFromYocto(active.reserve_price.raw, 4)} NEAR
                </div>
              </div>
              <div>
                <div className="eyebrow">Phase</div>
                <div className="mt-0.5 font-mono text-[11px]">
                  {phaseLabel(active.phase ?? computePhase(active, nowNs))}
                </div>
              </div>
            </div>

            {mode === "bid" ? (
              <div className="space-y-4">
                <Field label="Sealed bid (NEAR)" htmlFor="bid-amount" help="Bid at or below reserve. Your amount stays hidden until reveal.">
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
                <Field label="ETA (seconds)" htmlFor="bid-eta" help="Part of the commitment preimage; committed with your bid.">
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
                  label="Salt"
                  htmlFor="bid-salt"
                  help="Kept in this browser and required to reveal. Do not lose it before reveal."
                >
                  <div className="flex gap-2">
                    <input id="bid-salt" className="input" value={salt} onChange={(event) => setSalt(event.target.value)} />
                    <button
                      type="button"
                      className="btn btn-secondary shrink-0"
                      onClick={() => {
                        setSalt(randomSaltHex(16));
                        setCommitHash("");
                      }}
                    >
                      New
                    </button>
                  </div>
                </Field>
                <div>
                  <div className="eyebrow mb-1">Commitment hash</div>
                  <div className="hash rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-[10px] text-[var(--text-secondary)]">
                    {commitHash || "—"}
                  </div>
                  <p className="field-help">
                    SHA-256 of <span className="font-mono">tender:v1:&lt;contract&gt;:&lt;job&gt;:&lt;worker&gt;:&lt;bid&gt;:&lt;eta&gt;:&lt;salt&gt;</span>
                  </p>
                </div>
              </div>
            ) : null}

            {mode === "reveal" ? (
              <div className="space-y-4">
                {sealedPreview ? (
                  <div className="rounded-[4px] border border-[color-mix(in_srgb,var(--accent-primary)_28%,transparent)] bg-[var(--accent-subtle)] px-3 py-2.5">
                    <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--accent-primary)]">
                      <ShieldCheck size={14} />
                      Local seal found
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-[var(--text-secondary)]">
                      bid {nearFromYocto(sealedPreview.bid, 4)} NEAR · eta {sealedPreview.etaSeconds}s · saved{" "}
                      {timestampShort(String(sealedPreview.savedAt * 1_000_000))}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-[4px] border border-[color-mix(in_srgb,var(--status-reveal)_35%,transparent)] bg-[var(--status-reveal-subtle)] px-3 py-2.5 text-[12px] text-[var(--status-reveal)]">
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
                <Field label="Deliverable URI" htmlFor="deliverable-uri" help="IPFS, Arweave, HTTPS, or any stable reference.">
                  <input
                    id="deliverable-uri"
                    className="input"
                    value={deliverableUri}
                    onChange={(event) => setDeliverableUri(event.target.value)}
                    placeholder="ipfs://bafy…"
                  />
                </Field>
                <Field label="Deliverable contents (optional)" htmlFor="deliverable-text" help="If provided, the SHA-256 below is computed from this text.">
                  <textarea
                    id="deliverable-text"
                    className="textarea font-mono"
                    rows={4}
                    value={deliverableText}
                    onChange={(event) => {
                      setDeliverableText(event.target.value);
                      if (event.target.value.trim()) setDeliverableHash("");
                    }}
                    placeholder="Paste the deliverable payload to hash it locally…"
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
              <Field label="Dispute reason" htmlFor="dispute-reason" help="Only the SHA-256 of this reason is stored on-chain.">
                <textarea
                  id="dispute-reason"
                  className="textarea"
                  rows={4}
                  value={reasonText}
                  onChange={(event) => setReasonText(event.target.value)}
                  placeholder="Deliverable does not satisfy spec section 3…"
                />
              </Field>
            ) : null}

            {mode === "resolve" ? (
              <div className="space-y-4">
                <Field label="Winner share (bps)" htmlFor="resolve-bps" help="10000 = full clearing price to worker; 0 = full refund to buyer.">
                  <input
                    id="resolve-bps"
                    className="input"
                    inputMode="numeric"
                    value={winnerBps}
                    onChange={(event) => setWinnerBps(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <div className="flex items-center justify-between rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2">
                  <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                    worker {bps(Number(winnerBps) || 0)} · buyer {bps(10_000 - (Number(winnerBps) || 0))}
                  </span>
                </div>
              </div>
            ) : null}

            {mode === "accept" || mode === "timeout" || mode === "finalize" ? (
              <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {mode === "accept"
                  ? "Releasing escrow to the winner at the recorded clearing price. Vickrey surplus is refunded to your claimable balance."
                  : mode === "timeout"
                    ? "Permissionless settlement: callable once the dispute window has elapsed. A disputed job can be settled by anyone after the arbiter resolution window expires."
                    : "Clears the sealed-bid auction after the reveal deadline, slashes unrevealed bonds, and records the winning print."}
              </p>
            ) : null}

            {error ? (
              <div role="alert" className="mt-4 flex items-start gap-2 rounded-[4px] border border-[color-mix(in_srgb,var(--status-danger)_35%,transparent)] bg-[var(--status-danger-subtle)] px-3 py-2.5 text-[12px] text-[var(--status-danger)]">
                <Warning size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            ) : null}

            {done ? (
              <div role="status" className="mt-4 rounded-[4px] border border-[color-mix(in_srgb,var(--accent-primary)_28%,transparent)] bg-[var(--accent-subtle)] px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--accent-primary)]">
                  <CheckCircle size={14} />
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
                      Signed via wallet · indexer will pick it up on the next poll.
                    </span>
                  )}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={close}>
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

            <div className="mt-4 border-t border-[var(--border-hairline)] pt-3 font-mono text-[9px] leading-relaxed text-[var(--text-muted)]">
              Job durations: commit {humanDuration(active.commit_deadline_ns)} after creation · reveal{" "}
              {humanDuration(
                String(BigInt(active.reveal_deadline_ns) - BigInt(active.commit_deadline_ns)),
              )}{" "}
              · delivery {humanDuration(active.delivery_duration_ns)} · dispute {humanDuration(active.dispute_window_ns)}
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
