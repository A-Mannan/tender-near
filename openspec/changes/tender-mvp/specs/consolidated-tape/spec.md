# Spec Delta

## Purpose

Defines the NEP-297 on-chain event tape schema, idempotent NEAR RPC receipt ingestion, and public price-index query endpoints (`/tape`, `/tape/median`, `/tape/win-rate`, `/tape/spread`).

## ADDED Requirements

### Requirement: Structured NEP-297 event emission
Every clearinghouse state transition MUST emit a valid `EVENT_JSON:` log conforming to NEP-297 with `standard: "tender"` and `version: "1.0.0"`, carrying string-encoded yoctoNEAR amounts and block/timestamp provenance.

#### Scenario: Settled job emits complete tape print
- **WHEN** a job completes settlement in its callback
- **THEN** the contract logs `EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"job_settled","data":[...]}` including `job_id`, `category`, `mechanism`, `buyer`, `winner`, `reserve_price`, `winning_bid`, `runner_up_bid`, `clearing_price`, `work_units`, `unit_label`, `commit_count`, `reveal_count`, `deliverable_sha256`, and `settled_at_ns`

### Requirement: Idempotent NEAR RPC receipt indexing
The indexer SHALL ingest real NEAR blocks and transaction/receipt execution outcomes from the configured NEAR RPC endpoint, persist NEP-297 `tender` events keyed by `(receipt_id, log_index)`, and never duplicate records across restarts or re-polls.

#### Scenario: Re-ingesting already indexed block range
- **WHEN** the indexer polls or replays a block height range whose receipts were already ingested
- **THEN** row counts, medians, spreads, and win rates remain identical without duplicate prints

### Requirement: Consolidated tape and benchmark API endpoints
The query API MUST serve `GET /tape`, `GET /tape/median`, `GET /tape/win-rate`, and `GET /tape/spread` strictly from indexed contract events and live contract view calls, returning honest empty structures (`count: 0`, `median_clearing_yocto: null`) when no settled jobs exist.

#### Scenario: Querying median, spread, and win-rate after multi-agent auctions
- **WHEN** settled and revealed auctions have been indexed and a client queries `/tape`, `/tape/median`, `/tape/win-rate`, and `/tape/spread`
- **THEN** `/tape` returns chronological settled prints, `/tape/median` returns exact overall and per-category median clearing and unit prices, `/tape/win-rate` returns per-worker wins/reveals/commits ratios, and `/tape/spread` returns competitive bid spread (`runner_up - winning_bid`) and buyer savings (`reserve - clearing`) in basis points
