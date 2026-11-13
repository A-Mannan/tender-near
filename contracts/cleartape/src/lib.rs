pub mod events;
pub mod models;

use events::emit_event;
use models::{
    AuctionMechanism, BidCommitment, BondAccountView, CreateJobFtMsg, DeliveryRecord, EscrowToken,
    Job, JobStatus, JobView, RefundReason, RevealedBid, StorageKey,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};

pub const DEFAULT_MAX_COMMITS: u32 = 32;
pub const MAX_COMMITS_CAP: u32 = 64;
/// Conservative upper bound of state bytes per commit+reveal worker slot (AccountId + hash + bid + Vec entry).
pub const BYTES_PER_BID_SLOT: u64 = 320;
/// Base state byte buffer for Job record + delivery metadata.
pub const BASE_JOB_STORAGE_BYTES: u64 = 1_400;

pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
pub const SURPLUS_CALLBACK_GAS: Gas = Gas::from_tgas(10);
pub const MIN_ACTION_GAS: Gas = Gas::from_tgas(55);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ClearTape {
    pub owner_id: AccountId,
    pub next_job_id: u64,
    pub next_commit_seq: u64,
    pub jobs: LookupMap<u64, Job>,
    pub job_commits: LookupMap<(u64, AccountId), BidCommitment>,
    pub job_commit_workers: LookupMap<u64, Vec<AccountId>>,
    pub job_reveals: LookupMap<(u64, AccountId), RevealedBid>,
    pub job_reveal_workers: LookupMap<u64, Vec<AccountId>>,
    pub worker_bonds: LookupMap<AccountId, u128>,
    pub locked_bonds: LookupMap<AccountId, u128>,
    pub claimable_balances: LookupMap<AccountId, u128>,
    pub storage_credits: LookupMap<AccountId, u128>,
}

pub fn is_valid_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn build_commit_preimage(
    contract_id: &AccountId,
    job_id: u64,
    worker_id: &AccountId,
    bid_yocto: u128,
    eta_seconds: u64,
    salt: &str,
) -> String {
    format!(
        "cleartape:v1:{}:{}:{}:{}:{}:{}",
        contract_id, job_id, worker_id, bid_yocto, eta_seconds, salt
    )
}

#[near]
impl ClearTape {
    #[init]
    pub fn new(owner_id: Option<AccountId>) -> Self {
        Self {
            owner_id: owner_id.unwrap_or_else(env::predecessor_account_id),
            next_job_id: 0,
            next_commit_seq: 1,
            jobs: LookupMap::new(StorageKey::Jobs),
            job_commits: LookupMap::new(StorageKey::JobCommits { job_id: 0 }),
            job_commit_workers: LookupMap::new(StorageKey::JobCommits { job_id: 1 }),
            job_reveals: LookupMap::new(StorageKey::JobReveals { job_id: 0 }),
            job_reveal_workers: LookupMap::new(StorageKey::JobReveals { job_id: 1 }),
            worker_bonds: LookupMap::new(StorageKey::WorkerBonds),
            locked_bonds: LookupMap::new(StorageKey::LockedBonds),
            claimable_balances: LookupMap::new(StorageKey::ClaimableBalances),
            storage_credits: LookupMap::new(StorageKey::StorageCredits),
        }
    }

