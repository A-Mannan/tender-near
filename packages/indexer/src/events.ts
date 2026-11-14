export const TENDER_STANDARD = "tender";
export const TENDER_EVENT_VERSION = "1.0.0";

export interface TenderEventPayload {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

/** Parse a single NEP-297 log line. Returns `null` for non-Tender logs. */
export function parseTenderLog(log: string): TenderEventPayload | null {
  const prefix = "EVENT_JSON:";
  if (!log.startsWith(prefix)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(log.slice(prefix.length));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.standard !== TENDER_STANDARD) return null;
  if (record.version !== TENDER_EVENT_VERSION) return null;
  if (typeof record.event !== "string" || record.event.length === 0) return null;
  if (!Array.isArray(record.data)) return null;
  const data = record.data.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
  return {
    standard: record.standard,
    version: record.version,
    event: record.event,
    data,
  };
}

export function parseTenderLogs(logs: readonly string[]): TenderEventPayload[] {
  const events: TenderEventPayload[] = [];
  for (const log of logs) {
    const event = parseTenderLog(log);
    if (event) events.push(event);
  }
  return events;
}

/** Extract a string field, tolerating JSON numbers for numeric fields. */
export function fieldString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Extract an unsigned integer field as a canonical decimal string. */
export function fieldUint(data: Record<string, unknown>, key: string): string | null {
  const raw = fieldString(data, key);
  if (raw === null) return null;
  if (!/^\d{1,78}$/.test(raw)) return null;
  return BigInt(raw).toString();
}

export function fieldObject(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = data[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Normalize `EscrowToken` JSON (`"Near"` | `{ Ft: { token_id } }`) into a stable shape. */
export function normalizeEscrowToken(value: unknown): { kind: "near" } | { kind: "ft"; token_id: string } | null {
  if (value === "Near") return { kind: "near" };
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const ft = record.Ft;
    if (typeof ft === "object" && ft !== null) {
      const tokenId = (ft as Record<string, unknown>).token_id;
      if (typeof tokenId === "string") return { kind: "ft", token_id: tokenId };
    }
  }
  return null;
}

export function escrowTokenLabel(value: unknown): string {
  const normalized = normalizeEscrowToken(value);
  if (!normalized) return "unknown";
  return normalized.kind === "near" ? "NEAR" : `FT ${normalized.token_id}`;
}