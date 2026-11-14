import type { ReactNode } from "react";
import { ArrowCounterClockwise, WarningOctagon } from "@phosphor-icons/react";

export function StatusPill({
  tone,
  children,
}: {
  tone: "commit" | "reveal" | "good" | "danger" | "neutral";
  children: ReactNode;
}) {
  const className =
    tone === "good"
      ? "pill pill-good"
      : tone === "commit"
        ? "pill pill-commit"
        : tone === "reveal"
          ? "pill pill-reveal"
          : tone === "danger"
            ? "pill pill-danger"
            : "pill";
  const dotColor =
    tone === "good"
      ? "var(--accent-primary)"
      : tone === "commit"
        ? "var(--status-commit)"
        : tone === "reveal"
          ? "var(--status-reveal)"
          : tone === "danger"
            ? "var(--status-danger)"
            : "var(--text-muted)";
  return (
    <span className={className}>
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: dotColor }}
      />
      {children}
    </span>
  );
}

export function MetricCell({
  label,
  value,
  sub,
  loading = false,
  tooltip,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  tooltip?: string;
  accent?: boolean;
}) {
  return (
    <div
      className="metric-cell min-w-0 px-4 py-3 md:px-5 md:py-3.5"
      title={tooltip}
    >
      {accent ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[2px] bg-[var(--accent-primary)]"
        />
      ) : null}
      <div className="eyebrow truncate leading-snug">{label}</div>
      {loading ? (
        <div className="skeleton mt-2 h-7 w-28" />
      ) : (
        <div className="metric-value numeric mt-1 flex items-baseline gap-1.5 whitespace-nowrap text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--text-primary)] md:text-[22px]">
          {value}
        </div>
      )}
      <div className="mt-1 min-h-4 truncate font-mono text-[10.5px] text-[var(--text-muted)]">
        {sub ?? "\u00a0"}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  eyebrow = "Standby",
}: {
  title: string;
  body: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-col items-start justify-center gap-1.5 px-5 py-8">
      <div className="eyebrow">{eyebrow}</div>
      <div className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{title}</div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: void | (() => void) }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-[color-mix(in_srgb,var(--status-danger)_42%,transparent)] bg-[var(--status-danger-subtle)] px-4 py-2.5 text-[12.5px] text-[var(--status-danger)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WarningOctagon size={16} weight="bold" className="shrink-0" />
        <span className="min-w-0 break-words font-medium">{message}</span>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={onRetry}>
          <ArrowCounterClockwise size={13} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-[var(--border-hairline)]" aria-label="Loading market tape">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3.5">
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 flex-1" />
          <div className="skeleton h-4 w-24" />
          <div className="skeleton h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
