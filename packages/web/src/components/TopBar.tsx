import {
  ArrowsClockwise,
  ArrowSquareOut,
  Moon,
  Plus,
  SignOut,
  Sun,
  Wallet,
} from "@phosphor-icons/react";
import { CONTRACT_ID, NEAR_NETWORK } from "../lib/api";
import { hashShort, timestampShort } from "../lib/format";
import type { Health } from "../lib/types";
import { Dot, Logo } from "./Brand";

export function TopBar({
  health,
  theme,
  onToggleTheme,
  onRefresh,
  refreshing,
  onPostJob,
  accountId,
  onConnect,
  onDisconnect,
  signerLabel,
}: {
  health: Health | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onPostJob: () => void;
  accountId: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  signerLabel: string | null;
}) {
  const synced = health?.indexer.last_indexed_height ?? null;
  const latest = health?.latest_block?.height ?? null;
  const behind = synced !== null && latest !== null ? Math.max(0, latest - synced) : null;
  const explorerHost = NEAR_NETWORK === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";

  return (
    <>
      <a href="#market-workspace" className="skip-link">
        Skip to market workspace
      </a>
      <header className="sticky top-0 z-40 border-b border-[var(--border-hairline)] bg-[color-mix(in_srgb,var(--bg-surface)_96%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[52px] w-full max-w-[1440px] items-center justify-between gap-2.5 px-3.5 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo />
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.025em] text-[var(--text-primary)]">Tender</span>
            <span className="hidden font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--text-muted)] sm:inline">
              The Tape
            </span>
          </div>

          <span className="hidden h-4 w-px bg-[var(--border-hairline)] md:block" />

          <div className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
              <Dot tone={health?.ok === false ? "warn" : "good"} />
              NEAR {NEAR_NETWORK}
            </span>
            <a
              href={`https://${explorerHost}/address/${CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-[200px] items-center gap-1 truncate font-mono text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title={`Clearinghouse contract: ${CONTRACT_ID}`}
            >
              <span className="truncate underline decoration-[var(--border-strong)] underline-offset-2">
                {hashShort(CONTRACT_ID, 14, 8)}
              </span>
              <ArrowSquareOut size={11} className="shrink-0 text-[var(--text-muted)]" />
            </a>
            <span className="hidden rounded-[3px] border border-[color-mix(in_srgb,var(--status-reveal)_36%,transparent)] bg-[var(--status-reveal-subtle)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-[var(--status-reveal)] xl:inline-block">
              Testnet · No real funds
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="mr-1 hidden items-center gap-2 rounded-[3px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 lg:flex">
            <span className="numeric font-mono text-[10.5px] font-medium text-[var(--text-secondary)]">
              {synced === null ? "indexing…" : `blk ${synced.toLocaleString("en-US")}`}
              {behind !== null && behind > 3 ? ` · -${behind}` : ""}
            </span>
            {health?.indexer.last_sync_at ? (
              <>
                <span className="h-3 w-px bg-[var(--border-hairline)]" aria-hidden="true" />
                <span className="numeric font-mono text-[10px] text-[var(--text-muted)]">
                  {timestampShort(Date.parse(health.indexer.last_sync_at) * 1_000_000)}
                </span>
              </>
            ) : null}
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={onRefresh}
            aria-label="Sync market tape"
            title="Sync market tape"
          >
            <ArrowsClockwise size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>

          {accountId ? (
            <div className="flex items-center gap-1">
              <span
                className="hidden items-center gap-1.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 font-mono text-[10.5px] font-medium text-[var(--text-primary)] sm:inline-flex"
                title={signerLabel ? `${accountId} · ${signerLabel}` : accountId}
              >
                <Dot tone="good" />
                <span>{hashShort(accountId, 10, 6)}</span>
                {signerLabel ? (
                  <span className="hidden border-l border-[var(--border-hairline)] pl-1.5 text-[9.5px] text-[var(--text-muted)] xl:inline">
                    {signerLabel}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={onDisconnect}
                aria-label="Disconnect wallet"
                title={`Disconnect ${accountId}`}
              >
                <SignOut size={15} />
              </button>
            </div>
          ) : (
            <button type="button" data-testid="connect-button" className="btn btn-secondary" onClick={onConnect}>
              <Wallet size={14} />
              <span className="hidden sm:inline">Connect</span>
            </button>
          )}

          <button type="button" data-testid="post-job-button" className="btn btn-primary" onClick={onPostJob}>
            <Plus size={14} weight="bold" />
            <span className="hidden sm:inline">Post Escrowed Job</span>
            <span className="sm:hidden">Post Job</span>
          </button>
        </div>
      </div>
      </header>
    </>
  );
}
