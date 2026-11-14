# Design: Tender Architecture & NEAR Protocol Implementation

## Context

See `proposal.md` for motivation and capability overview. Tender runs across three tightly verified tiers on NEAR Protocol:
1. **`contracts/tender`** — Rust `near-sdk` v5.x smart contract managing escrow, sealed-bid commit-reveal, Vickrey/First-price clearing, optimistic settlement, and NEP-297 tape emissions.
2. **`packages/indexer`** — Node.js v24 TypeScript indexer polling NEAR JSON-RPC (`block`, `chunk`, `EXPERIMENTAL_tx_status` / block outcome receipts), persisting deduplicated NEP-297 events in SQLite (`node:sqlite`), and exposing the public market-tape REST API (`/tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread`, `/jobs`, `/health`).
3. **`packages/web`** — Vite + React + Tailwind v4 Swiss-precision market terminal and live clearinghouse interface with browser WebCrypto SHA-256 commit-reveal and NEAR RPC / wallet / local sandbox-or-testnet signer integration.

Key NEAR Protocol constraints verified against official NEAR docs (`docs.near.org`):
- **Function-Call Access Keys cannot attach NEAR** (`https://docs.near.org/protocol/access-keys`): A restricted `FunctionCall` key only has gas allowance and rejects transactions where `attached_deposit > 0`.
- **NEP-141 `ft_transfer` requires `1 yoctoNEAR` + receiver registration** (`https://docs.near.org/primitives/ft`): Outgoing `ft_transfer` calls require `NearToken::from_yoctonear(1)` for user security confirmation (which contracts attach from their own balance) and fail if the receiver lacks `storage_deposit` on the FT contract.
- **Account storage staking (`10^19 yoctoNEAR/byte`)** (`https://docs.near.org/protocol/storage-staking`): The `~770 bytes` free allowance applies only to bare account creation, not contract state; growing `LookupMap` / `IterableMap` state locks `10^19 yoctoNEAR` per byte on the contract account.
- **Cross-contract payouts execute asynchronously** (`https://docs.near.org/smart-contracts/anatomy/crosscontract`): Promises (`Promise::new(account).transfer(...)` or `ext_ft::ft_transfer(...)`) can fail after the initial receipt succeeds (e.g., deleted receiver account or unregistered NEP-141 receiver), requiring in-flight state locks and `#[private]` rollback callbacks.

## Goals / Non-Goals

**Goals:**
- Guarantee cryptographic sealed-bid privacy during `CommitOpen` and domain-separated replay immunity across accounts, jobs, and contracts.
- Enable `0`-deposit `FunctionCall` Access Key autonomous worker agents to execute the full worker lifecycle (`commit_bid`, `reveal_bid`, `submit_delivery`, `finalize_after_timeout`).
- Incentivize truthful marginal-cost revelation via **Vickrey Second-Price Reverse Auctions** (`clearing_price = min(runner_up_bid, reserve_price)`) while supporting First-Price auctions for fixed-budget buyers.
- Prevent both silent-buyer griefing (via `finalize_after_timeout` after `dispute_window_ns`) and failed-payout escrow loss (via `Settling`/`Refunding` locks + `#[private]` callbacks).
- Produce an idempotent, auditable NEP-297 consolidated price tape with zero fabricated UI data.

**Non-Goals:**
- On-chain LLM inference or subjective quality arbitration (objective SHA-256 spec/deliverable hashes + buyer dispute window / timeout handle settlement cleanly within deterministic WASM).
- Multi-hop cross-chain settlement (out of scope for single-chain NEAR clearinghouse MVP).

## Decisions

