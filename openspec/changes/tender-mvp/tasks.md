# Tasks

## 1. Specification, Design System & Project Baseline

- [x] 1.1 Validate OpenSpec `tender-mvp` artifacts (`proposal.md`, `design.md`, capability specs, `tasks.md`) and verify `openspec validate tender-mvp --strict` exits with code 0.
- [x] 1.2 Author `DESIGN.md` (frontend design brief, color/typography tokens, layout hierarchy, anti-slop constraints) and `progress.md` (UTC clock log, external skill audit, protocol deviations, tier tracker), and verify both files exist and pass `git status` cleanliness before committing baseline.

## 2. Tier 1 — NEAR Clearinghouse Smart Contract (`contracts/tender`)

- [x] 2.1 Scaffold `contracts/tender` (`Cargo.toml` with `near-sdk` v5.x, `overflow-checks = true`, `near-sandbox`, `near-api`, `cargo-near-build`) and implement data models, NEP-297 `tender` v1.0.0 events, storage accounting, worker bond vault (`deposit_bond`, `withdraw_bond`), and `claimable_balances` withdrawal, verifying `cargo check --target wasm32-unknown-unknown --manifest-path contracts/tender/Cargo.toml` succeeds.
- [x] 2.2 Implement core clearinghouse lifecycle methods (`create_job`, NEP-141 `ft_on_transfer`, `commit_bid`, `reveal_bid`, `finalize_auction`, `submit_delivery`, `accept_delivery`, `finalize_after_timeout`, `claim_delivery_timeout`, `dispute_delivery`, `resolve_dispute`), `#[private]` payout/refund rollback callbacks (`on_settlement_complete`, `on_refund_complete`), and read-only view methods, verifying WASM build via `cargo near build non-reproducible-wasm --manifest-path contracts/tender/Cargo.toml` and unit tests via `cargo test --lib --manifest-path contracts/tender/Cargo.toml`.
- [x] 2.3 Implement comprehensive `near-sandbox` integration and adversarial tests (`contracts/tender/tests/clearinghouse_sandbox.rs`) covering happy-path Vickrey & First-Price clearing, zero-attachment `FunctionCall` Access Key worker execution, copied-commit replay (`eve` copying `alice`), cross-job commit replay, wrong-phase calls, reserve-exceeding reveal, exact tie-breaking by `commit_seq`, zero-reveal buyer refund, silent-buyer `finalize_after_timeout`, double-settlement rejection, and failed-payout callback rollback (deleted receiver account / failed NEP-141 transfer), verifying `cargo test --manifest-path contracts/tender/Cargo.toml` passes 100%.
- [x] 2.4 Run Tier 1 cold-context security audit against `near-contract-audit` checklist (access control, `#[private]` callbacks, u128 overflow, storage staking, Function-Call key safety, promise rollback), log findings/fixes in `progress.md`, and verify `cargo test --manifest-path contracts/tender/Cargo.toml` passes cleanly.

## 3. Tier 2 — NEP-297 Consolidated Tape Indexer & Query API (`packages/indexer`)

- [ ] 3.1 Create root workspace `package.json` and `packages/indexer` TypeScript service using `node:sqlite` (`DatabaseSync`) with NEAR JSON-RPC block/chunk/receipt poller, NEP-297 `tender` log parser, and `(receipt_id, log_index)` idempotent persistence, verifying `npm --prefix packages/indexer run typecheck` exits 0.
- [ ] 3.2 Implement `BigInt`-exact analytical query endpoints (`GET /health`, `GET /tape`, `GET /tape/median`, `GET /tape/win-rate`, `GET /tape/spread`, `GET /jobs`, `GET /jobs/:id`, `POST /sync`) plus optional demo/sandbox agent action relay for local E2E testing, and verify end-to-end indexer + API tests against real NEP-297 receipts and idempotent re-ingestion via `npm --prefix packages/indexer test`.
- [ ] 3.3 Run Tier 2 cold-context review on indexer precision, SQL injection safety, empty-dataset responses, and duplicate block replay invariance, record results in `progress.md`, and verify `npm --prefix packages/indexer test` passes.

