import { expect, test } from "@playwright/test";
import {
  API_BASE,
  CONTRACT_ID,
  api,
  screenshotPath,
  waitForApi,
  type TapePrint,
} from "./helpers";

interface TapeResponse {
  total: number;
  items: TapePrint[];
}

test.describe("The Tape · live market view", () => {
  test("renders live NEP-297 clearing prints, proof drawer, filters, and theme", async ({
    page,
    request,
  }, testInfo) => {
    const project = testInfo.project.name;
    const tape = await waitForApi<TapeResponse>(
      request,
      `/tape?limit=20&contract=${encodeURIComponent(CONTRACT_ID)}`,
      (value) => value.total >= 2,
      480_000,
    );
    expect(tape.items.length).toBeGreaterThanOrEqual(2);
    const first = tape.items[0];

    // Wait for the zero-reveal refund too, so the desk and screenshots show the
    // final terminal state rather than an auction that is still mid-window.
    await waitForApi<{ total: number; items: Array<{ status: string }> }>(
      request,
      `/jobs?limit=50&contract=${encodeURIComponent(CONTRACT_ID)}`,
      (value) => value.total >= 3 && value.items.every((job) => job.status !== "Open"),
      480_000,
    );

    // The API must only expose prints that settled on the deployed contract.
    for (const item of tape.items) {
      expect(item.contract_id).toBe(CONTRACT_ID);
      expect(item.tx_hash).toBeTruthy();
      expect(item.receipt_id).toBeTruthy();
      expect(item.settled_at_ns).toBeTruthy();
    }

    await page.goto("/");
    await expect(page.getByTestId("index-strip")).toBeVisible();
    await expect(page.getByTestId("tape")).toBeVisible();
    await expect(page.getByTestId("analytics")).toBeVisible();

    // The API returns decimal NEAR strings for spread bands; they must render
    // as numbers, not as the yocto formatter's missing-value dash.
    const analytics = page.getByTestId("analytics");
    await expect(analytics).toContainText(/p25 \d/);
    await expect(analytics).toContainText(/median \d/);
    await expect(analytics).toContainText(/p75 \d/);

    // Index strip is populated from the API, never hardcoded.
    const strip = page.getByTestId("index-strip");
    await expect(strip).not.toContainText("Awaiting print", { timeout: 60_000 });
    await expect(strip).toContainText("Median Clearing Price");
    await expect(strip).toContainText("0.32");

    // Tape rows appear for the project viewport.
    const rowTestId = project === "mobile" ? "tape-card" : "tape-row";
    await expect(page.getByTestId(rowTestId).first()).toBeVisible({ timeout: 60_000 });
    const rowCount = await page.getByTestId(rowTestId).count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("tape")).toContainText(first.title);

    // Mechanism filter narrows the tape to the FirstPrice print.
    const firstPriceCount = tape.items.filter((item) => item.mechanism === "FirstPrice").length;
    const vickreyCount = tape.items.filter((item) => item.mechanism === "VickreySecondPrice").length;
    if (firstPriceCount > 0 && vickreyCount > 0) {
      await page.getByRole("button", { name: "First-price", exact: true }).click();
      await expect(page.getByTestId(rowTestId)).toHaveCount(firstPriceCount);
      await page.getByRole("button", { name: "Vickrey", exact: true }).click();
      await expect(page.getByTestId(rowTestId)).toHaveCount(vickreyCount);
      await page.getByRole("button", { name: "All mechanisms", exact: true }).click();
    }

    // Proof drawer shows on-chain evidence, not synthesized values.
    if (project === "mobile") {
      await page.getByTestId("tape-card").first().getByRole("button").click();
    } else {
      await page.getByRole("button", { name: `Open proof for print ${first.job_id}` }).first().click();
    }
    const proof = page.getByTestId("print-proof");
    await expect(proof).toBeVisible();
    await expect(proof).toContainText("Settlement proof");
    await expect(proof).toContainText("On-chain proof");
    await expect(proof).toContainText(first.receipt_id);
    if (first.tx_hash) await expect(proof).toContainText(first.tx_hash);
    await expect(proof.getByRole("link", { name: /Nearblocks/ })).toHaveAttribute(
      "href",
      /nearblocks\.io\/txns\//,
    );
    await proof.getByRole("button", { name: "Close proof drawer" }).click();
    await expect(proof).toBeHidden();

    // Theme choice persists across reloads.
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(after).not.toBe(before);
    await page.reload();
    await expect(page.getByTestId("tape")).toBeVisible();
    const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(persisted).toBe(after);

    // Settled lifecycle jobs are visible on the auction desk, including the
    // zero-reveal refund as a terminal state rather than an open auction.
    await expect(page.getByTestId("auction-desk")).toContainText(/Settled|Assigned|Open/, {
      timeout: 60_000,
    });
    await expect(page.getByTestId("auction-desk")).toContainText("No reveals", { timeout: 60_000 });

    await page.screenshot({ path: screenshotPath(project, "market"), fullPage: true });
  });

  test("shows an accessible error banner when the indexer fails", async ({ page }) => {
    await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "down" }));
    await page.goto("/");
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/Indexer returned HTTP 503|Failed to fetch|unreachable/i);
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("shows an honest empty state when the tape has no prints", async ({ page }) => {
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/health")) {
        await route.fulfill({
          json: {
            ok: true,
            network: "testnet",
            contracts: [CONTRACT_ID],
            counts: { events: 0, jobs: 0, prints: 0, blocks: 0 },
            latest_block: null,
            indexer: { last_indexed_height: 0, last_sync_at: null, running: false },
          },
        });
        return;
      }
      if (path.endsWith("/tape")) {
        await route.fulfill({ json: { total: 0, items: [], next_cursor: null } });
        return;
      }
      if (path.endsWith("/tape") || path.endsWith("/jobs")) {
        await route.fulfill({ json: { total: 0, items: [] } });
        return;
      }
      if (path.endsWith("/tape/median")) {
        await route.fulfill({ json: { count: 0, priced_count: 0, units: [], by_category: [] } });
        return;
      }
      if (path.endsWith("/tape/spread")) {
        await route.fulfill({ json: { count: 0 } });
        return;
      }
      if (path.endsWith("/tape/win-rate")) {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      if (path.endsWith("/facets")) {
        await route.fulfill({ json: { categories: [], units: [] } });
        return;
      }
      await route.fulfill({ json: { total: 0, items: [] } });
    });

    await page.goto("/");
    await expect(page.getByTestId("tape")).toContainText("No settled prints yet.", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("index-strip")).toContainText("Awaiting print");
    await expect(page.getByTestId("auction-desk")).toContainText("No jobs on the book.");
    await expect(page.getByTestId("post-job-button")).toBeVisible();
  });
});