### 1. Vickrey Second-Price Reverse Auction + First-Price Option
- **Choice**: Support `AuctionMechanism::VickreySecondPrice` (default) and `AuctionMechanism::FirstPrice`. In Vickrey mode, the lowest valid revealed `bid_yocto` wins, and `clearing_price = min(second_lowest_bid_yocto, reserve_price)` (if only 1 valid reveal exists, `reserve_price` acts as the virtual second bid so `clearing_price = reserve_price` in pure Vickrey—or to protect buyers on thin 1-bidder markets while preserving truthfulness with ≥2 bidders, let's verify mechanism game theory!).
- **Game-Theory Check on Single-Bidder Vickrey**: In a classical reverse Vickrey auction with public reserve price $R$, treating $R$ as a competing bid means a single bidder with bid $b_1 \le R$ clears at $\min(\infty, R) = R$, which is dominant-strategy incentive compatible (DSIC) even with $N=1$ bidder (if single bidder paid $b_1$, a bidder expecting $N=1$ would shade their bid up toward $R$!). With $N \ge 2$ bidders ($b_1 \le b_2 \le R$), winner pays $b_2$, returning surplus $R - b_2$ to the buyer and surfacing true marginal cost $b_1$ alongside competitive spread $b_2 - b_1$ on the public tape. First-Price mode sets `clearing_price = winning_bid` regardless of $N$.
- **Tie-Breaking**: Deterministic tie-breaking by monotonic `commit_seq` (earliest sealed commitment wins ties on `bid_yocto`).
- **Alternatives Considered**: Pure first-price only — rejected as sole mode because bidders shade bids upward toward perceived competitor quotes, hiding true AI compute/inference marginal cost from the consolidated tape.

### 2. Domain-Separated Preimage & Canonical Types
- **Choice**: Canonical ASCII preimage hashed with `near_sdk::env::sha256`:
  ```text
  tender:v1:<contract_account_id>:<job_id>:<worker_account_id>:<bid_yocto_u128_decimal>:<eta_seconds_u64_decimal>:<salt_utf8>
  ```
  `commit_hash` is stored and passed as 64-character lowercase hex (`[u8; 32]`). `bid_yocto` is serialized as `NearToken` / `U128` decimal string in JSON ABI (`u128` internally with `overflow-checks = true`).
- **Rationale**: Binding `contract_account_id`, `job_id`, and `worker_account_id` (`env::predecessor_account_id()`) directly inside the hash makes copied commits (`eve` copying `alice`'s `commit_hash`) and cross-job/cross-deployment replays cryptographically impossible.

### 3. Zero-Attachment Worker Path + Pre-Funded Bond Vault + Buyer Storage Reservation
- **Choice**:
  - `create_job` (NEAR escrow) and `ft_on_transfer` + `register_job_storage` (NEP-141 escrow) charge the buyer a measured/bounded storage deposit (`STORAGE_PRICE_PER_BYTE = 10^19 yoctoNEAR`) covering the job record plus up to `max_commits` (bounded, e.g. default `32`, max `100`) commit/reveal slots. Unused storage is refunded or retained safely without ever dipping into escrow.
  - Worker calls (`commit_bid`, `reveal_bid`, `submit_delivery`, `finalize_after_timeout`) are non-`#[payable]` (`0` attached NEAR required) so autonomous agents holding restricted `FunctionCall` Access Keys work out of the box.
  - Optional Sybil/non-reveal protection: `deposit_bond()` (`#[payable]`) and `withdraw_bond(amount)` maintain an internal `worker_bonds` vault. If a job sets `min_worker_bond > 0`, `commit_bid` locks `min_worker_bond` from the worker's internal vault balance (still `0` attached NEAR on `commit_bid`!), unlocks it upon valid `reveal_bid` (or cancelled job), and slashes unrevealed bonds on `finalize_auction` to compensate the buyer/protocol.
- **Alternatives Considered**: Requiring `#[payable]` attached NEAR on `commit_bid` — rejected because NEAR `FunctionCall` Access Keys cannot attach ≥1 yoctoNEAR (`docs.near.org/protocol/access-keys`).

### 4. Objective Work Units vs. Self-Reported Worker Output Length
- **Choice**: Buyers specify `work_units: u64` (`>= 1`, e.g., `10` contracts audited, `1000` rows labeled, `50` test cases) and `unit_label: String` (e.g., `"kloc"`, `"1k_tokens"`, `"dataset_rows"`), plus `spec_sha256: String` (64-char hex). Winning workers submit `deliverable_uri` + `deliverable_sha256` (64-char hex). Unit price on the tape is computed deterministically as `clearing_price / work_units`.
- **Alternatives Considered**: Computing per-token price from worker-reported output token count — rejected because workers on a per-unit index have a perverse incentive to pad/lie about output length, which WASM cannot verify without re-tokenizing external payloads.

### 5. Job State Machine & Callback-Safe Payout Rollback
- **States**:
  - `CommitOpen` → (after `commit_deadline_ns`, during reveal window) → `RevealOpen` (logical phase derived from `block_timestamp >= commit_deadline_ns && block_timestamp < reveal_deadline_ns` while `status == Open`)
  - `Open` → `finalize_auction` →
    - If `valid_reveals > 0`: `Assigned` (records `winner`, `winning_bid`, `runner_up_bid`, `clearing_price`, `delivery_deadline_ns`)
    - If `valid_reveals == 0`: `Refunding` → callback `on_refund_complete` → `CancelledZeroReveals` (or reverts to `Refundable` / `Open` if transfer fails so `retry_refund` can recover)
  - `Assigned` → `submit_delivery` (only `winner`, before `delivery_deadline_ns`) → `Delivered` (sets `dispute_deadline_ns = now + dispute_window_ns`)
  - `Assigned` → `claim_delivery_timeout` (after `delivery_deadline_ns` with no delivery) → `Refunding` → callback → `ExpiredNoDelivery` (refunds full `reserve_price` to buyer)
  - `Delivered` → `accept_delivery` (by `buyer`) OR `finalize_after_timeout` (by anyone once `now >= dispute_deadline_ns`) → `Settling` → promises payout `clearing_price` to `winner` (and `reserve_price - clearing_price` surplus refund to `buyer` if `> 0`) → `#[private] on_settlement_complete` →
    - If primary winner payout succeeds: marks `Settled` and emits `job_settled` NEP-297 event. (Surplus buyer refund is tracked separately in a claimable `claimable_refunds` balance if direct transfer fails, or settled atomically so a malicious buyer cannot block winner payout by deleting the buyer account!)
    - **Crucial Adversarial Edge Case**: What if the *buyer* deletes their account so the buyer's Vickrey surplus refund fails, trying to block the *winner's* payout? By crediting buyer surplus (`reserve_price - clearing_price`) to `claimable_balances[buyer]` (with instant `withdraw_claimable` or independent non-blocking transfer) and executing the promise strictly for the *winner's* `clearing_price` payout—or inspecting per-promise `env::promise_result(idx)` individually—a buyer can NEVER grief the worker's settlement, AND if the winner's payout fails (e.g., deleted winner account or unregistered NEP-141 FT account), `on_settlement_complete` rolls `Settling` back to `Delivered` (and allows `update_payout_account` by winner or `claim_settlement`) so escrow is never lost or double-spent!
  - `Delivered` → `dispute_delivery` (by `buyer` before `dispute_deadline_ns` with `reason_sha256`) → `Disputed` (freezes auto-timeout; buyer & winner can resolve via `resolve_dispute(winner_share_bps)` signed by buyer—Wait: can a dishonest buyer call `dispute_delivery` on every job to steal work for free? Let's check!).
  - **Game-Theory Check on `dispute_delivery`**: If a buyer could unilaterally call `dispute_delivery` and immediately refund 100% of escrow back to themselves, a dishonest buyer would dispute every delivered job! Instead, in `Disputed` state, escrow is frozen (neither buyer gets unilateral 100% refund nor worker gets unilateral 100% payout without resolution: buyer can release `accept_delivery` / `resolve_dispute` paying worker ≥0% with remaining surplus locked/routed or mutual settlement, OR an optional `arbiter` account specified at job creation resolves `Disputed` jobs!). Even better: if `arbiter: Option<AccountId>` is set on `create_job`, `dispute_delivery` routes to `arbiter` (`resolve_dispute`); if `arbiter` is `None`, the job operates in pure optimistic-settlement or buyer-acceptance mode (`dispute_delivery` requires an configured `arbiter`, otherwise buyer verifies before `accept_delivery` or lets `dispute_window_ns` auto-settle). That completely eliminates unilateral buyer rug-pulls while supporting arbitrated disputes when an arbiter is configured!

### 6. NEP-297 Event Schema & Indexer Architecture
- **NEP-297 Standard**: `EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"<event_name>","data":[{...}]}`
  - Events: `job_created`, `bid_committed`, `bid_revealed`, `auction_cleared`, `delivery_submitted`, `job_settled`, `job_refunded`, `job_disputed`, `payout_failed`, `bond_updated`.
- **Indexer (`packages/indexer`)**:
  - Uses Node.js built-in `node:sqlite` (`DatabaseSync`) — zero native C++ addon compilation flakiness, deterministic SQL queries, clean-clone portable.
  - Polls NEAR RPC blocks/chunks from `start_block_height` (recorded at deploy), filters receipts targeting `TENDER_CONTRACT_ID`, parses `EVENT_JSON:` logs matching `standard === "tender"`, and inserts with `PRIMARY KEY (receipt_id, log_index)` inside a SQLite transaction.
  - Exposes:
    - `GET /health` — RPC sync status, contract ID, indexed block height, total events.
    - `GET /tape` — Chronological settled prints (`?category=&mechanism=&limit=&offset=`), including `clearing_price_yocto`, `winning_bid_yocto`, `runner_up_bid_yocto`, `reserve_price_yocto`, `unit_price_yocto`, `work_units`, `unit_label`, `buyer`, `winner`, `deliverable_sha256`, `receipt_id`, `block_height`, `settled_at_ns`.
    - `GET /tape/median` — Exact median `clearing_price_yocto` and `unit_price_yocto` overall and grouped by `category` (using exact BigInt sorting on yoctoNEAR values so `u128` precision is never lost in IEEE-754 floats!).
    - `GET /tape/win-rate` — Per-worker `commits`, `reveals`, `wins`, `settled_jobs`, `win_rate_bps`, `reveal_rate_bps`, and `median_winning_bid_yocto`.
    - `GET /tape/spread` — Overall and per-category `bid_spread_yocto` (`runner_up_bid - winning_bid` where `reveal_count >= 2`), `bid_spread_bps`, and `buyer_savings_bps` (`(reserve_price - clearing_price) * 10000 / reserve_price`).
    - `GET /jobs` & `GET /jobs/:id` — Proxies/hydrates live active auctions from contract view methods (`get_jobs`, `get_job`, `get_commits`, `get_reveals`) plus event history, plus `POST /sync` to trigger an immediate RPC catch-up tick after a browser transaction confirms.

### 7. Frontend Aesthetic & Functional Design (`DESIGN.md` + `packages/web`)
- **Direction**: Swiss Institutional Market Tape (inspired by CME Globex / FINRA TRACE / Linear precision) — warm stone-paper light surface (`#F7F6F2` canvas, `#FFFFFF` elevated panels, `#111315` ink, `#0F766E` / `#0D9488` clearing-emerald accent, `#B45309` amber reveal/pending phase, `#B91C1C` dispute/error crimson), crisp hairline borders (`1px solid #E2E0D8`), tabular monospace numerals (`JetBrains Mono` / system mono fallback with `font-variant-numeric: tabular-nums`) paired with clean geometric grotesk (`Plus Jakarta Sans` / `Inter`). Zero dark-neon crypto clichés, zero glassmorphism, zero hardcoded mock numbers.
- **Dual Execution Modes**: Supports both NEAR Testnet Wallet / RPC connection AND an interactive Live Clearinghouse Workbench connected to the configured RPC + signer accounts (pre-configured demo/sandbox/testnet agent accounts via local API relay or browser key store, plus manual wallet signing) so judges and automated Playwright tests can inspect real settled prints AND drive full commit-reveal auctions directly from the browser.

## Risks / Trade-offs

- **[Risk] Integer precision loss in JavaScript for `yoctoNEAR` (`10^24`)** → **Mitigation**: Serialize all token amounts as decimal strings across contract JSON, NEP-297 events, SQLite text columns, and REST JSON; compute all medians, spreads, and basis-point ratios in `BigInt` before formatting human-readable NEAR values.
- **[Risk] NEP-141 receiver unregistered on FT contract causing payout failure** → **Mitigation**: Hold job in `Settling` lock, attach `1 yoctoNEAR` and explicit gas (`30 TGas` transfer + `30 TGas` callback), inspect `PromiseResult` in `on_settlement_complete`, and roll back to `Delivered` emitting `payout_failed` if `ft_transfer` reverts.
- **[Risk] Buyer surplus transfer failure blocking worker settlement** → **Mitigation**: Credit buyer Vickrey surplus (`reserve_price - clearing_price`) to `claimable_balances[buyer]` (with a separate one-click `withdraw_balance` method or independent transfer) so the worker's `clearing_price` payout promise is completely isolated from buyer account state.
- **[Risk] Testnet faucet rate limits during Tier 4** → **Mitigation**: Use `near-cli-rs` testnet account generation (`generate-key ... --use-faucet`) and sub-accounts funded from a single faucet account so one faucet drip funds contract + buyer + 3 worker agents (`0.5–1 NEAR` each).

## Migration Plan

1. Validate OpenSpec (`tender-mvp`) and commit planning + `DESIGN.md` + `progress.md`.
2. Build and test `contracts/tender` in `near-sandbox` (Tier 1) + cold-context security audit.
3. Build and test `packages/indexer` against real `near-sandbox` RPC blocks/events (Tier 2) + cold-context audit.
4. Build `packages/web` and verify with Playwright full-stack E2E (`near-sandbox` + indexer + Vite) at `375px` and `1440px` + screenshot visual critique (Tier 3).
5. Deploy to NEAR `testnet`, execute scripted multi-agent Vickrey + First-Price auctions, verify explorer/RPC receipts and indexer tape (Tier 4).
6. Finalize `README.md` (with `Design deviations` + official NEAR doc URLs), `LICENSE`, untracked human submission kit, and run clean-clone verification from `/tmp/opencode/clean-clone-verify` (Tier 5).
