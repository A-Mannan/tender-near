export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="1" y="1" width="30" height="30" rx="6" fill="var(--text-primary)" />
      <path d="M7 9h18" stroke="var(--accent-primary)" strokeWidth="3" strokeLinecap="square" />
      <path d="M16 9v14" stroke="var(--bg-surface)" strokeWidth="3" strokeLinecap="square" />
      <path d="M10 23h12" stroke="var(--bg-surface)" strokeWidth="3" strokeLinecap="square" />
      <path d="M23 17l3 3-3 3" stroke="var(--accent-primary)" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function Dot({ tone = "good" }: { tone?: "good" | "warn" | "bad" }) {
  const color =
    tone === "good" ? "var(--accent-primary)" : tone === "warn" ? "var(--status-reveal)" : "var(--status-danger)";
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}
