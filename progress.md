# ClearTape (upgraded from WageTape) — Autonomous Build Progress

## Clock & Deadline Discipline
- **Hackathon Deadline**: `2026-11-14T23:59:00Z`
- **Iteration 0 Check (`date -u`)**: `2026-11-13T19:09:43Z` (~28 hours 49 minutes remaining)
- **Target Tracks**: Primary `agents` (Agents that Work — price discovery & verifiable clearinghouse for agent labor), Secondary `business` & `security`.

## Brand & Mechanism Refinements
- **Brand Upgrade**: Upgraded from *WageTape* to **ClearTape** — reflecting sealed-bid market clearing + consolidated public trade tape (FINRA TRACE / CME Tape for autonomous AI labor).
- **Mechanism Upgrades**:
  1. **Vickrey Second-Price Reverse Auction** (`clearing_price = min(runner_up_bid, reserve_price)`) alongside First-Price mode so rational AI agents bid true marginal compute/inference cost and buyers capture surplus automatically.
  2. **Optimistic Timeout Settlement (`finalize_after_timeout`)** after `dispute_window_ns` so silent/AFK buyers cannot withhold escrow from honest workers, paired with optional `arbiter`-gated `dispute_delivery` so dishonest buyers cannot unilaterally rug-pull delivered work.
  3. **Objective Buyer-Declared `work_units` + `unit_label` + `spec_sha256` / `deliverable_sha256`** instead of unverifiable worker self-reported output length.

## External Skill & Tooling Audit Log
- `near/agent-skills` (`https://github.com/near/agent-skills`) — Cloned to `/tmp/opencode/near-agent-skills`, inspected all files prior to copying (`0` shell installers, `0` telemetry hooks, pure markdown rules for `near-sdk` v5.x, `near-sandbox`, `near-contract-audit`, `near-api-js`, `near-cli-rs`). Installed into `.agents/skills/`.
- `nexu-io/open-design` — Inspected skills (`design-brief`, `opendesign-frontend`, `d3-visualization`, `impeccable-design-polish`) + active `design-taste-frontend` and `emil-design-eng` skills. Applied directly to `DESIGN.md`.
- Prebuilt Binaries — Installed official `cargo-near v0.23.0` and `near-cli-rs v0.31.1` from GitHub releases after verifying SHA-256 digests.

## Protocol Audit & Documented Deviations
1. **Zero-Attachment Worker Calls for `FunctionCall` Access Keys** (`https://docs.near.org/protocol/access-keys`): NEAR `FunctionCall` keys cannot attach NEAR (`> 0 yoctoNEAR` is rejected by runtime). Therefore `commit_bid`, `reveal_bid`, `submit_delivery`, and `finalize_after_timeout` require `0` attached NEAR; buyer `create_job` covers bounded state storage, while optional Sybil bonds use pre-funded internal vault balances (`deposit_bond` / `withdraw_bond`).
2. **NEP-141 `ft_transfer` 1-yoctoNEAR & Receiver Storage Registration** (`https://docs.near.org/primitives/ft`): NEP-141 `ft_transfer` requires `1 yoctoNEAR` attached by the escrow contract and fails if the recipient is not registered via `storage_deposit` on the token contract. Handled via `Settling`/`Refunding` locks and `#[private]` rollback callbacks.
3. **Contract State Storage Staking (`10^19 yoctoNEAR/byte`)** (`https://docs.near.org/protocol/storage-staking`): The `~770` bytes free threshold applies only to bare account records, not contract state growth. `create_job` measures/reserves exact byte storage at `env::storage_byte_cost()` (`10^19 yoctoNEAR/byte`).
4. **Unverifiable Worker Output Length Replaced by Objective `work_units`**: Self-reported output token counts incentivize padding on a unit-price index and cannot be verified in deterministic WASM; replaced by buyer-specified `work_units` + `unit_label` + SHA-256 content hashes.

## Risk-Ordered Tier Tracker
- [x] **Tier 0 — Spec, Design Brief & Baseline**: OpenSpec `cleartape-mvp` (`proposal.md`, `design.md`, 3 capability specs, `tasks.md`) validated (`openspec validate cleartape-mvp --strict`), `DESIGN.md`, `LICENSE`, `.gitignore`, `progress.md`.
- [x] **Tier 1 — Smart Contract (`contracts/cleartape`)**: Full lifecycle + `near-sandbox` adversarial suite + cold-context audit.
- [ ] **Tier 2 — NEP-297 Indexer & Query API (`packages/indexer`)**: Real NEAR RPC ingestion + `/tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread` + cold-context audit.
- [ ] **Tier 3 — Market Terminal UI (`packages/web` + `e2e/`)**: Real data UI + Playwright full lifecycle + `375px`/`1440px` visual audit + cold-context review.
- [ ] **Tier 4 — NEAR Testnet Deployment & Multi-Agent Demo (`scripts/testnet-demo.mjs`)**: Deployed contract + live settled prints on `testnet`.
- [ ] **Tier 5 — Packaging & Clean-Clone Proof**: `README.md`, untracked human submission payload, clean-clone full-gate verification.

## Tier 1 Audit Log (2026-11-13T20:20Z)

**Toolchain**
- `cargo-near 0.23.0` rejects `rustc > 1.86.0` for `near-sdk 5.24.0` (protocol < 84 / `near-vm-runner 0.34.7`). Pinned `rust-toolchain.toml` at repo root and in `contracts/cleartape` to `1.86.0`; WASM builds and executes in `near-sandbox 0.3.16`.
- Sandbox suite always rebuilds `cleartape.wasm` from current source (`cargo_near_build::build_with_cli`) unless `CLEARTAPE_WASM` is explicitly set, preventing stale-artifact false positives.

**Findings fixed during audit**
1. **Compounding dispute haircut** (`resolve_dispute`): the adjusted `clearing_price` was written before the async payout succeeded; a failed `ft_transfer`/transfer rolled the job back to `Disputed` but kept the already-halved price, so each arbiter retry halved the worker payout again. Fixed by passing an optional `payout_override` through `initiate_settlement` → `on_settlement_complete` and only committing the adjusted price on callback success. Unit test covers failure → rollback → retry at identical 50% (no 25% haircut).
2. **Struct-variant `StorageKey` bloat**: `JobCommits { job_id }` variants are Borsh-serialized with a 9-byte payload. Replaced with distinct unit variants (`JobCommits`, `JobCommitWorkers`, `JobReveals`, `JobRevealWorkers`) so every collection owns an isolated 1-byte prefix.
3. **Callback gas headroom**: `on_settlement_complete` emits a full `job_settled` NEP-297 event and schedules a surplus transfer/callback; `20 TGas` was too tight for the FT path. Raised `CALLBACK_GAS` to `30 TGas` and `MIN_ACTION_GAS` to `65 TGas` across settlement/refund entry points.
4. **`ft_on_transfer` storage parity**: FT job creation now measures actual immediate storage delta and rejects if the pre-funded credit did not cover it (mirrors `create_job`).

**Verified invariants** (unit + sandbox): copied-commit replay fails; cross-job commitment replay fails; wrong-phase commit/reveal fail; reserve-exceeding reveal fails; exact ties resolve by earliest `commit_seq`; unrevealed bonds are slashed to the buyer; zero-reveal auctions refund in full; silent buyers cannot block `finalize_after_timeout`; double settlement fails; failed NEAR/FT payouts roll back and are retryable; `#[private]` callbacks reject external callers; restricted `FunctionCall` Access Key (allowance, 0-deposit) can commit/reveal/deliver/timeout-settle.
