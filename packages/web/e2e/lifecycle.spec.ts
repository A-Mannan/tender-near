import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_ID,
  api,
  connectAs,
  screenshotPath,
  syncDesk,
  waitForJob,
  type JobProjection,
} from "./helpers";

/**
 * Opt-in end-to-end lifecycle proof. It signs with disposable testnet keys from
 * `.data/testnet-keys.json` in a build compiled with
 * `VITE_TENDER_ENABLE_LOCAL_SIGNER=1`. The default market suite never needs
 * keys, so submissions and CI remain read-only.
 */
const LIFECYCLE = process.env.TENDER_E2E_LIFECYCLE === "1";
const KEYS_PATH = resolve(fileURLToPath(new URL("../../../.data/testnet-keys.json", import.meta.url)));
const BUYER = `buyer.${CONTRACT_ID}`;
const WORKER = `worker-a.${CONTRACT_ID}`;

test.describe("Sealed-bid lifecycle · live testnet", () => {
  test.skip(!LIFECYCLE, "set TENDER_E2E_LIFECYCLE=1 and build with VITE_TENDER_ENABLE_LOCAL_SIGNER=1");
  test.skip(({ }, testInfo) => testInfo.project.name !== "desktop", "single desktop lifecycle run");

  let keys: {
    buyer: { private_key: string };
    workers: Record<string, { private_key: string }>;
  };

  test.beforeAll(() => {
    if (!existsSync(KEYS_PATH)) throw new Error(`missing ${KEYS_PATH}; run scripts/testnet-demo.mjs first`);
    keys = JSON.parse(readFileSync(KEYS_PATH, "utf8"));
  });

  async function latestJobId(request: APIRequestContext, title: string): Promise<string> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const jobs = await api<{ items: JobProjection[] }>(request, "/jobs?limit=100");
      const match = jobs.items
        .filter((job) => job.title === title && job.buyer === BUYER)
        .sort((a, b) => Number(BigInt(b.job_id) - BigInt(a.job_id)))[0];
      if (match) return match.job_id;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    throw new Error(`job "${title}" was not projected by the indexer`);
  }

  async function waitUntilDeadline(
    request: APIRequestContext,
    jobId: string,
    field: "commit_deadline_ns" | "reveal_deadline_ns",
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const detail = await api<{ job: JobProjection }>(
        request,
        `/jobs/${encodeURIComponent(`${CONTRACT_ID}:${jobId}`)}`,
      );
      const value = detail.job[field];
      if (value && BigInt(value) <= BigInt(Date.now()) * 1_000_000n) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    throw new Error(`timed out waiting for ${field} on job ${jobId}`);
  }

  async function action(page: Page, jobId: string, name: RegExp): Promise<void> {
    const row = page
      .getByTestId("job-row")
      .filter({ has: page.getByText(`#${jobId}`, { exact: true }) })
      .first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name }).click();
    await expect(page.getByTestId("dialog")).toBeVisible();
  }

  async function finishDialog(page: Page): Promise<void> {
    const dialog = page.getByTestId("dialog");
    await expect(dialog).toContainText(/submitted|Submitted/, { timeout: 120_000 });
    const done = dialog.getByRole("button", { name: /^Done$|Back to the desk/ });
    if (await done.isVisible().catch(() => false)) await done.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
  }

  test("create → commit → reveal → clear → deliver → accept → print", async ({ page, request }) => {
    test.setTimeout(600_000);
    const title = `E2E sealed audit ${Date.now()}`;

    // 1. Buyer posts an escrowed job with short commit/reveal windows.
    await page.goto("/");
    await connectAs(page, BUYER, keys.buyer.private_key);
    await page.getByTestId("post-job-button").click();
    const create = page.getByTestId("dialog");
    await expect(create).toBeVisible();
    await create.locator("#job-title").fill(title);
    await create.locator("#job-category").fill("agent-evaluation");
    await create.locator("#job-spec").fill(`E2E acceptance spec ${title}`);
    await create.locator("#job-units").fill("1");
    await create.locator("#job-unit-label").fill("task");
    await create.locator("#job-reserve").fill("0.1");
    await create.locator("#job-commits").fill("3");
    await create.locator("#job-commit").fill("30");
    await create.locator("#job-reveal").fill("20");
    await create.locator("#job-delivery").fill("30");
    await create.locator("#job-dispute").fill("10");
    await create.locator("#job-bond").fill("0");
    await create.getByRole("button", { name: "Fund escrow & post" }).click();
    await expect(create).toContainText("Job submitted to Tender", { timeout: 120_000 });
    await create.getByRole("button", { name: "Back to the desk" }).click();
    await expect(create).toBeHidden();

    const jobId = await latestJobId(request, title);
    const job = await waitForJob(request, jobId, ["Open"]);
    const reserve = BigInt(job.reserve_price.raw ?? "0");

    // 2. Worker commits a sealed bid through the UI.
    await connectAs(page, WORKER, keys.workers[WORKER].private_key);
    await page.getByTestId("auction-desk").getByRole("button", { name: "Sync", exact: true }).click();
    await action(page, jobId, /Commit bid/);
    const bidDialog = page.getByTestId("dialog");
    await bidDialog.locator("#bid-amount").fill("0.08");
    await bidDialog.locator("#bid-eta").fill("300");
    await expect(bidDialog).toContainText("Commitment hash");
    await bidDialog.getByRole("button", { name: "Commit sealed bid" }).click();
    await finishDialog(page);

    // The browser seal is the only copy of the preimage.
    const seal = await page.evaluate(
      ({ contract, job }) =>
        window.localStorage.getItem(`tender.seal.${contract}.${job}.worker-a.${contract}`),
      { contract: CONTRACT_ID, job: jobId },
    );
    expect(seal).toBeTruthy();
    expect(seal).toContain('"salt"');

    // 3. Reveal after the commit deadline.
    await waitUntilDeadline(request, jobId, "commit_deadline_ns", 180_000);
    await syncDesk(page);
    await action(page, jobId, /Reveal bid/);
    await expect(page.getByTestId("dialog")).toContainText(/Local seal found|Enter the exact bid/);
    await page.getByTestId("dialog").getByRole("button", { name: "Reveal bid" }).click();
    await finishDialog(page);

    // 4. Buyer clears the auction; single reveal clears at the winning bid.
    await waitUntilDeadline(request, jobId, "reveal_deadline_ns", 180_000);
    await connectAs(page, BUYER, keys.buyer.private_key);
    await syncDesk(page);
    await action(page, jobId, /Finalize|Clear early/);
    await page.getByTestId("dialog").getByRole("button", { name: /Finalize|Clear early/ }).click();
    await finishDialog(page);
    const cleared = await waitForJob(request, jobId, ["Assigned"], 120_000);
    expect(cleared.winner).toBe(WORKER);
    expect(BigInt(cleared.clearing_price.raw ?? "0")).toBeLessThanOrEqual(reserve);

    // 5. Worker delivers.
    await connectAs(page, WORKER, keys.workers[WORKER].private_key);
    await syncDesk(page);
    await action(page, jobId, /^Deliver$/);
    const deliver = page.getByTestId("dialog");
    await deliver.locator("#deliverable-uri").fill("ipfs://bafytender-e2e-deliverable");
    await deliver.locator("#deliverable-text").fill(`Delivered artifact for ${title}`);
    await deliver.getByRole("button", { name: "Submit delivery" }).click();
    await finishDialog(page);
    await waitForJob(request, jobId, ["Delivered"], 120_000);

    // 6. Buyer accepts; the contract settles and emits a print.
    await connectAs(page, BUYER, keys.buyer.private_key);
    await syncDesk(page);
    await action(page, jobId, /^Accept$/);
    await page.getByTestId("dialog").getByRole("button", { name: "Accept & settle" }).click();
    await finishDialog(page);

    const settled = await waitForJob(request, jobId, ["Settled"], 180_000);
    expect(settled.winner).toBe(WORKER);

    const detail = await api<{ job: JobProjection; print: { id: string; title: string } | null }>(
      request,
      `/jobs/${encodeURIComponent(`${CONTRACT_ID}:${jobId}`)}`,
    );
    expect(detail.print?.id).toBe(`${CONTRACT_ID}:${jobId}`);
    expect(detail.print?.title).toBe(title);

    await page.reload();
    await expect(page.getByTestId("tape")).toContainText(title, { timeout: 60_000 });
    await page.screenshot({ path: screenshotPath("desktop", "lifecycle-print"), fullPage: true });
  });
});