    pub fn required_job_storage_deposit(&self, max_commits: Option<u32>) -> U128 {
        let slots = max_commits.unwrap_or(DEFAULT_MAX_COMMITS);
        require!(
            slots >= 1 && slots <= MAX_COMMITS_CAP,
            "max_commits must be between 1 and 64"
        );
        let total_bytes = BASE_JOB_STORAGE_BYTES
            .checked_add((slots as u64).checked_mul(BYTES_PER_BID_SLOT).unwrap())
            .unwrap();
        let cost = (total_bytes as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap()
            .checked_add(10) // covers up to 10 1-yoctoNEAR NEP-141 transfers
            .unwrap();
        U128(cost)
    }

    /// Pre-fund internal worker bond vault so `commit_bid` remains 0-NEAR Function-Call key safe.
    #[payable]
    pub fn deposit_bond(&mut self, worker_id: Option<AccountId>) -> BondAccountView {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "Must attach positive NEAR bond deposit");
        let target = worker_id.unwrap_or_else(env::predecessor_account_id);
        let before_storage = env::storage_usage();
        let current = self.worker_bonds.get(&target).copied().unwrap_or(0);
        let updated = current.checked_add(deposit).expect("Bond overflow");
        self.worker_bonds.insert(target.clone(), updated);
        self.worker_bonds.flush();
        let after_storage = env::storage_usage();
        let storage_delta = after_storage.saturating_sub(before_storage);
        let storage_fee = (storage_delta as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap();
        require!(
            updated > storage_fee,
            "Deposit must cover initial bond account storage"
        );
        let net_available = updated - storage_fee;
        self.worker_bonds.insert(target.clone(), net_available);

        let locked = self.locked_bonds.get(&target).copied().unwrap_or(0);
        emit_event(
            "bond_updated",
            &json!({
                "worker": target,
                "available_yocto": net_available.to_string(),
                "locked_yocto": locked.to_string(),
                "action": "deposit",
            }),
        );
        BondAccountView {
            worker: target,
            available_yocto: U128(net_available),
            locked_yocto: U128(locked),
        }
    }

    /// Withdraw unlocked worker bond balance.
    #[payable]
    pub fn withdraw_bond(&mut self, amount: U128) -> Promise {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires exactly 1 yoctoNEAR for security"
        );
        require!(amount.0 > 0, "Withdrawal amount must be positive");
        let worker = env::predecessor_account_id();
        let available = self.worker_bonds.get(&worker).copied().unwrap_or(0);
        require!(available >= amount.0, "Insufficient unlocked bond balance");
        let remaining = available - amount.0;
        self.worker_bonds.insert(worker.clone(), remaining);
        let locked = self.locked_bonds.get(&worker).copied().unwrap_or(0);

        Promise::new(worker.clone())
            .transfer(NearToken::from_yoctonear(amount.0 + 1))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SURPLUS_CALLBACK_GAS)
                    .on_bond_withdraw_complete(worker, amount, U128(locked)),
            )
    }

    #[private]
    pub fn on_bond_withdraw_complete(
        &mut self,
        worker: AccountId,
        amount: U128,
        locked: U128,
        #[callback_result] call_result: Result<(), PromiseError>,
    ) -> bool {
        match call_result {
            Ok(()) => {
                let rem = self.worker_bonds.get(&worker).copied().unwrap_or(0);
                emit_event(
                    "bond_updated",
                    &json!({
                        "worker": worker,
                        "available_yocto": rem.to_string(),
                        "locked_yocto": locked.0.to_string(),
                        "action": "withdraw",
                    }),
                );
                true
            }
            Err(_) => {
                let rem = self.worker_bonds.get(&worker).copied().unwrap_or(0);
                self.worker_bonds
                    .insert(worker, rem.saturating_add(amount.0));
                false
            }
        }
    }

    /// Pre-fund storage credits for creating NEP-141 FT-escrowed jobs via `ft_transfer_call`.
    #[payable]
    pub fn register_ft_job_storage(&mut self, buyer_id: Option<AccountId>) -> U128 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "Must attach NEAR for FT job storage");
        let buyer = buyer_id.unwrap_or_else(env::predecessor_account_id);
        let before = env::storage_usage();
        let cur = self.storage_credits.get(&buyer).copied().unwrap_or(0);
        let next = cur.checked_add(deposit).expect("Storage credit overflow");
        self.storage_credits.insert(buyer.clone(), next);
        self.storage_credits.flush();
        let delta = env::storage_usage().saturating_sub(before);
        let fee = (delta as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap();
        require!(next > fee, "Deposit must exceed credit entry storage");
        let net = next - fee;
        self.storage_credits.insert(buyer, net);
        U128(net)
    }

    /// Withdraw any claimable NEAR balance (slashed bonds, fallback surplus refunds).
    pub fn withdraw_claimable(&mut self, recipient: Option<AccountId>) -> Promise {
        let caller = env::predecessor_account_id();
        let bal = self.claimable_balances.get(&caller).copied().unwrap_or(0);
        require!(bal > 0, "No claimable balance");
        self.claimable_balances.insert(caller.clone(), 0);
        let target = recipient.unwrap_or_else(|| caller.clone());
        Promise::new(target).transfer(NearToken::from_yoctonear(bal)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SURPLUS_CALLBACK_GAS)
                .on_claimable_withdraw_complete(caller, U128(bal)),
        )
    }

    #[private]
    pub fn on_claimable_withdraw_complete(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] call_result: Result<(), PromiseError>,
    ) -> bool {
        if call_result.is_err() {
            let cur = self.claimable_balances.get(&account).copied().unwrap_or(0);
            self.claimable_balances
                .insert(account, cur.saturating_add(amount.0));
            false
        } else {
            true
        }
    }

    /// Create a native NEAR-escrowed sealed-bid AI labor job.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_job(
        &mut self,
        title: String,
        category: String,
        spec_sha256: String,
        spec_uri: String,
        work_units: U64,
        unit_label: String,
        reserve_price: U128,
        mechanism: Option<AuctionMechanism>,
        commit_duration_ns: U64,
        reveal_duration_ns: U64,
        delivery_duration_ns: U64,
        dispute_window_ns: U64,
        min_worker_bond: Option<U128>,
        max_commits: Option<u32>,
        arbiter: Option<AccountId>,
    ) -> JobView {
        let buyer = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let storage_req = self.required_job_storage_deposit(max_commits).0;
        let required_total = reserve_price
            .0
            .checked_add(storage_req)
            .expect("Total deposit overflow");
        require!(
            attached >= required_total,
            format!(
                "Insufficient attached NEAR: attached {} yoctoNEAR, need {} (reserve {} + storage {})",
                attached, required_total, reserve_price.0, storage_req
            )
        );

        let before_storage = env::storage_usage();
        let view = self.insert_new_job(
            buyer.clone(),
            title,
            category,
            spec_sha256,
            spec_uri,
            work_units.0,
            unit_label,
            EscrowToken::Near,
            reserve_price.0,
            mechanism.unwrap_or(AuctionMechanism::VickreySecondPrice),
            commit_duration_ns.0,
            reveal_duration_ns.0,
            delivery_duration_ns.0,
            dispute_window_ns.0,
            min_worker_bond.map(|v| v.0).unwrap_or(0),
            max_commits.unwrap_or(DEFAULT_MAX_COMMITS),
            arbiter,
            NearToken::from_yoctonear(storage_req),
        );
        self.jobs.flush();
        self.job_commit_workers.flush();
        self.job_reveal_workers.flush();
        let actual_immediate_cost = (env::storage_usage().saturating_sub(before_storage) as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap();
        require!(
            storage_req >= actual_immediate_cost,
            "Reserved storage did not cover immediate state write"
        );

        let excess = attached - required_total;
        if excess > 0 {
            Promise::new(buyer)
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }
        view
    }

    /// NEP-141 receiver hook (`ft_transfer_call`) to create an FT-escrowed sealed-bid job.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> U128 {
        let token_id = env::predecessor_account_id();
        require!(amount.0 > 0, "FT escrow amount must be > 0");
        let parsed: CreateJobFtMsg =
            near_sdk::serde_json::from_str(&msg).expect("Invalid CreateJobFtMsg JSON");
        let max_commits = parsed.max_commits.unwrap_or(DEFAULT_MAX_COMMITS);
        let storage_req = self.required_job_storage_deposit(Some(max_commits)).0;
        let credit = self.storage_credits.get(&sender_id).copied().unwrap_or(0);
        require!(
            credit >= storage_req,
            "Insufficient storage credit: call register_ft_job_storage first"
        );
        self.storage_credits
            .insert(sender_id.clone(), credit - storage_req);

        self.insert_new_job(
            sender_id,
            parsed.title,
            parsed.category,
            parsed.spec_sha256,
            parsed.spec_uri,
            parsed.work_units.0,
            parsed.unit_label,
            EscrowToken::Ft { token_id },
            amount.0,
            parsed
                .mechanism
                .unwrap_or(AuctionMechanism::VickreySecondPrice),
            parsed.commit_duration_ns.0,
            parsed.reveal_duration_ns.0,
            parsed.delivery_duration_ns.0,
            parsed.dispute_window_ns.0,
            parsed.min_worker_bond.map(|v| v.0).unwrap_or(0),
            max_commits,
            parsed.arbiter,
            NearToken::from_yoctonear(storage_req),
        );
        U128(0)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_new_job(
        &mut self,
        buyer: AccountId,
        title: String,
        category: String,
        spec_sha256: String,
        spec_uri: String,
        work_units: u64,
        unit_label: String,
        escrow_token: EscrowToken,
        reserve_price: u128,
        mechanism: AuctionMechanism,
        commit_duration_ns: u64,
        reveal_duration_ns: u64,
        delivery_duration_ns: u64,
        dispute_window_ns: u64,
        min_worker_bond: u128,
        max_commits: u32,
        arbiter: Option<AccountId>,
        storage_reserved: NearToken,
    ) -> JobView {
        let clean_title = title.trim().to_string();
        let clean_cat = category.trim().to_lowercase();
        let clean_unit = unit_label.trim().to_string();
        let clean_uri = spec_uri.trim().to_string();

        require!(
            !clean_title.is_empty() && clean_title.len() <= 140,
            "title must be 1..=140 chars"
        );
        require!(
            !clean_cat.is_empty() && clean_cat.len() <= 64,
            "category must be 1..=64 chars"
        );
        require!(
            is_valid_hex_sha256(&spec_sha256),
            "spec_sha256 must be 64 lowercase hex characters"
        );
        require!(clean_uri.len() <= 512, "spec_uri must be <= 512 chars");
        require!(work_units >= 1, "work_units must be >= 1");
        require!(
            !clean_unit.is_empty() && clean_unit.len() <= 32,
            "unit_label must be 1..=32 chars"
        );
        require!(reserve_price > 0, "reserve_price must be > 0");
        require!(
            max_commits >= 1 && max_commits <= MAX_COMMITS_CAP,
            "max_commits must be 1..=64"
        );
        require!(commit_duration_ns > 0, "commit_duration_ns must be > 0");
        require!(reveal_duration_ns > 0, "reveal_duration_ns must be > 0");
        require!(delivery_duration_ns > 0, "delivery_duration_ns must be > 0");
        require!(dispute_window_ns > 0, "dispute_window_ns must be > 0");

        let now = env::block_timestamp();
        let commit_deadline_ns = now
            .checked_add(commit_duration_ns)
            .expect("commit_deadline overflow");
        let reveal_deadline_ns = commit_deadline_ns
            .checked_add(reveal_duration_ns)
            .expect("reveal_deadline overflow");

        let job_id = self.next_job_id;
        self.next_job_id = self.next_job_id.checked_add(1).expect("job_id overflow");

        let job = Job {
            job_id,
            buyer: buyer.clone(),
            title: clean_title.clone(),
            category: clean_cat.clone(),
            spec_sha256: spec_sha256.clone(),
            spec_uri: clean_uri,
            work_units,
            unit_label: clean_unit.clone(),
            escrow_token: escrow_token.clone(),
            mechanism,
            reserve_price,
            min_worker_bond,
            max_commits,
            created_at_ns: now,
            commit_deadline_ns,
            reveal_deadline_ns,
            delivery_duration_ns,
            dispute_window_ns,
            delivery_deadline_ns: None,
            arbiter,
            status: JobStatus::Open,
            commit_count: 0,
            reveal_count: 0,
            winner: None,
            payout_account: None,
            winning_bid: None,
            runner_up_bid: None,
            clearing_price: None,
            delivery: None,
            dispute_reason_sha256: None,
            settled_at_ns: None,
            storage_reserved,
        };

        let view = job.to_view(now);
        self.jobs.insert(job_id, job);
        self.job_commit_workers.insert(job_id, Vec::new());
        self.job_reveal_workers.insert(job_id, Vec::new());

        emit_event(
            "job_created",
            &json!({
                "job_id": job_id.to_string(),
                "buyer": buyer,
                "title": clean_title,
                "category": clean_cat,
                "spec_sha256": spec_sha256,
                "work_units": work_units.to_string(),
                "unit_label": clean_unit,
                "escrow_token": escrow_token,
                "mechanism": mechanism,
                "reserve_price": reserve_price.to_string(),
                "min_worker_bond": min_worker_bond.to_string(),
                "commit_deadline_ns": commit_deadline_ns.to_string(),
                "reveal_deadline_ns": reveal_deadline_ns.to_string(),
                "delivery_duration_ns": delivery_duration_ns.to_string(),
                "dispute_window_ns": dispute_window_ns.to_string(),
                "created_at_ns": now.to_string(),
            }),
        );

        view
    }

    /// Submit a sealed SHA-256 bid commitment. Requires 0 attached NEAR (FunctionCall Access Key compatible).
    pub fn commit_bid(&mut self, job_id: U64, commit_hash: String) -> BidCommitment {
        let worker = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = job_id.0;

        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(job.status == JobStatus::Open, "Job is not open for bidding");
        require!(now < job.commit_deadline_ns, "Commit phase has closed");
        require!(worker != job.buyer, "Buyer cannot bid on own job");
        require!(
            is_valid_hex_sha256(&commit_hash),
            "commit_hash must be 64 lowercase hex characters"
        );
        require!(
            !self.job_commits.contains_key(&(id, worker.clone())),
            "Worker already committed a bid for this job"
        );
        require!(
            job.commit_count < job.max_commits,
            "Maximum commitments reached for this job"
        );

        if job.min_worker_bond > 0 {
            let avail = self.worker_bonds.get(&worker).copied().unwrap_or(0);
            require!(
                avail >= job.min_worker_bond,
                "Insufficient available worker bond in vault"
            );
            self.worker_bonds
                .insert(worker.clone(), avail - job.min_worker_bond);
            let locked = self.locked_bonds.get(&worker).copied().unwrap_or(0);
            self.locked_bonds.insert(
                worker.clone(),
                locked.checked_add(job.min_worker_bond).unwrap(),
            );
        }

        let seq = self.next_commit_seq;
        self.next_commit_seq = self.next_commit_seq.checked_add(1).unwrap();

        let commitment = BidCommitment {
            worker: worker.clone(),
            commit_hash: commit_hash.clone(),
            commit_seq: seq,
            committed_at_ns: U64(now),
            locked_bond: U128(job.min_worker_bond),
            revealed: false,
        };

        job.commit_count += 1;
        let commit_count = job.commit_count;
        self.jobs.insert(id, job);
        self.job_commits
            .insert((id, worker.clone()), commitment.clone());

        let mut workers = self
            .job_commit_workers
            .get(&id)
            .cloned()
            .unwrap_or_default();
        workers.push(worker.clone());
        self.job_commit_workers.insert(id, workers);

        emit_event(
            "bid_committed",
            &json!({
                "job_id": id.to_string(),
                "worker": worker,
                "commit_hash": commit_hash,
                "commit_seq": seq,
                "commit_count": commit_count,
                "committed_at_ns": now.to_string(),
            }),
        );

        commitment
    }

    /// Reveal a sealed bid during `[commit_deadline_ns, reveal_deadline_ns)`. Requires 0 attached NEAR.
    pub fn reveal_bid(
        &mut self,
        job_id: U64,
        bid_yocto: U128,
        eta_seconds: U64,
        salt: String,
    ) -> RevealedBid {
        let worker = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = job_id.0;

        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(job.status == JobStatus::Open, "Job is not in revealable state");
        require!(
            now >= job.commit_deadline_ns,
            "Reveal phase has not started yet"
        );
        require!(now < job.reveal_deadline_ns, "Reveal phase has closed");
        require!(bid_yocto.0 > 0, "Bid must be strictly positive");
        require!(
            bid_yocto.0 <= job.reserve_price,
            "Bid exceeds job reserve price"
        );
        require!(eta_seconds.0 > 0, "eta_seconds must be > 0");
        require!(
            salt.len() >= 8 && salt.len() <= 128,
            "salt must be 8..=128 characters"
        );

        let mut commitment = self
            .job_commits
            .get(&(id, worker.clone()))
            .cloned()
            .expect("No commitment found for worker on this job");
        require!(!commitment.revealed, "Bid already revealed");

        let preimage = build_commit_preimage(
            &env::current_account_id(),
            id,
            &worker,
            bid_yocto.0,
            eta_seconds.0,
            &salt,
        );
        let expected_hash = bytes_to_lower_hex(&env::sha256(preimage.as_bytes()));
        require!(
            expected_hash == commitment.commit_hash,
            "Commitment hash mismatch: invalid preimage, account, or job"
        );

        commitment.revealed = true;
        if commitment.locked_bond.0 > 0 {
            let locked = self.locked_bonds.get(&worker).copied().unwrap_or(0);
            self.locked_bonds.insert(
                worker.clone(),
                locked.saturating_sub(commitment.locked_bond.0),
            );
            let avail = self.worker_bonds.get(&worker).copied().unwrap_or(0);
            self.worker_bonds.insert(
                worker.clone(),
                avail.checked_add(commitment.locked_bond.0).unwrap(),
            );
        }
        self.job_commits.insert((id, worker.clone()), commitment.clone());

        let revealed = RevealedBid {
            worker: worker.clone(),
            bid_yocto,
            eta_seconds,
            commit_seq: commitment.commit_seq,
            revealed_at_ns: U64(now),
        };
        self.job_reveals
            .insert((id, worker.clone()), revealed.clone());

        let mut r_workers = self
            .job_reveal_workers
            .get(&id)
            .cloned()
            .unwrap_or_default();
        r_workers.push(worker.clone());
        self.job_reveal_workers.insert(id, r_workers);

        job.reveal_count += 1;
        let reveal_count = job.reveal_count;
        let category = job.category.clone();
        self.jobs.insert(id, job);

        emit_event(
            "bid_revealed",
            &json!({
                "job_id": id.to_string(),
                "category": category,
                "worker": worker,
                "bid_yocto": bid_yocto.0.to_string(),
                "eta_seconds": eta_seconds.0.to_string(),
                "commit_seq": commitment.commit_seq,
                "reveal_count": reveal_count,
                "revealed_at_ns": now.to_string(),
            }),
        );

        revealed
    }

    /// Clear the sealed-bid auction after reveal deadline (or once all committed bids are revealed post-commit window).
    pub fn finalize_auction(&mut self, job_id: U64) {
        let now = env::block_timestamp();
        let id = job_id.0;
        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(job.status == JobStatus::Open, "Auction already finalized");
        let all_committed_revealed =
            now >= job.commit_deadline_ns && job.commit_count > 0 && job.reveal_count == job.commit_count;
        require!(
            now >= job.reveal_deadline_ns || all_committed_revealed,
            "Reveal phase still open"
        );

        // Slash any unrevealed locked bonds and credit them to the buyer's claimable balance.
        let commit_workers = self
            .job_commit_workers
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let mut slashed_total: u128 = 0;
        for w in &commit_workers {
            if let Some(mut c) = self.job_commits.get(&(id, w.clone())).cloned() {
                if !c.revealed && c.locked_bond.0 > 0 {
                    let bond = c.locked_bond.0;
                    c.locked_bond = U128(0);
                    self.job_commits.insert((id, w.clone()), c);
                    let locked = self.locked_bonds.get(w).copied().unwrap_or(0);
                    self.locked_bonds.insert(w.clone(), locked.saturating_sub(bond));
                    slashed_total = slashed_total.checked_add(bond).unwrap();
                }
            }
        }
        if slashed_total > 0 {
            let cur = self.claimable_balances.get(&job.buyer).copied().unwrap_or(0);
            self.claimable_balances
                .insert(job.buyer.clone(), cur.checked_add(slashed_total).unwrap());
        }

        let reveal_workers = self
            .job_reveal_workers
            .get(&id)
            .cloned()
            .unwrap_or_default();
        if reveal_workers.is_empty() {
            require!(
                env::prepaid_gas() >= MIN_ACTION_GAS,
                "Attach at least 55 TGas to finalize zero-reveal refund"
            );
            job.status = JobStatus::Refunding;
            let buyer = job.buyer.clone();
            let reserve = job.reserve_price;
            let token = job.escrow_token.clone();
            self.jobs.insert(id, job);
            self.schedule_transfer_with_refund_callback(
                id,
                buyer,
                reserve,
                token,
                RefundReason::ZeroReveals,
            )
            .detach();
            return;
        }

        let mut reveals: Vec<RevealedBid> = reveal_workers
            .iter()
            .filter_map(|w| self.job_reveals.get(&(id, w.clone())).cloned())
            .collect();

        // Deterministic sort: lowest bid_yocto first; ties broken by earliest sealed commit_seq.
        reveals.sort_by(|a, b| {
            a.bid_yocto
                .0
                .cmp(&b.bid_yocto.0)
                .then_with(|| a.commit_seq.cmp(&b.commit_seq))
        });

        let winner_bid = &reveals[0];
        let runner_up_bid = reveals.get(1).map(|r| r.bid_yocto.0);
        let clearing_price = match job.mechanism {
            AuctionMechanism::FirstPrice => winner_bid.bid_yocto.0,
            AuctionMechanism::VickreySecondPrice => match runner_up_bid {
                Some(second) => std::cmp::min(second, job.reserve_price),
                None => winner_bid.bid_yocto.0,
            },
        };

        let delivery_deadline = now
            .checked_add(job.delivery_duration_ns)
            .expect("delivery_deadline overflow");
        job.status = JobStatus::Assigned;
        job.winner = Some(winner_bid.worker.clone());
        job.payout_account = Some(winner_bid.worker.clone());
        job.winning_bid = Some(winner_bid.bid_yocto.0);
        job.runner_up_bid = runner_up_bid;
        job.clearing_price = Some(clearing_price);
        job.delivery_deadline_ns = Some(delivery_deadline);

        let category = job.category.clone();
        let mechanism = job.mechanism;
        let reserve = job.reserve_price;
        let commit_count = job.commit_count;
        let reveal_count = job.reveal_count;
        let winner_acct = winner_bid.worker.clone();
        let win_amount = winner_bid.bid_yocto.0;
        self.jobs.insert(id, job);

        emit_event(
            "auction_cleared",
            &json!({
                "job_id": id.to_string(),
                "category": category,
                "mechanism": mechanism,
                "winner": winner_acct,
                "reserve_price": reserve.to_string(),
                "winning_bid": win_amount.to_string(),
                "runner_up_bid": runner_up_bid.map(|v| v.to_string()),
                "clearing_price": clearing_price.to_string(),
                "commit_count": commit_count,
                "reveal_count": reveal_count,
                "delivery_deadline_ns": delivery_deadline.to_string(),
                "cleared_at_ns": now.to_string(),
            }),
        );
    }

    /// Submit verifiable deliverable URI + SHA-256 digest. Requires 0 attached NEAR (FunctionCall key safe).
    pub fn submit_delivery(
        &mut self,
        job_id: U64,
        deliverable_uri: String,
        deliverable_sha256: String,
    ) -> JobView {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = job_id.0;

        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(
            job.status == JobStatus::Assigned,
            "Job is not awaiting delivery"
        );
        require!(
            job.winner.as_ref() == Some(&caller),
            "Only the winning worker can submit delivery"
        );
        let deadline = job.delivery_deadline_ns.expect("Missing delivery deadline");
        require!(now < deadline, "Delivery deadline has passed");

        let clean_uri = deliverable_uri.trim().to_string();
        require!(
            !clean_uri.is_empty() && clean_uri.len() <= 512,
            "deliverable_uri must be 1..=512 chars"
        );
        require!(
            is_valid_hex_sha256(&deliverable_sha256),
            "deliverable_sha256 must be 64 lowercase hex characters"
        );

        let dispute_deadline = now
            .checked_add(job.dispute_window_ns)
            .expect("dispute_deadline overflow");
        job.status = JobStatus::Delivered;
        job.delivery = Some(DeliveryRecord {
            deliverable_uri: clean_uri.clone(),
            deliverable_sha256: deliverable_sha256.clone(),
            delivered_at_ns: U64(now),
            dispute_deadline_ns: U64(dispute_deadline),
        });

        let view = job.to_view(now);
        self.jobs.insert(id, job);

        emit_event(
            "delivery_submitted",
            &json!({
                "job_id": id.to_string(),
                "worker": caller,
                "deliverable_uri": clean_uri,
                "deliverable_sha256": deliverable_sha256,
                "delivered_at_ns": now.to_string(),
                "dispute_deadline_ns": dispute_deadline.to_string(),
            }),
        );

        view
    }

    /// Winning worker may update their destination payout account while job is Assigned or Delivered
    /// (enables recovery if an initial payout rolled back due to deleted/unregistered receiver).
    pub fn set_payout_account(&mut self, job_id: U64, payout_account: AccountId) {
        let caller = env::predecessor_account_id();
        let id = job_id.0;
        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(
            job.winner.as_ref() == Some(&caller),
            "Only winning worker can set payout account"
        );
        require!(
            job.status == JobStatus::Assigned || job.status == JobStatus::Delivered,
            "Can only update payout account before settlement completes"
        );
        job.payout_account = Some(payout_account);
        self.jobs.insert(id, job);
    }

    /// Buyer explicitly accepts the deliverable and triggers settlement + Vickrey surplus refund.
    pub fn accept_delivery(&mut self, job_id: U64) -> Promise {
        let caller = env::predecessor_account_id();
        let id = job_id.0;
        let job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(caller == job.buyer, "Only the buyer can accept delivery");
        require!(
            job.status == JobStatus::Delivered || job.status == JobStatus::Disputed,
            "Job is not in Delivered or Disputed state"
        );
        self.initiate_settlement(id, "buyer_accepted".to_string())
    }

    /// Optimistic auto-settlement after `dispute_window_ns` elapses with no dispute.
    /// Requires 0 attached NEAR so Function-Call Access Key worker agents can self-settle.
    pub fn finalize_after_timeout(&mut self, job_id: U64) -> Promise {
        let now = env::block_timestamp();
        let id = job_id.0;
        let job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(
            job.status == JobStatus::Delivered,
            "Job must be in Delivered state for timeout settlement"
        );
        let delivery = job.delivery.as_ref().expect("Missing delivery record");
        require!(
            now >= delivery.dispute_deadline_ns.0,
            "Dispute window has not elapsed yet"
        );
        self.initiate_settlement(id, "timeout_auto_settled".to_string())
    }

    /// Refund buyer if winner fails to deliver before `delivery_deadline_ns`.
    pub fn claim_delivery_timeout(&mut self, job_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_ACTION_GAS,
            "Attach at least 55 TGas"
        );
        let now = env::block_timestamp();
        let id = job_id.0;
        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(
            job.status == JobStatus::Assigned,
            "Job is not awaiting delivery"
        );
        let dl = job.delivery_deadline_ns.expect("Missing delivery deadline");
        require!(now >= dl, "Delivery deadline has not passed yet");

        job.status = JobStatus::Refunding;
        let buyer = job.buyer.clone();
        let reserve = job.reserve_price;
        let token = job.escrow_token.clone();
        self.jobs.insert(id, job);

        self.schedule_transfer_with_refund_callback(
            id,
            buyer,
            reserve,
            token,
            RefundReason::DeliveryTimeout,
        )
    }

    /// Buyer raises a dispute within `dispute_window_ns` (requires a configured `arbiter` on the job).
    pub fn dispute_delivery(&mut self, job_id: U64, reason_sha256: String) -> JobView {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = job_id.0;

        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(caller == job.buyer, "Only buyer can dispute delivery");
        require!(
            job.status == JobStatus::Delivered,
            "Job must be in Delivered state"
        );
        require!(
            job.arbiter.is_some(),
            "Dispute requires a configured arbiter on the job"
        );
        let delivery = job.delivery.as_ref().expect("Missing delivery record");
        require!(
            now < delivery.dispute_deadline_ns.0,
            "Dispute window has closed"
        );
        require!(
            is_valid_hex_sha256(&reason_sha256),
            "reason_sha256 must be 64 lowercase hex characters"
        );

        job.status = JobStatus::Disputed;
        job.dispute_reason_sha256 = Some(reason_sha256.clone());
        let arbiter = job.arbiter.clone();
        let view = job.to_view(now);
        self.jobs.insert(id, job);

        emit_event(
            "job_disputed",
            &json!({
                "job_id": id.to_string(),
                "buyer": caller,
                "arbiter": arbiter,
                "reason_sha256": reason_sha256,
                "disputed_at_ns": now.to_string(),
            }),
        );

        view
    }

    /// Designated arbiter resolves a disputed job (`winner_bps` in `0..=10000` share of `clearing_price`).
    pub fn resolve_dispute(&mut self, job_id: U64, winner_bps: u16) -> Promise {
        require!(winner_bps <= 10_000, "winner_bps must be <= 10000");
        require!(
            env::prepaid_gas() >= MIN_ACTION_GAS,
            "Attach at least 55 TGas"
        );
        let caller = env::predecessor_account_id();
        let id = job_id.0;
        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        require!(job.status == JobStatus::Disputed, "Job is not disputed");
        require!(
            job.arbiter.as_ref() == Some(&caller),
            "Only designated arbiter can resolve dispute"
        );

        if winner_bps == 0 {
            job.status = JobStatus::Refunding;
            let buyer = job.buyer.clone();
            let reserve = job.reserve_price;
            let token = job.escrow_token.clone();
            self.jobs.insert(id, job);
            return self.schedule_transfer_with_refund_callback(
                id,
                buyer,
                reserve,
                token,
                RefundReason::DisputeBuyerFullRefund,
            );
        }

        let orig_clearing = job.clearing_price.expect("Missing clearing price");
        let adjusted = orig_clearing
            .checked_mul(winner_bps as u128)
            .unwrap()
            .checked_div(10_000)
            .unwrap();
        if adjusted == 0 {
            job.status = JobStatus::Refunding;
            let buyer = job.buyer.clone();
            let reserve = job.reserve_price;
            let token = job.escrow_token.clone();
            self.jobs.insert(id, job);
            return self.schedule_transfer_with_refund_callback(
                id,
                buyer,
                reserve,
                token,
                RefundReason::DisputeBuyerFullRefund,
            );
        }

        job.clearing_price = Some(adjusted);
        self.jobs.insert(id, job);
        self.initiate_settlement(id, "arbiter_resolved".to_string())
    }

    fn initiate_settlement(&mut self, id: u64, trigger: String) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_ACTION_GAS,
            "Attach at least 55 TGas for settlement + callback"
        );
        let mut job = self.jobs.get(&id).cloned().expect("Job not found");
        let prev_status = job.status;
        require!(
            prev_status == JobStatus::Delivered || prev_status == JobStatus::Disputed,
            "Job cannot be settled in its current state"
        );

        let clearing_price = job.clearing_price.expect("Missing clearing price");
        let payout_receiver = job
            .payout_account
            .clone()
            .or_else(|| job.winner.clone())
            .expect("Missing winner");
        let token = job.escrow_token.clone();

        // Reentrancy & double-settlement lock BEFORE external transfer promise
        job.status = JobStatus::Settling;
        self.jobs.insert(id, job);

        let transfer_promise = match token {
            EscrowToken::Near => {
                Promise::new(payout_receiver).transfer(NearToken::from_yoctonear(clearing_price))
            }
            EscrowToken::Ft { token_id } => Promise::new(token_id).function_call(
                "ft_transfer".to_string(),
                near_sdk::serde_json::to_vec(&json!({
                    "receiver_id": payout_receiver,
                    "amount": clearing_price.to_string(),
                    "memo": format!("ClearTape job #{} settlement", id),
                }))
                .unwrap(),
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            ),
        };

        transfer_promise.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_settlement_complete(U64(id), trigger, prev_status),
        )
    }

    #[private]
    pub fn on_settlement_complete(
        &mut self,
        job_id: U64,
        trigger: String,
        prev_status: JobStatus,
        #[callback_result] call_result: Result<(), PromiseError>,
    ) -> bool {
        let id = job_id.0;
        let Some(mut job) = self.jobs.get(&id).cloned() else {
            return false;
        };

        match call_result {
            Ok(()) => {
                let now = env::block_timestamp();
                job.status = JobStatus::Settled;
                job.settled_at_ns = Some(now);
                let clearing_price = job.clearing_price.unwrap_or(0);
                let surplus = job.reserve_price.saturating_sub(clearing_price);
                let buyer = job.buyer.clone();
                let token = job.escrow_token.clone();
                let winner = job.winner.clone();
                let winning_bid = job.winning_bid.unwrap_or(clearing_price);
                let runner_up_bid = job.runner_up_bid;
                let unit_price = clearing_price / (job.work_units as u128);
                let deliverable_sha256 = job
                    .delivery
                    .as_ref()
                    .map(|d| d.deliverable_sha256.clone())
                    .unwrap_or_default();
                let deliverable_uri = job
                    .delivery
                    .as_ref()
                    .map(|d| d.deliverable_uri.clone())
                    .unwrap_or_default();

                let category = job.category.clone();
                let title = job.title.clone();
                let mechanism = job.mechanism;
                let reserve = job.reserve_price;
                let work_units = job.work_units;
                let unit_label = job.unit_label.clone();
                let commit_count = job.commit_count;
                let reveal_count = job.reveal_count;
                let spec_sha256 = job.spec_sha256.clone();

                self.jobs.insert(id, job);

                emit_event(
                    "job_settled",
                    &json!({
                        "job_id": id.to_string(),
                        "title": title,
                        "category": category,
                        "mechanism": mechanism,
                        "escrow_token": token,
                        "buyer": buyer,
                        "winner": winner,
                        "reserve_price": reserve.to_string(),
                        "winning_bid": winning_bid.to_string(),
                        "runner_up_bid": runner_up_bid.map(|v| v.to_string()),
                        "clearing_price": clearing_price.to_string(),
                        "surplus_refunded": surplus.to_string(),
                        "unit_price": unit_price.to_string(),
                        "work_units": work_units.to_string(),
                        "unit_label": unit_label,
                        "commit_count": commit_count,
                        "reveal_count": reveal_count,
                        "spec_sha256": spec_sha256,
                        "deliverable_sha256": deliverable_sha256,
                        "deliverable_uri": deliverable_uri,
                        "trigger": trigger,
                        "settled_at_ns": now.to_string(),
                    }),
                );

                // Return Vickrey surplus (reserve_price - clearing_price) to buyer independently
                // so buyer account failure can never block or revert worker settlement.
                if surplus > 0 {
                    match token {
                        EscrowToken::Near => {
                            Promise::new(buyer.clone())
                                .transfer(NearToken::from_yoctonear(surplus))
                                .then(
                                    Self::ext(env::current_account_id())
                                        .with_static_gas(SURPLUS_CALLBACK_GAS)
                                        .on_surplus_refund_complete(buyer, U128(surplus)),
                                )
                                .detach();
                        }
                        EscrowToken::Ft { token_id } => {
                            Promise::new(token_id)
                                .function_call(
                                    "ft_transfer".to_string(),
                                    near_sdk::serde_json::to_vec(&json!({
                                        "receiver_id": buyer,
                                        "amount": surplus.to_string(),
                                        "memo": format!("ClearTape job #{} Vickrey surplus", id),
                                    }))
                                    .unwrap(),
                                    NearToken::from_yoctonear(1),
                                    Gas::from_tgas(10),
                                )
                                .detach();
                        }
                    }
                }
                true
            }
            Err(_) => {
                // Roll back lock cleanly so escrow remains intact and retryable
                let rollback_status = if prev_status == JobStatus::Disputed {
                    JobStatus::Disputed
                } else {
                    JobStatus::Delivered
                };
                let receiver = job.payout_account.clone().or_else(|| job.winner.clone());
                job.status = rollback_status;
                self.jobs.insert(id, job);

                emit_event(
                    "payout_failed",
                    &json!({
                        "job_id": id.to_string(),
                        "receiver": receiver,
                        "rolled_back_to": rollback_status,
                        "failed_at_ns": env::block_timestamp().to_string(),
                    }),
                );
                false
            }
        }
    }

    #[private]
    pub fn on_surplus_refund_complete(
        &mut self,
        buyer: AccountId,
        amount: U128,
        #[callback_result] call_result: Result<(), PromiseError>,
    ) {
        if call_result.is_err() {
            let cur = self.claimable_balances.get(&buyer).copied().unwrap_or(0);
            self.claimable_balances
                .insert(buyer, cur.saturating_add(amount.0));
        }
    }

    fn schedule_transfer_with_refund_callback(
        &self,
        id: u64,
        buyer: AccountId,
        amount: u128,
        token: EscrowToken,
        reason: RefundReason,
    ) -> Promise {
        let p = match token {
            EscrowToken::Near => Promise::new(buyer).transfer(NearToken::from_yoctonear(amount)),
            EscrowToken::Ft { token_id } => Promise::new(token_id).function_call(
                "ft_transfer".to_string(),
                near_sdk::serde_json::to_vec(&json!({
                    "receiver_id": buyer,
                    "amount": amount.to_string(),
                    "memo": format!("ClearTape job #{} refund", id),
                }))
                .unwrap(),
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            ),
        };
        p.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_refund_complete(U64(id), reason),
        )
    }

    #[private]
    pub fn on_refund_complete(
        &mut self,
        job_id: U64,
        reason: RefundReason,
        #[callback_result] call_result: Result<(), PromiseError>,
    ) -> bool {
        let id = job_id.0;
        let Some(mut job) = self.jobs.get(&id).cloned() else {
            return false;
        };

        match call_result {
            Ok(()) => {
                let final_status = match reason {
                    RefundReason::ZeroReveals => JobStatus::CancelledZeroReveals,
                    RefundReason::DeliveryTimeout => JobStatus::ExpiredNoDelivery,
                    RefundReason::DisputeBuyerFullRefund => JobStatus::Refunded,
                };
                job.status = final_status;
                let buyer = job.buyer.clone();
                let reserve = job.reserve_price;
                self.jobs.insert(id, job);

                emit_event(
                    "job_refunded",
                    &json!({
                        "job_id": id.to_string(),
                        "buyer": buyer,
                        "amount": reserve.to_string(),
                        "reason": reason,
                        "status": final_status,
                        "refunded_at_ns": env::block_timestamp().to_string(),
                    }),
                );
                true
            }
            Err(_) => {
                // Roll back so buyer or keeper can retry or withdraw via claimable fallback
                let fallback = match reason {
                    RefundReason::ZeroReveals => JobStatus::Open,
                    RefundReason::DeliveryTimeout => JobStatus::Assigned,
                    RefundReason::DisputeBuyerFullRefund => JobStatus::Disputed,
                };
                let buyer = job.buyer.clone();
                job.status = fallback;
                self.jobs.insert(id, job);

                emit_event(
                    "payout_failed",
                    &json!({
                        "job_id": id.to_string(),
                        "receiver": buyer,
                        "rolled_back_to": fallback,
                        "failed_at_ns": env::block_timestamp().to_string(),
                    }),
                );
                false
            }
        }
    }

    // ==================== Read-Only View Methods ====================

    pub fn get_job(&self, job_id: U64) -> Option<JobView> {
        let now = env::block_timestamp();
        self.jobs.get(&job_id.0).map(|j| j.to_view(now))
    }

    pub fn get_jobs(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<JobView> {
        let start = from_index.map(|v| v.0).unwrap_or(0);
        let take = std::cmp::min(limit.unwrap_or(50), 100) as u64;
        let end = std::cmp::min(self.next_job_id, start.saturating_add(take));
        let now = env::block_timestamp();
        let mut out = Vec::new();
        for id in start..end {
            if let Some(j) = self.jobs.get(&id) {
                out.push(j.to_view(now));
            }
        }
        out
    }

    pub fn get_job_count(&self) -> U64 {
        U64(self.next_job_id)
    }

    pub fn get_commits(&self, job_id: U64) -> Vec<BidCommitment> {
        let id = job_id.0;
        let Some(workers) = self.job_commit_workers.get(&id) else {
            return Vec::new();
        };
        workers
            .iter()
            .filter_map(|w| self.job_commits.get(&(id, w.clone())).cloned())
            .collect()
    }

    pub fn get_reveals(&self, job_id: U64) -> Vec<RevealedBid> {
        let id = job_id.0;
        let Some(workers) = self.job_reveal_workers.get(&id) else {
            return Vec::new();
        };
        workers
            .iter()
            .filter_map(|w| self.job_reveals.get(&(id, w.clone())).cloned())
            .collect()
    }

    pub fn get_worker_bond(&self, worker_id: AccountId) -> BondAccountView {
        BondAccountView {
            available_yocto: U128(self.worker_bonds.get(&worker_id).copied().unwrap_or(0)),
            locked_yocto: U128(self.locked_bonds.get(&worker_id).copied().unwrap_or(0)),
            worker: worker_id,
        }
    }

    pub fn get_claimable_balance(&self, account_id: AccountId) -> U128 {
        U128(self.claimable_balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_storage_credit(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credits.get(&account_id).copied().unwrap_or(0))
    }

    /// Deterministic helper to verify domain-separated preimage hashing.
    /// (Note: Bidders should compute SHA-256 locally in browser WebCrypto or CLI before committing.)
    pub fn compute_commit_hash(
        &self,
        job_id: U64,
        worker_id: AccountId,
        bid_yocto: U128,
        eta_seconds: U64,
        salt: String,
    ) -> String {
        let preimage = build_commit_preimage(
            &env::current_account_id(),
            job_id.0,
            &worker_id,
            bid_yocto.0,
            eta_seconds.0,
            &salt,
        );
        bytes_to_lower_hex(&env::sha256(preimage.as_bytes()))
    }
}

#[cfg(test)]
mod unit_tests;
