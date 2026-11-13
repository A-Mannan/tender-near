use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, BorshStorageKey, NearToken, near};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Jobs,
    JobCommits { job_id: u64 },
    JobReveals { job_id: u64 },
    WorkerBonds,
    LockedBonds,
    ClaimableBalances,
    StorageCredits,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuctionMechanism {
    VickreySecondPrice,
    FirstPrice,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EscrowToken {
    Near,
    Ft { token_id: AccountId },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Assigned,
    Delivered,
    Disputed,
    Settling,
    Settled,
    Refunding,
    CancelledZeroReveals,
    ExpiredNoDelivery,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundReason {
    ZeroReveals,
    DeliveryTimeout,
    DisputeBuyerFullRefund,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BidCommitment {
    pub worker: AccountId,
    pub commit_hash: String,
    pub commit_seq: u64,
    pub committed_at_ns: U64,
    pub locked_bond: U128,
    pub revealed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RevealedBid {
    pub worker: AccountId,
    pub bid_yocto: U128,
    pub eta_seconds: U64,
    pub commit_seq: u64,
    pub revealed_at_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct DeliveryRecord {
    pub deliverable_uri: String,
    pub deliverable_sha256: String,
    pub delivered_at_ns: U64,
    pub dispute_deadline_ns: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub job_id: u64,
    pub buyer: AccountId,
    pub title: String,
    pub category: String,
    pub spec_sha256: String,
    pub spec_uri: String,
    pub work_units: u64,
    pub unit_label: String,
    pub escrow_token: EscrowToken,
    pub mechanism: AuctionMechanism,
    pub reserve_price: u128,
    pub min_worker_bond: u128,
    pub max_commits: u32,
    pub created_at_ns: u64,
    pub commit_deadline_ns: u64,
    pub reveal_deadline_ns: u64,
    pub delivery_duration_ns: u64,
    pub dispute_window_ns: u64,
    pub delivery_deadline_ns: Option<u64>,
    pub arbiter: Option<AccountId>,
    pub status: JobStatus,
    pub commit_count: u32,
    pub reveal_count: u32,
    pub winner: Option<AccountId>,
    pub payout_account: Option<AccountId>,
    pub winning_bid: Option<u128>,
    pub runner_up_bid: Option<u128>,
    pub clearing_price: Option<u128>,
    pub delivery: Option<DeliveryRecord>,
    pub dispute_reason_sha256: Option<String>,
    pub settled_at_ns: Option<u64>,
    pub storage_reserved: NearToken,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CreateJobFtMsg {
    pub title: String,
    pub category: String,
    pub spec_sha256: String,
    pub spec_uri: String,
    pub work_units: U64,
    pub unit_label: String,
    pub mechanism: Option<AuctionMechanism>,
    pub commit_duration_ns: U64,
    pub reveal_duration_ns: U64,
    pub delivery_duration_ns: U64,
    pub dispute_window_ns: U64,
    pub min_worker_bond: Option<U128>,
    pub max_commits: Option<u32>,
    pub arbiter: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobView {
    pub job_id: U64,
    pub buyer: AccountId,
    pub title: String,
    pub category: String,
    pub spec_sha256: String,
    pub spec_uri: String,
    pub work_units: U64,
    pub unit_label: String,
    pub escrow_token: EscrowToken,
    pub mechanism: AuctionMechanism,
    pub reserve_price: U128,
    pub min_worker_bond: U128,
    pub max_commits: u32,
    pub created_at_ns: U64,
    pub commit_deadline_ns: U64,
    pub reveal_deadline_ns: U64,
    pub delivery_duration_ns: U64,
    pub dispute_window_ns: U64,
    pub delivery_deadline_ns: Option<U64>,
    pub arbiter: Option<AccountId>,
    pub status: JobStatus,
    pub phase: String,
    pub commit_count: u32,
    pub reveal_count: u32,
    pub winner: Option<AccountId>,
    pub payout_account: Option<AccountId>,
    pub winning_bid: Option<U128>,
    pub runner_up_bid: Option<U128>,
    pub clearing_price: Option<U128>,
    pub unit_price: Option<U128>,
    pub delivery: Option<DeliveryRecord>,
    pub dispute_reason_sha256: Option<String>,
    pub settled_at_ns: Option<U64>,
}

impl Job {
    pub fn compute_phase(&self, now_ns: u64) -> &'static str {
        match self.status {
            JobStatus::Open => {
                if now_ns < self.commit_deadline_ns {
                    "CommitOpen"
                } else if now_ns < self.reveal_deadline_ns {
                    "RevealOpen"
                } else {
                    "AwaitingClear"
                }
            }
            JobStatus::Assigned => {
                if let Some(dl) = self.delivery_deadline_ns {
                    if now_ns >= dl {
                        "DeliveryExpired"
                    } else {
                        "Assigned"
                    }
                } else {
                    "Assigned"
                }
            }
            JobStatus::Delivered => {
                if let Some(ref d) = self.delivery {
                    if now_ns >= d.dispute_deadline_ns.0 {
                        "ReadyAutoSettle"
                    } else {
                        "Delivered"
                    }
                } else {
                    "Delivered"
                }
            }
            JobStatus::Disputed => "Disputed",
            JobStatus::Settling => "Settling",
            JobStatus::Settled => "Settled",
            JobStatus::Refunding => "Refunding",
            JobStatus::CancelledZeroReveals => "CancelledZeroReveals",
            JobStatus::ExpiredNoDelivery => "ExpiredNoDelivery",
            JobStatus::Refunded => "Refunded",
        }
    }

    pub fn to_view(&self, now_ns: u64) -> JobView {
        let unit_price = self
            .clearing_price
            .and_then(|cp| cp.checked_div(self.work_units as u128))
            .map(U128);
        JobView {
            job_id: U64(self.job_id),
            buyer: self.buyer.clone(),
            title: self.title.clone(),
            category: self.category.clone(),
            spec_sha256: self.spec_sha256.clone(),
            spec_uri: self.spec_uri.clone(),
            work_units: U64(self.work_units),
            unit_label: self.unit_label.clone(),
            escrow_token: self.escrow_token.clone(),
            mechanism: self.mechanism,
            reserve_price: U128(self.reserve_price),
            min_worker_bond: U128(self.min_worker_bond),
            max_commits: self.max_commits,
            created_at_ns: U64(self.created_at_ns),
            commit_deadline_ns: U64(self.commit_deadline_ns),
            reveal_deadline_ns: U64(self.reveal_deadline_ns),
            delivery_duration_ns: U64(self.delivery_duration_ns),
            dispute_window_ns: U64(self.dispute_window_ns),
            delivery_deadline_ns: self.delivery_deadline_ns.map(U64),
            arbiter: self.arbiter.clone(),
            status: self.status,
            phase: self.compute_phase(now_ns).to_string(),
            commit_count: self.commit_count,
            reveal_count: self.reveal_count,
            winner: self.winner.clone(),
            payout_account: self.payout_account.clone(),
            winning_bid: self.winning_bid.map(U128),
            runner_up_bid: self.runner_up_bid.map(U128),
            clearing_price: self.clearing_price.map(U128),
            unit_price,
            delivery: self.delivery.clone(),
            dispute_reason_sha256: self.dispute_reason_sha256.clone(),
            settled_at_ns: self.settled_at_ns.map(U64),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BondAccountView {
    pub worker: AccountId,
    pub available_yocto: U128,
    pub locked_yocto: U128,
}
