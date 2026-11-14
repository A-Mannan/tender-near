import { useState } from "react";
import { Key, Warning, Wallet } from "@phosphor-icons/react";
import { CONTRACT_ID, ENABLE_LOCAL_SIGNER, NEAR_NETWORK } from "../lib/api";
import { connectLocalSigner, connectWallet, type Signer } from "../lib/near";
import { Dialog, Field } from "./Dialog";

export function SignerDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (signer: Signer, accountId: string) => void;
}) {
  const [tab, setTab] = useState<"wallet" | "key">("wallet");
  const [accountId, setAccountId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (signer: Signer) => {
    onConnected(signer, signer.accountId);
    setPrivateKey("");
    setBusy(false);
    onClose();
  };

  const handleWallet = async () => {
    setBusy(true);
    setError(null);
    try {
      const signer = await connectWallet();
      if (!signer) {
        setError("No wallet account was authorized.");
        setBusy(false);
        return;
      }
      finish(signer);
    } catch (walletError) {
      setError(walletError instanceof Error ? walletError.message : String(walletError));
      setBusy(false);
    }
  };

  const handleKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmedAccount = accountId.trim();
      if (!/^[a-z0-9._-]{2,64}$/.test(trimmedAccount)) {
        throw new Error("Enter a valid NEAR account ID.");
      }
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(privateKey.trim())) {
        throw new Error("Enter an ed25519 private key (ed25519:…).");
      }
      const signer = await connectLocalSigner(trimmedAccount, privateKey.trim());
      finish(signer);
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : String(keyError));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} eyebrow="Signature" title="Connect a NEAR account">
      <div className="px-5 py-4">
        <div className="flex gap-1 border-b border-[var(--border-hairline)] pb-3">
          <button
            type="button"
            className="filter-pill"
            aria-pressed={tab === "wallet"}
            onClick={() => setTab("wallet")}
          >
            <Wallet size={12} className="mr-1" /> Web wallet
          </button>
          <button
            type="button"
            className="filter-pill"
            aria-pressed={tab === "key"}
            onClick={() => setTab("key")}
          >
            <Key size={12} className="mr-1" /> Testnet key
          </button>
        </div>

        {tab === "wallet" ? (
          <div className="mt-4 space-y-4">
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Connect a {NEAR_NETWORK} wallet to create jobs, commit sealed bids, deliver work, and settle
              escrow. Tender never takes custody of your keys.
            </p>
            <div className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 font-mono text-[10px] text-[var(--text-muted)]">
              contract {CONTRACT_ID}
            </div>
            <button type="button" className="btn btn-primary w-full" onClick={() => void handleWallet()} disabled={busy}>
              <Wallet size={15} />
              {busy ? "Opening wallet…" : "Open wallet selector"}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex items-start gap-2 rounded-[4px] border border-[color-mix(in_srgb,var(--status-reveal)_35%,transparent)] bg-[var(--status-reveal-subtle)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--status-reveal)]">
              <Warning size={14} className="mt-0.5 shrink-0" />
              <span>
                {ENABLE_LOCAL_SIGNER
                  ? "Local signing is enabled for this build. The key stays in memory only and is never stored or sent anywhere except the RPC to sign transactions. Use a disposable testnet account."
                  : "Local signing is disabled in this production build. Use the web wallet, or rebuild with VITE_TENDER_ENABLE_LOCAL_SIGNER=1 for local E2E testing."}
              </span>
            </div>
            <Field label="Account ID" htmlFor="signer-account">
              <input
                id="signer-account"
                className="input"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                placeholder="demo.testnet"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Private key" htmlFor="signer-key" help="Kept in memory for this tab. Never persisted.">
              <input
                id="signer-key"
                className="input"
                type="password"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder="ed25519:…"
                autoComplete="off"
                spellCheck={false}
                disabled={!ENABLE_LOCAL_SIGNER}
              />
            </Field>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => void handleKey()}
              disabled={busy || !ENABLE_LOCAL_SIGNER}
            >
              <Key size={15} />
              {busy ? "Connecting…" : "Connect testnet account"}
            </button>
          </div>
        )}

        {error ? (
          <div role="alert" className="mt-4 rounded-[4px] border border-[color-mix(in_srgb,var(--status-danger)_35%,transparent)] bg-[var(--status-danger-subtle)] px-3 py-2.5 text-[12px] text-[var(--status-danger)]">
            {error}
          </div>
        ) : null}

        <p className="mt-4 border-t border-[var(--border-hairline)] pt-3 font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
          Testnet only. Tender is a research prototype and never asks for mainnet funds.
        </p>
      </div>
    </Dialog>
  );
}
