import { useEffect, useMemo, useState } from "react";
import { CheckCircle, Coins, Gavel, Warning } from "@phosphor-icons/react";
import { NEAR_NETWORK } from "../lib/api";
import { nearFromYocto } from "../lib/format";
import { executeCall, nearToYocto, requiredStorageDeposit, sha256Hex, type Signer } from "../lib/near";
import { Dialog, Field, TxLink } from "./Dialog";

const CATEGORIES = [
  "smart-contract-audit",
  "code-generation",
  "data-labeling",
  "research",
  "translation",
  "security-review",
  "agent-evaluation",
];

interface FormState {
  title: string;
  category: string;
  specText: string;
  specHash: string;
  specUri: string;
  workUnits: string;
  unitLabel: string;
  reserveNear: string;
  mechanism: "VickreySecondPrice" | "FirstPrice";
  commitSeconds: string;
  revealSeconds: string;
  deliveryMinutes: string;
  disputeSeconds: string;
  minBondNear: string;
  maxCommits: string;
  arbiter: string;
}

const initial: FormState = {
  title: "",
  category: "smart-contract-audit",
  specText: "",
  specHash: "",
  specUri: "",
  workUnits: "1",
  unitLabel: "task",
  reserveNear: "1",
  mechanism: "VickreySecondPrice",
  commitSeconds: "120",
  revealSeconds: "60",
  deliveryMinutes: "30",
  disputeSeconds: "60",
  minBondNear: "0",
  maxCommits: "8",
  arbiter: "",
};

const seconds = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Durations must be positive.");
  return String(BigInt(Math.floor(parsed)) * 1_000_000_000n);
};

