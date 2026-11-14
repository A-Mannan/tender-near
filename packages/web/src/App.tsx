import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, Info, ShieldWarning } from "@phosphor-icons/react";
import { API_BASE, CONTRACT_ID, NEAR_NETWORK, NEAR_RPC_URL } from "./lib/api";
import { timestampShort } from "./lib/format";
import type { Signer } from "./lib/near";
import { useMarketData } from "./hooks/useMarketData";
import { Analytics } from "./components/Analytics";
import { AuctionDesk } from "./components/AuctionDesk";
import { CreateJobDialog } from "./components/CreateJobDialog";
import { HowItWorksDialog } from "./components/HowItWorksDialog";
import { IndexStrip, MissionHeader } from "./components/IndexStrip";
import { ErrorBanner } from "./components/Primitives";
import { SignerDialog } from "./components/SignerDialog";
import { Tape } from "./components/Tape";
import { TopBar } from "./components/TopBar";

type Theme = "light" | "dark";

function readTheme(): Theme {
  const stored = window.localStorage.getItem("tender.theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const { state, refresh } = useMarketData();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [signerOpen, setSignerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tender.theme", theme);
  }, [theme]);

  const needSigner = useCallback(() => setSignerOpen(true), []);

  const onConnected = (nextSigner: Signer, nextAccount: string) => {
    setSigner(nextSigner);
    setAccountId(nextAccount);
  };

  const disconnect = () => {
    setSigner(null);
    setAccountId(null);
  };

  const prints = state.tape?.items ?? [];

  return (
    <div className="min-h-screen">
      <TopBar
        health={state.health}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
        onRefresh={() => void refresh()}
        refreshing={state.refreshing}
        onPostJob={() => setCreateOpen(true)}
        accountId={accountId}
        onConnect={() => setSignerOpen(true)}
        onDisconnect={disconnect}
        signerLabel={signer?.kind === "local" ? "local testnet key" : signer?.kind === "wallet" ? "web wallet" : null}
      />

      <main className="mx-auto w-full max-w-[1440px] space-y-4 px-3 py-4 md:px-5 md:py-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(600px,1.35fr)] lg:items-center">
          <MissionHeader settledPrints={state.median?.count ?? 0} onHowItWorks={() => setHowOpen(true)} />
          <IndexStrip median={state.median} spread={state.spread} loading={state.loading} />
        </div>

        {state.error ? (
          <ErrorBanner
            message={
              state.lastUpdated === null
                ? state.error
                : `Last refresh failed: ${state.error}. Showing the last good snapshot.`
            }
            onRetry={() => void refresh()}
          />
        ) : null}

        <div
          id="market-workspace"
          tabIndex={-1}
          className="grid scroll-mt-16 items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)]"
        >
          <Tape
            prints={prints}
            loading={state.loading}
            categories={state.facets?.categories ?? []}
            onPostJob={() => setCreateOpen(true)}
          />
          <AuctionDesk
            jobs={state.jobs?.items ?? null}
            loading={state.loading}
            accountId={accountId}
            signer={signer}
            onNeedSigner={needSigner}
            onRefresh={refresh}
            onPostJob={() => setCreateOpen(true)}
          />
        </div>

        <Analytics
          median={state.median}
          spread={state.spread}
          winRate={state.winRate}
          prints={prints}
          loading={state.loading}
        />

        <details className="panel group px-4 py-3">
          <summary className="flex cursor-pointer items-center gap-2 text-[12px] font-semibold text-[var(--text-secondary)] marker:content-none">
            <ShieldWarning size={14} className="text-[var(--text-muted)]" />
            Known limitations &amp; security notes
            <span className="ml-auto font-mono text-[10px] font-normal text-[var(--text-muted)] group-open:hidden">
              expand
            </span>
          </summary>
          <ul className="mt-3 grid gap-2 text-[12px] leading-relaxed text-[var(--text-secondary)] md:grid-cols-2">
            <li>
              <span className="font-semibold text-[var(--text-primary)]">Not audited.</span> Testnet research
              prototype only; no real funds.
            </li>
            <li>
              <span className="font-semibold text-[var(--text-primary)]">Worker bond is reveal-liveness collateral.</span>{" "}
              It unlocks on a valid reveal and is not slashed for failed delivery.
            </li>
            <li>
              <span className="font-semibold text-[var(--text-primary)]">FT escrow is experimental.</span> Any contract
              may call <span className="font-mono">ft_on_transfer</span>; the primary tape filters native-NEAR escrow.
            </li>
            <li>
              <span className="font-semibold text-[var(--text-primary)]">Work units are buyer-declared.</span> The contract
              cannot verify output quality or quantity, and dispute reasons are hashes, not proofs.
            </li>
          </ul>
        </details>
      </main>

      <footer className="mt-2 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-4 py-5 md:flex-row md:items-center md:justify-between md:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] text-[var(--text-muted)]">
            <span className="text-[var(--text-secondary)]">Tender · The Tape</span>
            <span aria-hidden="true">/</span>
            <a
              className="underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)]"
              href={`https://${NEAR_NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/address/${CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              {CONTRACT_ID} <ArrowSquareOut size={10} className="inline" />
            </a>
            <span aria-hidden="true">/</span>
            <span>NEP-297 tender v1.0.0</span>
            <span aria-hidden="true">/</span>
            <a
              className="underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)]"
              href="/SKILL.md"
              target="_blank"
              rel="noreferrer"
            >
              Agent skill <ArrowSquareOut size={10} className="inline" />
            </a>
            <span aria-hidden="true">/</span>
            <span>API {API_BASE}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <Info size={11} /> RPC {new URL(NEAR_RPC_URL).host}
            </span>
            <span aria-hidden="true">/</span>
            <span>
              {state.lastUpdated
                ? `tape synced ${timestampShort(String(state.lastUpdated * 1_000_000)).slice(6)}`
                : "tape syncing"}
            </span>
            <span aria-hidden="true">/</span>
            <span>testnet prototype · no real funds</span>
          </div>
        </div>
      </footer>

      <CreateJobDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        signer={signer}
        accountId={accountId}
        onNeedSigner={needSigner}
        onCreated={() => void refresh()}
      />
      <SignerDialog open={signerOpen} onClose={() => setSignerOpen(false)} onConnected={onConnected} />
      <HowItWorksDialog open={howOpen} onClose={() => setHowOpen(false)} />
    </div>
  );
}
