const configuredBase = (import.meta.env.VITE_TENDER_API_URL ?? "").trim();
export const API_BASE = configuredBase.length > 0 ? configuredBase.replace(/\/+$/, "") : "/api";

export const CONTRACT_ID =
  (import.meta.env.VITE_TENDER_CONTRACT_ID ?? "tender-hack-1114g.testnet").trim();

export const NEAR_NETWORK = (import.meta.env.VITE_NEAR_NETWORK ?? "testnet").trim();

export const NEAR_RPC_URL =
  (import.meta.env.VITE_NEAR_RPC_URL ?? "https://near-testnet.drpc.org").trim();

export const ENABLE_LOCAL_SIGNER =
  (import.meta.env.VITE_TENDER_ENABLE_LOCAL_SIGNER ?? "0").trim() === "1";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "Indexer unreachable. Start the indexer and retry.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body !== null && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Indexer returned HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export { getJson };