## 4. Tier 3 — Consolidated Market Tape & Live Clearinghouse UI (`packages/web` + `e2e`)

- [ ] 4.1 Scaffold `packages/web` (Vite + React + TypeScript + Tailwind v4 + `@phosphor-icons/react`) implementing `DESIGN.md` tokens, WebCrypto `tender:v1` SHA-256 commitment helper + local salt vault, NEAR RPC/Indexer client, and honest loading/empty/error states with zero hardcoded market numbers, verifying `npm --prefix packages/web run build` succeeds.
- [ ] 4.2 Build the Consolidated Tape Terminal (live benchmark strip for median, spread, buyer savings, settled volume; chronological settled-prints tape with category filter & receipt/hash inspection; category medians & worker win-rate leaderboard; and interactive 5-stage Sealed-Bid Clearinghouse Drawer/Workbench supporting NEAR Testnet Wallet + live agent execution), verifying unit/component checks and `npm --prefix packages/web run build`.
- [ ] 4.3 Author Playwright full-stack E2E suite (`e2e/tender.spec.ts`) spinning up `near-sandbox` + deployed `tender.wasm` + `packages/indexer` + `packages/web`, verifying empty state, full browser-driven create → multi-worker commit → reveal → Vickrey clear → deliver → settle lifecycle, live tape update, keyboard focus/WCAG contrast, zero horizontal overflow at `375x812` and `1440x900`, and capturing screenshots via `npx playwright test`.
- [ ] 4.4 Inspect captured `375px` and `1440px` Playwright screenshots directly for visual hierarchy, spacing, alignment, and 5-second comprehension, apply UI polish fixes if needed, run Tier 3 cold-context review, and re-verify `npx playwright test` passes.

## 5. Tier 4 — NEAR Testnet Deployment & Multi-Agent Live Demo (`scripts/`)

- [ ] 5.1 Write deterministic deployment and multi-agent auction script (`scripts/testnet-demo.mjs`) using `near-api-js` / `near-cli-rs` to deploy `tender.wasm` to NEAR `testnet`, create sub-accounts (buyer + 3 worker agents including a `FunctionCall` Access Key agent), run real sealed-bid Vickrey and First-Price jobs through settlement, and sync the indexer, verifying real `testnet` transaction hashes and `GET /tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread` outputs.
- [ ] 5.2 Record `testnet` contract account ID, transaction hashes, RPC verification commands, and indexer output snapshots in `deployments/testnet.json` and `progress.md`, verifying contract state directly via `near contract call-function as-read-only` against `https://near-testnet.drpc.org`.

## 6. Tier 5 — Documentation, Submission Kit & Clean-Clone Gate Proof

- [ ] 6.1 Write comprehensive `README.md` (Tender overview, architecture diagram, mechanism design, setup/build/test/run commands, `testnet` deployment proof, API reference, and `"Design deviations"` section citing official `docs.near.org` URLs) and untracked human-only submission helper (`/tmp/opencode/submission-payload.json` / gitignored `submission-payload.json` with `<HUMAN>` placeholders), verifying zero tracked secrets or personal data via `git status` and `git grep`.
- [ ] 6.2 Clone the repository into a fresh isolated directory (`/tmp/opencode/tender-clean-verify`), run every build and test gate from scratch (`cargo test`, indexer tests, web build, Playwright E2E, testnet read check), and verify every gate exits 0 cleanly.

## Workflow follow-up

- Archive or sync OpenSpec change if desired after all tiers pass clean-clone verification.
- Hand off human-only publishing, X post, demo recording shot list, and `POST https://nearhackathon.com/api/applications` commands without pushing or submitting autonomously.
