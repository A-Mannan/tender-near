import type { ReactNode } from "react";

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
  return <span className={className}>{children}</span>;
}

export function MetricCell({
  label,
  value,
  sub,
  loading = false,
  tooltip,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  tooltip?: string;
}) {
  return (
    <div className="metric-cell min-w-0 px-4 py-3.5 first:pl-0 last:pr-0 md:px-5" title={tooltip}>
      <div className="eyebrow truncate">{label}</div>
      {loading ? (
        <div className="skeleton mt-2 h-7 w-28" />
      ) : (
        <div className="numeric mt-1 truncate text-[22px] font-semibold leading-tight tracking-tight text-[var(--text-primary)]">
          {value}
        </div>
      )}
      <div className="mt-1 min-h-4 truncate font-mono text-[10px] text-[var(--text-muted)]">{sub ?? "\u00a0"}</div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start justify-center gap-2 px-5 py-10">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
        Awaiting first print
      </div>
      <div className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</div>
      <p className="max-w-md text-[13px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border border-[color-mix(in_srgb,var(--status-danger)_35%,transparent)] bg-[var(--status-danger-subtle)] px-4 py-3 text-[13px] text-[var(--status-danger)]"
    >
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
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
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 flex-1" />
          <div className="skeleton h-4 w-24" />
          <div className="skeleton h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