export function CreateJobDialog({
  open,
  onClose,
  signer,
  accountId,
  onNeedSigner,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  signer: Signer | null;
  accountId: string | null;
  onNeedSigner: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [specDigest, setSpecDigest] = useState("");
  const [storage, setStorage] = useState<bigint | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(initial);
      setSpecDigest("");
      setDone(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!form.specText.trim()) return;
    let cancelled = false;
    void (async () => {
      const digest = await sha256Hex(form.specText);
      if (!cancelled) setSpecDigest(digest);
    })();
    return () => {
      cancelled = true;
    };
  }, [form.specText]);

  useEffect(() => {
    let cancelled = false;
    const commits = Number(form.maxCommits);
    if (!Number.isInteger(commits) || commits < 1 || commits > 64) return;
    void (async () => {
      try {
        const value = await requiredStorageDeposit(commits);
        if (!cancelled) {
          setStorage(value);
          setStorageError(null);
        }
      } catch (viewError) {
        if (!cancelled) setStorageError(viewError instanceof Error ? viewError.message : String(viewError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.maxCommits]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const totals = useMemo(() => {
    try {
      const reserve = nearToYocto(form.reserveNear);
      return { reserve, total: reserve + (storage ?? 0n) };
    } catch {
      return null;
    }
  }, [form.reserveNear, storage]);

  const submit = async () => {
    if (!signer) {
      onNeedSigner();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const title = form.title.trim();
      if (title.length === 0 || title.length > 140) throw new Error("Title must be 1–140 characters.");
      const category = form.category.trim();
      if (category.length === 0 || category.length > 64) throw new Error("Category must be 1–64 characters.");
      const digest = form.specText.trim() ? await sha256Hex(form.specText) : form.specHash.trim();
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error("Provide spec text or a 64-character lowercase hex SHA-256.");
      }
      const workUnits = Number(form.workUnits);
      if (!Number.isInteger(workUnits) || workUnits < 1) throw new Error("Work units must be a positive integer.");
      if (!form.unitLabel.trim() || form.unitLabel.trim().length > 32) {
        throw new Error("Unit label must be 1–32 characters.");
      }
      const reserve = BigInt(nearToYocto(form.reserveNear));
      if (reserve <= 0n) throw new Error("Reserve must be positive.");
      const commits = Number(form.maxCommits);
      if (!Number.isInteger(commits) || commits < 1 || commits > 64) {
        throw new Error("Max commitments must be 1–64.");
      }
      const bond = form.minBondNear.trim() ? BigInt(nearToYocto(form.minBondNear)) : 0n;
      const storageDeposit = storage ?? (await requiredStorageDeposit(commits));
      const txHash = await executeCall(signer, {
        methodName: "create_job",
        args: {
          title,
          category,
          spec_sha256: digest,
          spec_uri: form.specUri.trim(),
          work_units: String(workUnits),
          unit_label: form.unitLabel.trim(),
          reserve_price: reserve.toString(),
          mechanism: form.mechanism,
          commit_duration_ns: seconds(form.commitSeconds),
          reveal_duration_ns: seconds(form.revealSeconds),
          delivery_duration_ns: String(BigInt(Math.floor(Number(form.deliveryMinutes))) * 60n * 1_000_000_000n),
          dispute_window_ns: seconds(form.disputeSeconds),
          min_worker_bond: bond > 0n ? bond.toString() : null,
          max_commits: commits,
          arbiter: form.arbiter.trim() || null,
        },
        gasTgas: 150,
        depositYocto: (reserve + storageDeposit).toString(),
      });
      setDone(txHash);
      onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} eyebrow="Post escrow" title="Create a sealed-bid job" width="840px">
      {done ? (
        <div className="px-5 py-6">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--accent-primary)]">
            <CheckCircle size={18} weight="bold" />
            Job submitted to Tender
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            The escrow was funded in the same transaction. The indexer will project the job and its NEP-297
            events onto the auction desk after the next sync.
          </p>
          {done ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="hash font-mono text-[10px] text-[var(--text-muted)]">{done}</span>
              <TxLink hash={done} network={NEAR_NETWORK} />
            </div>
          ) : null}
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Back to the desk
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="px-5 py-4">
            {!signer ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5">
                <span className="text-[12px] text-[var(--text-secondary)]">
                  Connect a {NEAR_NETWORK} account to fund escrow.
                </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={onNeedSigner}>
                  Connect
                </button>
              </div>
            ) : (
              <div className="mb-4 flex items-center justify-between gap-2 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
                  buyer
                </span>
                <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">{accountId}</span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="form-section-heading sm:col-span-2">
                <span className="numeric text-[var(--accent-primary)]">01</span>
                <span>Work &amp; acceptance</span>
                <span className="ml-auto hidden font-mono text-[9px] font-normal normal-case tracking-normal text-[var(--text-muted)] sm:inline">
                  public metadata · local spec digest
                </span>
              </div>
              <div className="sm:col-span-2">
                <Field label="Job title" htmlFor="job-title" help="Public on the tape. 1–140 characters.">
                  <input
                    id="job-title"
                    className="input"
                    value={form.title}
                    onChange={(event) => update("title", event.target.value)}
                    placeholder="Audit the settlement contract"
                    maxLength={140}
                  />
                </Field>
              </div>

              <Field label="Category" htmlFor="job-category" help="Used for the category index.">
                <input
                  id="job-category"
                  className="input"
                  list="tender-categories"
                  value={form.category}
                  onChange={(event) => update("category", event.target.value)}
                  maxLength={64}
                />
                <datalist id="tender-categories">
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category} />
                  ))}
                </datalist>
              </Field>

              <Field label="Auction mechanism" htmlFor="job-mechanism" help="Vickrey clears at min(runner-up, reserve).">
                <select
                  id="job-mechanism"
                  className="select"
                  value={form.mechanism}
                  onChange={(event) => update("mechanism", event.target.value as FormState["mechanism"])}
                >
                  <option value="VickreySecondPrice">Vickrey second-price</option>
                  <option value="FirstPrice">First-price</option>
                </select>
              </Field>

              <div className="sm:col-span-2">
                <Field
                  label="Specification"
                  htmlFor="job-spec"
                  help="Hashed locally with SHA-256; only the digest is stored for commitment integrity."
                >
                  <textarea
                    id="job-spec"
                    className="textarea"
                    rows={3}
                    value={form.specText}
                    onChange={(event) => update("specText", event.target.value)}
                    placeholder="Deliverables, acceptance criteria, and format…"
                  />
                </Field>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="hash font-mono text-[9px] text-[var(--text-muted)]">
                    {form.specText.trim() ? specDigest : "or paste a precomputed digest below"}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
                    {form.specText.length} chars
                  </span>
                </div>
              </div>

              {!form.specText.trim() ? (
                <Field label="Spec SHA-256" htmlFor="job-spec-hash" help="64 lowercase hex characters.">
                  <input
                    id="job-spec-hash"
                    className="input"
                    value={form.specHash}
                    onChange={(event) => update("specHash", event.target.value.trim())}
                    placeholder="64 hex characters"
                  />
                </Field>
              ) : null}

              <Field label="Spec URI (optional)" htmlFor="job-spec-uri" help="Any stable reference: IPFS, Arweave, HTTPS.">
                <input
                  id="job-spec-uri"
                  className="input"
                  value={form.specUri}
                  onChange={(event) => update("specUri", event.target.value)}
                  placeholder="ipfs://bafy…"
                  maxLength={512}
                />
              </Field>

              <Field label="Work units" htmlFor="job-units" help="Buyer-declared quantity for unit pricing.">
                <input
                  id="job-units"
                  className="input"
                  inputMode="numeric"
                  value={form.workUnits}
                  onChange={(event) => update("workUnits", event.target.value.replace(/[^0-9]/g, ""))}
                />
              </Field>

              <Field label="Unit label" htmlFor="job-unit-label" help="e.g. kloc, 1k-rows, repo, task.">
                <input
                  id="job-unit-label"
                  className="input"
                  value={form.unitLabel}
                  onChange={(event) => update("unitLabel", event.target.value)}
                  maxLength={32}
                />
              </Field>

              <div className="form-section-heading mt-1 sm:col-span-2">
                <span className="numeric text-[var(--accent-primary)]">02</span>
                <span>Clearing &amp; collateral</span>
                <span className="ml-auto hidden font-mono text-[9px] font-normal normal-case tracking-normal text-[var(--text-muted)] sm:inline">
                  exact yoctoNEAR accounting
                </span>
              </div>

              <Field label="Reserve price (NEAR)" htmlFor="job-reserve" help="Escrowed up-front. Bids cannot exceed it.">
                <input
                  id="job-reserve"
                  className="input"
                  inputMode="decimal"
                  value={form.reserveNear}
                  onChange={(event) => update("reserveNear", event.target.value)}
                />
              </Field>

              <Field label="Minimum worker bond (NEAR)" htmlFor="job-bond" help="Optional reveal-liveness collateral, locked from the worker vault.">
                <input
                  id="job-bond"
                  className="input"
                  inputMode="decimal"
                  value={form.minBondNear}
                  onChange={(event) => update("minBondNear", event.target.value)}
                />
              </Field>

              <Field label="Max commitments" htmlFor="job-commits" help="1–64. Drives storage reservation.">
                <input
                  id="job-commits"
                  className="input"
                  inputMode="numeric"
                  value={form.maxCommits}
                  onChange={(event) => update("maxCommits", event.target.value.replace(/[^0-9]/g, ""))}
                />
              </Field>

              <Field label="Arbiter (optional)" htmlFor="job-arbiter" help="Account allowed to resolve disputes. Leave blank for timeout-only settlement.">
                <input
                  id="job-arbiter"
                  className="input"
                  value={form.arbiter}
                  onChange={(event) => update("arbiter", event.target.value)}
                  placeholder="arbiter.testnet"
                />
              </Field>
            </div>

            <div className="form-section-heading mt-5">
              <span className="numeric text-[var(--accent-primary)]">03</span>
              <span>Window schedule</span>
              <span className="ml-auto font-mono text-[9px] font-normal normal-case tracking-normal text-[var(--text-muted)]">
                commit → reveal → delivery → dispute
              </span>
            </div>
            <div className="mt-2">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Commit (s)" htmlFor="job-commit">
                  <input
                    id="job-commit"
                    className="input"
                    inputMode="numeric"
                    value={form.commitSeconds}
                    onChange={(event) => update("commitSeconds", event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <Field label="Reveal (s)" htmlFor="job-reveal">
                  <input
                    id="job-reveal"
                    className="input"
                    inputMode="numeric"
                    value={form.revealSeconds}
                    onChange={(event) => update("revealSeconds", event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <Field label="Delivery (min)" htmlFor="job-delivery">
                  <input
                    id="job-delivery"
                    className="input"
                    inputMode="numeric"
                    value={form.deliveryMinutes}
                    onChange={(event) => update("deliveryMinutes", event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
                <Field label="Dispute (s)" htmlFor="job-dispute">
                  <input
                    id="job-dispute"
                    className="input"
                    inputMode="numeric"
                    value={form.disputeSeconds}
                    onChange={(event) => update("disputeSeconds", event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </Field>
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <Coins size={12} />
                reserve {form.reserveNear || "0"} NEAR + storage{" "}
                {storage === null ? storageError ? "—" : "…" : nearFromYocto(storage.toString(), 5)} NEAR
              </span>
              <span className="text-[var(--text-primary)]">
                total deposit {totals ? nearFromYocto(totals.total.toString(), 5) : "—"} NEAR
              </span>
            </div>
            {storageError ? <p className="field-error mt-1">Storage view failed: {storageError}</p> : null}
          </div>

          {error ? (
            <div role="alert" className="mx-5 mt-4 flex items-start gap-2 rounded-[4px] border border-[color-mix(in_srgb,var(--status-danger)_35%,transparent)] bg-[var(--status-danger-subtle)] px-3 py-2.5 text-[12px] text-[var(--status-danger)]">
              <Warning size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          ) : null}

          <div className="sticky bottom-0 z-[5] flex items-center justify-between gap-3 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] px-5 py-3.5">
            <span className="hidden items-center gap-1.5 font-mono text-[9px] text-[var(--text-muted)] sm:flex">
              <Gavel size={12} />
              escrow funds the reserve; surplus is refunded
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={busy || !signer}
              >
                {busy ? "Submitting…" : "Fund escrow & post"}
              </button>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
