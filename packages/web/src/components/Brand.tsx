export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
      className="brand-mark shrink-0"
    >
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="4.25"
        fill="var(--text-primary)"
        stroke="var(--border-strong)"
        strokeWidth="0.5"
      />
      {/* Reserve cap: the ceiling every sealed bid must clear below. */}
      <path d="M7 8.5H25" stroke="var(--accent-primary)" strokeWidth="3" strokeLinecap="square" />
      {/* Tender T and the permanent tape underline. */}
      <path d="M16 9.5V22.5" stroke="var(--bg-surface)" strokeWidth="3" strokeLinecap="square" />
      <path d="M9.5 22.5H18.5" stroke="var(--bg-surface)" strokeWidth="2.5" strokeLinecap="square" />
      {/* Receipt verification tick: compact enough to survive favicon sizing. */}
      <path
        d="M20.25 17.25L22.65 19.65L26.25 15.35"
        stroke="var(--accent-primary)"
        strokeWidth="2.1"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
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
      style={{
        background: color,
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    />
  );
}
