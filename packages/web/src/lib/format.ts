const YOCTO = 10n ** 24n;

/** Render a yoctoNEAR decimal string with grouping-free, tabular-friendly precision. */
export function nearFromYocto(raw: string | null | undefined, maxFraction = 4): string {
  if (raw === null || raw === undefined || raw.length === 0) return "—";
  try {
    const value = BigInt(raw);
    const whole = value / YOCTO;
    let fraction = (value % YOCTO).toString().padStart(24, "0").slice(0, maxFraction);
    fraction = fraction.replace(/0+$/, "");
    const wholeText = whole.toLocaleString("en-US");
    return fraction.length > 0 ? `${wholeText}.${fraction}` : wholeText;
  } catch {
    return "—";
  }
}

export function nearFromYoctoExact(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const value = BigInt(raw);
    const whole = value / YOCTO;
    const fraction = (value % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
    return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return "—";
  }
}

export function bps(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value / 100).toFixed(2)}%`;
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function hashShort(hash: string | null | undefined, head = 6, tail = 4): string {
  if (!hash) return "—";
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function timestampUtc(ns: string | number | null | undefined): string {
  if (ns === null || ns === undefined) return "—";
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "—";
  }
}

export function timestampShort(ns: string | number | null | undefined): string {
  if (ns === null || ns === undefined) return "—";
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
  } catch {
    return "—";
  }
}

export function relativeFromNow(ns: string | number | null | undefined, nowMs = Date.now()): string {
  if (ns === null || ns === undefined) return "—";
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    const delta = ms - nowMs;
    const abs = Math.abs(delta);
    const units: Array<[number, string]> = [
      [86_400_000, "d"],
      [3_600_000, "h"],
      [60_000, "m"],
      [1_000, "s"],
    ];
    for (const [size, label] of units) {
      if (abs >= size) {
        const value = Math.round(abs / size);
        return delta >= 0 ? `in ${value}${label}` : `${value}${label} ago`;
      }
    }
    return delta >= 0 ? "now" : "just now";
  } catch {
    return "—";
  }
}

export function mechanismLabel(mechanism: string): string {
  return mechanism === "FirstPrice" ? "First-Price" : "Vickrey 2nd-Price";
}

export function statusTone(status: string): "commit" | "reveal" | "good" | "danger" | "neutral" {
  switch (status) {
    case "Open":
      return "commit";
    case "Assigned":
    case "Delivered":
      return "reveal";
    case "Settled":
      return "good";
    case "Disputed":
    case "ExpiredNoDelivery":
    case "Refunded":
      return "danger";
    default:
      return "neutral";
  }
}

export function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    CommitOpen: "Commit open",
    RevealOpen: "Reveal open",
    AwaitingClear: "Awaiting clear",
    Assigned: "Assigned",
    DeliveryExpired: "Delivery expired",
    Delivered: "Delivered",
    ReadyAutoSettle: "Ready to settle",
    Disputed: "Disputed",
    DisputeResolutionExpired: "Dispute timeout",
    Settling: "Settling",
    Settled: "Settled",
    Refunding: "Refunding",
    CancelledZeroReveals: "No reveals",
    ExpiredNoDelivery: "No delivery",
    Refunded: "Refunded",
  };
  return labels[phase] ?? phase;
}

export function humanDuration(ns: string | number): string {
  try {
    const seconds = Number(BigInt(ns) / 1_000_000_000n);
    if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
    if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
    if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
    return `${seconds}s`;
  } catch {
    return "—";
  }
}

export function computePhase(
  job: {
    status: string;
    commit_deadline_ns: string;
    reveal_deadline_ns: string;
    delivery_deadline_ns: string | null;
  },
  nowNs: bigint,
): string {
  try {
    if (job.status === "Open") {
      if (nowNs < BigInt(job.commit_deadline_ns)) return "CommitOpen";
      if (nowNs < BigInt(job.reveal_deadline_ns)) return "RevealOpen";
      return "AwaitingClear";
    }
    if (job.status === "Assigned") {
      if (job.delivery_deadline_ns && nowNs >= BigInt(job.delivery_deadline_ns)) {
        return "DeliveryExpired";
      }
      return "Assigned";
    }
  } catch {
    return job.status;
  }
  return job.status;
}

export function secondsUntil(ns: string | null | undefined, nowNs: bigint): number | null {
  if (!ns) return null;
  try {
    const delta = BigInt(ns) - nowNs;
    if (delta <= 0n) return 0;
    return Number(delta / 1_000_000_000n);
  } catch {
    return null;
  }
}

export function countdown(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds <= 0) return "closed";
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}
