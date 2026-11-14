# Proposal: Tender — Sealed-Bid AI Labor Clearinghouse & Consolidated Price Index on NEAR

## Why

Autonomous AI agents already hire and execute work for humans and other agents, yet AI labor has **no public clearing price**: open-orderbook marketplaces leak quotes so competing bots undercut by 1 yoctoNEAR without revealing true marginal cost, while private API negotiations leave buyers blind to fair rates. **Tender** solves both problems at once on NEAR Protocol: a commit-reveal sealed-bid clearinghouse (supporting truthful **Vickrey second-price** and **first-price** reverse auctions with optimistic timeout settlement) paired with an immutable NEP-297 consolidated market tape—**the first live public price index of AI labor**.

## What Changes

- **Brand & Mechanism**: Name the product **Tender** — a formal invitation to bid, legal tender for escrow, and a public tape for clearing prices (analogous to FINRA TRACE / CME Tape rather than HR timesheets) — and upgrade naive lowest-bid clearing to support **Vickrey Second-Price Reverse Auctions** (truthful marginal-cost revelation) alongside First-Price mode, plus **optimistic timeout settlement** so honest workers cannot be held hostage by silent buyers.
- **NEAR Smart Contract (`contracts/tender`)**:
  - Escrow-backed job creation with buyer-declared objective `work_units`, `unit_label`, `spec_sha256`, `reserve_price`, and exact `env::storage_usage()` accounting.
  - Domain-separated SHA-256 commit-reveal sealed bidding (`tender:v1:<contract_id>:<job_id>:<worker_id>:<bid_yocto>:<eta_sec>:<salt_hex>`) immune to copied-commit and cross-job replay attacks.
  - **Zero-attachment worker execution path** so autonomous worker agents operating strictly with NEAR `FunctionCall` Access Keys (`0` attached NEAR allowed) can `commit_bid`, `reveal_bid`, `submit_delivery`, and `finalize_after_timeout` safely, with an optional pre-funded internal worker bond vault (`deposit_bond` / `withdraw_bond`) for Sybil/griefing-resistant jobs.
  - Asynchronous `Settling` / `Refunding` state locks with `#[private]` callback verification (`on_settlement_complete`, `on_refund_complete`) that roll back state cleanly if payout promises fail (e.g., deleted receiver account or unregistered NEP-141 receiver), preventing locked funds and double payouts.
  - Optional NEP-141 fungible token escrow (`ft_on_transfer`) with `1 yoctoNEAR` `ft_transfer` settlement and failed-callback rollback.
  - Structured NEP-297 `EVENT_JSON` (`standard: "tender"`, `version: "1.0.0"`) emitted across all lifecycle transitions.
- **Consolidated Tape Indexer & Query API (`packages/indexer`)**:
  - Real-time NEAR JSON-RPC block/receipt log indexer backed by SQLite (`node:sqlite`) with deterministic receipt-log deduplication.
  - Public REST API serving `/tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread`, `/jobs`, and `/health` strictly from real on-chain NEP-297 events and contract view state.
- **Consolidated Tape & Live Clearinghouse Terminal (`packages/web` + `DESIGN.md`)**:
  - Swiss-precision institutional market tape UI built from an explicit `DESIGN.md` brief—zero hardcoded mock numbers, honest loading/empty/error states, responsive from `375px` to `1440px`, full keyboard/WCAG AA accessibility, and live browser WebCrypto SHA-256 commit-reveal lifecycle controls.
- **Verification, Testnet Deployment & Clean-Clone Proof (`e2e/`, `scripts/`)**:
  - Full `near-sandbox` + `near-api` adversarial integration suite, indexer unit/integration tests, Playwright `375px`/`1440px` browser lifecycle E2E suite, scripted testnet deployment/demo (`scripts/testnet-demo.mjs`), and clean-clone gate verification.

## Capabilities

### New Capabilities
- `clearinghouse-contract`: NEAR Rust smart contract implementing escrow, storage accounting, domain-separated sealed-bid commit-reveal, Vickrey/First-price clearing, Function-Call key zero-deposit worker execution, optimistic delivery timeout settlement, NEP-141 FT escrow, and callback-safe payout rollback.
- `consolidated-tape`: NEP-297 event schema, idempotent NEAR RPC receipt/event indexer, and analytical REST endpoints (`/tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread`).
- `market-terminal-ui`: Responsive, accessible web terminal displaying the live public price index of AI labor and driving the complete sealed-bid lifecycle against real NEAR contract and indexer data.

### Modified Capabilities
<!-- None -->

## Impact

- `contracts/tender/`: Rust `near-sdk` v5.x smart contract + `near-sandbox` integration tests.
- `packages/indexer/`: TypeScript Node.js NEAR RPC indexer + HTTP query API + tests.
- `packages/web/`: Vite + React + Tailwind v4 frontend + `DESIGN.md` design system tokens.
- `e2e/`: Playwright full-stack E2E lifecycle tests and `375px`/`1440px` visual audit captures.
- `scripts/`: Sandbox/testnet deployment and scripted multi-agent auction demo runners.
