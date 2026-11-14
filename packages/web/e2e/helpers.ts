import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_BASE = process.env.TENDER_E2E_API_URL ?? "http://127.0.0.1:8787";
export const CONTRACT_ID =
  process.env.TENDER_E2E_CONTRACT ?? "tender-hack-1114g.testnet";
const SCREENSHOTS = resolve(fileURLToPath(new URL("../../../docs/screenshots", import.meta.url)));

export interface TapePrint {
  id: string;
  contract_id: string;
  job_id: string;
  title: string;
  category: string;
  mechanism: string;
  buyer: string;
  winner: string;
  escrow: { kind: "near" } | { kind: "ft"; token_id: string };
  reserve_price: { raw: string | null; near: string | null };
  winning_bid: { raw: string | null; near: string | null };
  runner_up_bid: { raw: string | null; near: string | null };
  clearing_price: { raw: string | null; near: string | null };
  surplus_refunded: { raw: string | null; near: string | null };
  unit_price: { raw: string | null; near: string | null };
  work_units: string;
  unit_label: string;
  commit_count: number;
  reveal_count: number;
  savings_bps: number | null;
  worker_premium_bps: number | null;
  trigger: string;
  settled_at_ns: string;
  block_height: number;
  tx_hash: string | null;
  receipt_id: string;
  explorer_url: string | null;
}

export interface JobProjection {
  id: string;
  job_id: string;
  status: string;
  phase?: string;
  title: string;
  buyer: string;
  winner: string | null;
  commit_deadline_ns: string;
  reveal_deadline_ns: string;
  delivery_deadline_ns: string | null;
  commit_count: number;
  reveal_count: number;
  reserve_price: { raw: string | null; near: string | null };
  clearing_price: { raw: string | null; near: string | null };
}

export async function api<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${API_BASE}${path}`);
  expect(response.ok(), `GET ${path} -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

export async function waitForApi<T>(
  request: APIRequestContext,
  path: string,
  predicate: (value: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    try {
      last = await api<T>(request, path);
      if (predicate(last)) return last;
    } catch {
      // indexer not ready yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for API predicate on ${path}; last=${JSON.stringify(last).slice(0, 400)}`);
}

export async function waitForJob(
  request: APIRequestContext,
  jobId: string,
  statuses: string[],
  timeoutMs = 180_000,
): Promise<JobProjection> {
  const deadline = Date.now() + timeoutMs;
  let last: JobProjection | null = null;
  while (Date.now() < deadline) {
    try {
      const detail = await api<{ job: JobProjection }>(
        request,
        `/jobs/${encodeURIComponent(`${CONTRACT_ID}:${jobId}`)}`,
      );
      last = detail.job;
      if (statuses.includes(last.status)) return last;
    } catch {
      // not indexed yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(
    `Timed out waiting for job ${jobId} status in [${statuses.join(", ")}]; last=${last?.status ?? "missing"}`,
  );
}

export async function waitForPhase(
  request: APIRequestContext,
  jobId: string,
  phases: string[],
  timeoutMs = 180_000,
): Promise<JobProjection> {
  const deadline = Date.now() + timeoutMs;
  let last: JobProjection | null = null;
  while (Date.now() < deadline) {
    try {
      const detail = await api<{ job: JobProjection }>(
        request,
        `/jobs/${encodeURIComponent(`${CONTRACT_ID}:${jobId}`)}`,
      );
      last = detail.job;
      if (last.phase && phases.includes(last.phase)) return last;
    } catch {
      // not indexed yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(
    `Timed out waiting for job ${jobId} phase in [${phases.join(", ")}]; last=${last?.phase ?? "missing"}`,
  );
}

export function nearFromYocto(raw: string | null, maxFraction = 4): string {
  if (!raw) return "—";
  const yocto = 10n ** 24n;
  const value = BigInt(raw);
  const whole = value / yocto;
  const fraction = (value % yocto).toString().padStart(24, "0").slice(0, maxFraction).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

export async function syncDesk(page: Page): Promise<void> {
  const desk = page.getByTestId("auction-desk");
  await desk.getByRole("button", { name: "Sync", exact: true }).click();
}

export async function connectAs(page: Page, accountId: string, privateKey: string): Promise<void> {
  const disconnect = page.getByRole("button", { name: "Disconnect wallet" });
  if (await disconnect.isVisible().catch(() => false)) {
    await disconnect.click();
  }
  await page.getByTestId("connect-button").click();
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Testnet key/ }).click();
  await dialog.locator("#signer-account").fill(accountId);
  await dialog.locator("#signer-key").fill(privateKey);
  await dialog.getByRole("button", { name: "Connect testnet account" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("connect-button")).toBeHidden();
}

export function screenshotPath(project: string, name: string): string {
  mkdirSync(SCREENSHOTS, { recursive: true });
  return join(SCREENSHOTS, `${project}-${name}.png`);
}