test.describe("Indexer API contract", () => {
  test("exposes exact, receipt-backed aggregates", async ({ request }) => {
    const tape = await waitForApi<TapeResponse>(
      request,
      `/tape?limit=20&contract=${encodeURIComponent(CONTRACT_ID)}`,
      (value) => value.total >= 2,
      480_000,
    );
    for (const item of tape.items) {
      expect(item.clearing_price.raw).toMatch(/^\d+$/);
      expect(BigInt(item.clearing_price.raw ?? "0")).toBeGreaterThan(0n);
      expect(item.unit_price.raw).toMatch(/^\d+$/);
      expect(item.savings_bps === null || Number.isInteger(item.savings_bps)).toBeTruthy();
    }

    const median = await api<{ count: number; median_clearing_price: string | null }>(
      request,
      "/tape/median?group_by=category",
    );
    expect(median.count).toBe(tape.total);

    const spread = await api<{ count: number }>(request, "/tape/spread");
    expect(spread.count).toBe(tape.total);

    const jobs = await api<{ total: number; items: Array<{ id: string; status: string }> }>(
      request,
      `/jobs?limit=50&contract=${encodeURIComponent(CONTRACT_ID)}`,
    );
    expect(jobs.total).toBeGreaterThanOrEqual(3);
    const settled = jobs.items.filter((job) => job.status === "Settled");
    expect(settled.length).toBe(tape.total);

    // Every print has a job projection with the same id.
    for (const print of tape.items) {
      const detail = await api<{ job: { id: string; status: string } }>(
        request,
        `/jobs/${encodeURIComponent(print.id)}`,
      );
      expect(detail.job.id).toBe(print.id);
      expect(detail.job.status).toBe("Settled");
    }

    // Invalid filters are rejected, not silently coerced.
    const bad = await request.get(`${API_BASE}/tape?escrow=usdc`);
    expect(bad.status()).toBe(400);
  });
});
