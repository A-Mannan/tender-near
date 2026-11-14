# Spec Delta

## Purpose

Defines the on-chain sealed-bid AI labor clearinghouse behavior on NEAR Protocol, covering escrow, storage accounting, domain-separated commit-reveal bidding, Vickrey/First-price clearing, zero-attachment worker key safety, optimistic delivery settlement, and callback-safe payout rollback.

## ADDED Requirements

### Requirement: Escrow-backed job creation with storage reservation
The contract MUST require buyers to fund the full `reserve_price` escrow plus measured on-chain storage cost (`10^19` yoctoNEAR/byte) when creating a job, recording objective `work_units`, `unit_label`, `category`, `spec_sha256`, clearing mechanism, and phase deadlines.

#### Scenario: Valid NEAR-escrowed job creation
- **WHEN** a buyer calls `create_job` with attached NEAR covering `reserve_price` plus storage reserve and valid positive phase durations
- **THEN** the contract creates the job in `CommitOpen` phase, locks `reserve_price` in escrow, refunds any excess NEAR above `reserve_price + storage_deposit`, and emits a NEP-297 `job_created` event

#### Scenario: Insufficient escrow attachment rejected
- **WHEN** a buyer calls `create_job` with attached NEAR less than `reserve_price` plus measured storage cost
- **THEN** the contract panics and reverts without storing the job

### Requirement: Domain-separated zero-attachment bid commitment
The contract SHALL accept sealed bid commitments during the commit window with `0` attached NEAR so Function-Call Access Key worker agents can participate, binding commitments to `contract_id`, `job_id`, and `predecessor_account_id`.

#### Scenario: Worker agent commits with Function-Call Access Key
- **WHEN** a worker signs `commit_bid` using a restricted Function-Call Access Key (`0` attached NEAR) before `commit_deadline_ns` on an unbonded job
- **THEN** the contract records the worker's `commit_hash` and monotonic `commit_seq` and emits `bid_committed`

#### Scenario: Bonded job locks pre-funded worker bond
- **WHEN** a job specifies `min_worker_bond > 0` and a worker with sufficient internal bond vault balance calls `commit_bid`
- **THEN** the contract locks `min_worker_bond` from the worker's available bond balance without requiring attached NEAR on the `commit_bid` call

#### Scenario: Commit outside commit window or by job buyer rejected
- **WHEN** a caller submits `commit_bid` at or after `commit_deadline_ns`, submits a duplicate commit for the same account, or is the job's buyer
- **THEN** the contract rejects the call

### Requirement: Cryptographic reveal verification and replay resistance
The contract MUST accept `reveal_bid` only during `[commit_deadline_ns, reveal_deadline_ns)` and verify `SHA256("tender:v1:" || contract_id || ":" || job_id || ":" || worker_id || ":" || bid_yocto || ":" || eta_seconds || ":" || salt)` equals the stored `commit_hash` with `0 < bid_yocto <= reserve_price`.

#### Scenario: Copied commit hash replay fails
- **WHEN** attacker `eve` copies `alice`'s `commit_hash` during the commit phase and submits `alice`'s `(bid_yocto, eta_seconds, salt)` during the reveal phase
- **THEN** the contract computes the preimage with `eve`'s account ID, detects hash mismatch, and rejects the reveal

#### Scenario: Cross-job commitment replay fails
- **WHEN** a worker reuses a `commit_hash` generated for `job_id = 0` on `job_id = 1` and attempts to reveal
- **THEN** the contract computes the preimage with `job_id = 1`, detects hash mismatch, and rejects the reveal

#### Scenario: Bid exceeding reserve price rejected
- **WHEN** a worker reveals a preimage whose `bid_yocto` exceeds the job's `reserve_price` or equals zero
- **THEN** the contract rejects the reveal

### Requirement: Deterministic auction clearing and Vickrey pricing
After `reveal_deadline_ns` (or once all committed workers have revealed after `commit_deadline_ns`), `finalize_auction` MUST select the lowest `bid_yocto` winner—breaking ties deterministically by earliest `commit_seq`—and set `clearing_price` to `min(runner_up_bid, reserve_price)` in Vickrey mode (or `winning_bid` when single reveal / First-Price mode).

#### Scenario: Multi-bidder Vickrey second-price clearing
- **WHEN** three workers reveal valid bids of `1.2 NEAR`, `1.8 NEAR`, and `2.4 NEAR` on a `3.0 NEAR` reserve Vickrey job and `finalize_auction` is called
- **THEN** the `1.2 NEAR` bidder wins, `clearing_price` is set to `1.8 NEAR`, `runner_up_bid` is recorded as `1.8 NEAR`, revealed worker bonds unlock, and `auction_cleared` is emitted

#### Scenario: Deterministic tie-breaking by sealed commit order
- **WHEN** two workers reveal identical lowest `bid_yocto` values
- **THEN** the worker with the smaller `commit_seq` wins deterministically

#### Scenario: Zero valid reveals triggers safe buyer refund
- **WHEN** `finalize_auction` runs after `reveal_deadline_ns` and zero valid bids were revealed
- **THEN** the contract transitions to `Refunding`, transfers escrowed funds back to the buyer, and finalizes `CancelledZeroReveals` in a private callback

### Requirement: Verifiable delivery and optimistic timeout settlement
The winning worker MUST submit a `deliverable_uri` and 64-char hex `deliverable_sha256` before `delivery_deadline_ns`; settlement SHALL occur either immediately upon buyer `accept_delivery` or permissionlessly via `finalize_after_timeout` once `dispute_window_ns` elapses without buyer dispute.

#### Scenario: Buyer accepts delivery and receives Vickrey surplus refund
- **WHEN** the buyer calls `accept_delivery` on a `Delivered` job where `reserve_price > clearing_price`
- **THEN** the contract transitions to `Settling`, transfers `clearing_price` to the winner and `reserve_price - clearing_price` surplus to the buyer, and upon callback success marks the job `Settled` and emits `job_settled`

#### Scenario: Silent buyer auto-settlement after dispute window
- **WHEN** the worker submits valid delivery and `dispute_window_ns` elapses without `accept_delivery` or `dispute_delivery`
- **THEN** the worker (even using a `0`-deposit Function-Call Access Key) calls `finalize_after_timeout` and receives `clearing_price` settlement

### Requirement: Callback-verified payout safety and failed-transfer rollback
Every outgoing native NEAR or NEP-141 FT payout or refund MUST set an in-flight `Settling` or `Refunding` lock prior to scheduling promises and verify `PromiseResult` inside a `#[private]` callback, rolling back state on failure and preventing double payouts.

#### Scenario: Failed payout rolls back without losing escrow
- **WHEN** settlement is triggered but the payout transfer fails (such as a deleted receiver account or unregistered NEP-141 FT receiver)
- **THEN** the `#[private]` callback observes `Err`, restores job status from `Settling` back to `Delivered` with escrow intact, and does NOT emit `job_settled`

#### Scenario: Double settlement attempt rejected
- **WHEN** any caller invokes `accept_delivery` or `finalize_after_timeout` while a job is `Settling` or already `Settled`
- **THEN** the contract rejects the duplicate payout attempt
