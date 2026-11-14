import {
  ArrowsClockwise,
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

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border-hairline)] bg-[color-mix(in_srgb,var(--bg-canvas)_88%,transparent)] backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Tender</span>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)] sm:inline">
              The Tape
            </span>
          </div>
          <span className="hidden h-4 w-px bg-[var(--border-hairline)] sm:block" />
          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            <Dot tone={health?.ok === false ? "warn" : "good"} />
            <span className="font-mono text-[10px] uppercase tracking-[0.07em] text-[var(--text-secondary)]">
              NEAR {NEAR_NETWORK}
            </span>
            <a
              href={`https://testnet.nearblocks.io/address/${CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
              className="max-w-[180px] truncate font-mono text-[10px] text-[var(--text-muted)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)]"
              title={CONTRACT_ID}
            >
              {hashShort(CONTRACT_ID, 14, 8)}
            </a>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="mr-1 hidden items-center gap-2 lg:flex">
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {synced === null ? "syncing" : `blk ${synced.toLocaleString("en-US")}`}
              {behind !== null && behind > 3 ? ` · +${behind}` : ""}
            </span>
            {health?.indexer.last_sync_at ? (
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {timestampShort(Date.parse(health.indexer.last_sync_at) * 1_000_000)}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={onRefresh}
            aria-label="Sync market tape"
            title="Sync now"
          >
            <ArrowsClockwise size={16} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>

          {accountId ? (
            <div className="flex items-center gap-1">
              <span
                className="hidden items-center gap-1.5 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)] sm:flex"
                title={signerLabel ? `${accountId} · ${signerLabel}` : accountId}
              >
                <Dot tone="good" />
                {hashShort(accountId, 10, 6)}
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={onDisconnect}
                aria-label="Disconnect wallet"
                title="Disconnect wallet"
              >
                <SignOut size={16} />
              </button>
            </div>
          ) : (
            <button type="button" data-testid="connect-button" className="btn btn-secondary" onClick={onConnect}>
              <Wallet size={15} />
              <span className="hidden sm:inline">Connect</span>
            </button>
          )}

          <button type="button" data-testid="post-job-button" className="btn btn-primary" onClick={onPostJob}>
            <Plus size={15} weight="bold" />
            <span className="hidden sm:inline">Post Escrowed Job</span>
            <span className="sm:hidden">Post Job</span>
          </button>
        </div>
      </div>
    </header>
  );
}
