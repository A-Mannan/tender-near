use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseError, testing_env};

const SPEC_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DELIV_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REASON_HASH: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(caller: &str, now_ns: u64, deposit_yocto: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct("tender.testnet"))
        .signer_account_id(acct(caller))
        .predecessor_account_id(acct(caller))
        .block_timestamp(now_ns)
        .prepaid_gas(Gas::from_tgas(200))
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto));
    b
}

#[test]
fn vickrey_second_price_lifecycle_and_nep297_events() {
    testing_env!(ctx("owner.testnet", 1_000, 0).build());
    let mut ct = Tender::new(None);
    let storage_req = ct.required_job_storage_deposit(Some(16)).0;
    let reserve = NearToken::from_near(3).as_yoctonear();

    // Buyer creates job
    testing_env!(ctx("buyer.testnet", 1_000, reserve + storage_req).build());
    let job = ct.create_job(
        "Audit Rust Escrow Contract".to_string(),
        "smart-contract-audit".to_string(),
        SPEC_HASH.to_string(),
        "ipfs://spec".to_string(),
        U64(3),
        "kloc".to_string(),
        U128(reserve),
        Some(AuctionMechanism::VickreySecondPrice),
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(2_000),
        None,
        Some(16),
        None,
    );
    assert_eq!(job.job_id.0, 0);
    assert_eq!(job.phase, "CommitOpen");

    // Compute domain-separated hashes for 3 workers: 1.2 NEAR, 1.8 NEAR, 2.4 NEAR
    let b1 = NearToken::from_millinear(1_200).as_yoctonear();
    let b2 = NearToken::from_millinear(1_800).as_yoctonear();
    let b3 = NearToken::from_millinear(2_400).as_yoctonear();
    let h1 = ct.compute_commit_hash(U64(0), acct("w1.testnet"), U128(b1), U64(120), "salt_worker_1".to_string());
    let h2 = ct.compute_commit_hash(U64(0), acct("w2.testnet"), U128(b2), U64(180), "salt_worker_2".to_string());
    let h3 = ct.compute_commit_hash(U64(0), acct("w3.testnet"), U128(b3), U64(240), "salt_worker_3".to_string());

    // Zero-deposit commits (Function-Call Access Key safe)
    testing_env!(ctx("w1.testnet", 1_200, 0).build());
    ct.commit_bid(U64(0), h1);
    testing_env!(ctx("w2.testnet", 1_300, 0).build());
    ct.commit_bid(U64(0), h2);
    testing_env!(ctx("w3.testnet", 1_400, 0).build());
    ct.commit_bid(U64(0), h3);

    // Reveal during [2000, 3000)
    testing_env!(ctx("w1.testnet", 2_100, 0).build());
    ct.reveal_bid(U64(0), U128(b1), U64(120), "salt_worker_1".to_string());
    testing_env!(ctx("w2.testnet", 2_200, 0).build());
    ct.reveal_bid(U64(0), U128(b2), U64(180), "salt_worker_2".to_string());
    testing_env!(ctx("w3.testnet", 2_300, 0).build());
    ct.reveal_bid(U64(0), U128(b3), U64(240), "salt_worker_3".to_string());

    // Clear auction
    testing_env!(ctx("keeper.testnet", 3_000, 0).build());
    ct.finalize_auction(U64(0));
    let cleared = ct.get_job(U64(0)).unwrap();
    assert_eq!(cleared.status, JobStatus::Assigned);
    assert_eq!(cleared.winner, Some(acct("w1.testnet")));
    assert_eq!(cleared.winning_bid, Some(U128(b1)));
    assert_eq!(cleared.runner_up_bid, Some(U128(b2)));
    // Vickrey second-price: winner w1 (1.2 NEAR) is paid runner-up w2's bid (1.8 NEAR)!
    assert_eq!(cleared.clearing_price, Some(U128(b2)));
    assert_eq!(cleared.unit_price, Some(U128(b2 / 3)));

    // Submit delivery
    testing_env!(ctx("w1.testnet", 4_000, 0).build());
    ct.submit_delivery(U64(0), "ipfs://audit-report".to_string(), DELIV_HASH.to_string());

    // Simulate failed payout callback first -> rolls back to Delivered!
    testing_env!(ctx("buyer.testnet", 4_500, 0).build());
    let _ = ct.accept_delivery(U64(0));
    assert_eq!(ct.get_job(U64(0)).unwrap().status, JobStatus::Settling);

    testing_env!(ctx("tender.testnet", 4_501, 0).build());
    let ok = ct.on_settlement_complete(
        U64(0),
        "buyer_accepted".to_string(),
        JobStatus::Delivered,
        None,
        Err(PromiseError::Failed),
    );
    assert!(!ok);
    assert_eq!(ct.get_job(U64(0)).unwrap().status, JobStatus::Delivered);

    // Retry settlement via timeout after dispute_window_ns (4000 + 2000 = 6000) -> succeeds!
    testing_env!(ctx("w1.testnet", 6_500, 0).build());
    let _ = ct.finalize_after_timeout(U64(0));
    testing_env!(ctx("tender.testnet", 6_501, 0).build());
    let ok2 = ct.on_settlement_complete(
        U64(0),
        "timeout_auto_settled".to_string(),
        JobStatus::Delivered,
        None,
        Ok(()),
    );
    assert!(ok2);
    let settled = ct.get_job(U64(0)).unwrap();
    assert_eq!(settled.status, JobStatus::Settled);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"job_settled\"")));
}

#[test]
#[should_panic(expected = "Commitment hash mismatch")]
fn copied_commit_hash_by_attacker_fails_on_reveal() {
    testing_env!(ctx("owner.testnet", 1_000, 0).build());
    let mut ct = Tender::new(None);
    let req = ct.required_job_storage_deposit(Some(8)).0;
    let reserve = NearToken::from_near(2).as_yoctonear();

    testing_env!(ctx("buyer.testnet", 1_000, reserve + req).build());
    ct.create_job(
        "Summarize Papers".to_string(),
        "research-synthesis".to_string(),
        SPEC_HASH.to_string(),
        "".to_string(),
        U64(10),
        "papers".to_string(),
        U128(reserve),
        None,
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(1_000),
        None,
        Some(8),
        None,
    );

    let alice_bid = NearToken::from_near(1).as_yoctonear();
    let alice_hash = ct.compute_commit_hash(
        U64(0),
        acct("alice.testnet"),
        U128(alice_bid),
        U64(60),
        "alice_secret_salt".to_string(),
    );

    testing_env!(ctx("alice.testnet", 1_100, 0).build());
    ct.commit_bid(U64(0), alice_hash.clone());

    // Eve copies Alice's exact commit_hash on chain
    testing_env!(ctx("eve.testnet", 1_200, 0).build());
    ct.commit_bid(U64(0), alice_hash);

    // Alice reveals -> Eve sees Alice's (bid, eta, salt) and replays them -> MUST PANIC!
    testing_env!(ctx("eve.testnet", 2_200, 0).build());
    ct.reveal_bid(U64(0), U128(alice_bid), U64(60), "alice_secret_salt".to_string());
}

#[test]
#[should_panic(expected = "Commitment hash mismatch")]
fn cross_job_commitment_replay_fails() {
    testing_env!(ctx("owner.testnet", 1_000, 0).build());
    let mut ct = Tender::new(None);
    let req = ct.required_job_storage_deposit(Some(8)).0;
    let reserve = NearToken::from_near(2).as_yoctonear();

    testing_env!(ctx("buyer.testnet", 1_000, reserve + req).build());
    ct.create_job(
        "Job Zero".to_string(),
        "code-generation".to_string(),
        SPEC_HASH.to_string(),
        "".to_string(),
        U64(1),
        "module".to_string(),
        U128(reserve),
        None,
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(1_000),
        None,
        Some(8),
        None,
    );

    testing_env!(ctx("buyer.testnet", 1_000, reserve + req).build());
    ct.create_job(
        "Job One".to_string(),
        "code-generation".to_string(),
        SPEC_HASH.to_string(),
        "".to_string(),
        U64(1),
        "module".to_string(),
        U128(reserve),
        None,
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(1_000),
        None,
        Some(8),
        None,
    );

    let bid = NearToken::from_near(1).as_yoctonear();
    let hash_for_job_0 = ct.compute_commit_hash(
        U64(0),
        acct("alice.testnet"),
        U128(bid),
        U64(60),
        "reused_salt_123".to_string(),
    );

    // Alice commits hash generated for job 0 onto job 1
    testing_env!(ctx("alice.testnet", 1_200, 0).build());
    ct.commit_bid(U64(1), hash_for_job_0);

    testing_env!(ctx("alice.testnet", 2_200, 0).build());
    ct.reveal_bid(U64(1), U128(bid), U64(60), "reused_salt_123".to_string());
}

#[test]
fn exact_tie_broken_by_earliest_commit_seq_and_bond_slashing() {
    testing_env!(ctx("owner.testnet", 1_000, 0).build());
    let mut ct = Tender::new(None);
    let req = ct.required_job_storage_deposit(Some(8)).0;
    let reserve = NearToken::from_near(2).as_yoctonear();
    let min_bond = NearToken::from_millinear(100).as_yoctonear();

    // Deposit worker bonds for w1, w2, w_flake
    for w in ["w1.testnet", "w2.testnet", "flake.testnet"] {
        testing_env!(ctx(w, 1_000, NearToken::from_millinear(200).as_yoctonear()).build());
        ct.deposit_bond(None);
    }

    testing_env!(ctx("buyer.testnet", 1_000, reserve + req).build());
    ct.create_job(
        "Bonded Labeling".to_string(),
        "data-labeling".to_string(),
        SPEC_HASH.to_string(),
        "".to_string(),
        U64(500),
        "rows".to_string(),
        U128(reserve),
        Some(AuctionMechanism::FirstPrice),
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(1_000),
        Some(U128(min_bond)),
        Some(8),
        Some(acct("arbiter.testnet")),
    );

    let tie_bid = NearToken::from_near(1).as_yoctonear();
    let h2 = ct.compute_commit_hash(U64(0), acct("w2.testnet"), U128(tie_bid), U64(30), "salt_two_888".to_string());
    let h1 = ct.compute_commit_hash(U64(0), acct("w1.testnet"), U128(tie_bid), U64(10), "salt_one_888".to_string());
    let hf = ct.compute_commit_hash(U64(0), acct("flake.testnet"), U128(tie_bid), U64(10), "salt_flk_888".to_string());

    // w2 commits FIRST, w1 commits SECOND, flake commits THIRD (and never reveals)
    testing_env!(ctx("w2.testnet", 1_100, 0).build());
    ct.commit_bid(U64(0), h2);
    testing_env!(ctx("w1.testnet", 1_200, 0).build());
    ct.commit_bid(U64(0), h1);
    testing_env!(ctx("flake.testnet", 1_300, 0).build());
    ct.commit_bid(U64(0), hf);

    // w1 reveals BEFORE w2 in reveal phase, with identical bid -> w2 STILL wins because w2 committed earlier!
    testing_env!(ctx("w1.testnet", 2_100, 0).build());
    ct.reveal_bid(U64(0), U128(tie_bid), U64(10), "salt_one_888".to_string());
    testing_env!(ctx("w2.testnet", 2_500, 0).build());
    ct.reveal_bid(U64(0), U128(tie_bid), U64(30), "salt_two_888".to_string());

    // Finalize after reveal_deadline_ns (3000) because flake did not reveal
    testing_env!(ctx("keeper.testnet", 3_100, 0).build());
    ct.finalize_auction(U64(0));

    let job = ct.get_job(U64(0)).unwrap();
    assert_eq!(job.winner, Some(acct("w2.testnet")));
    assert_eq!(job.clearing_price, Some(U128(tie_bid)));
    // flake's unrevealed bond was slashed and credited to buyer!
    assert_eq!(ct.get_claimable_balance(acct("buyer.testnet")).0, min_bond);
    assert_eq!(ct.get_worker_bond(acct("flake.testnet")).locked_yocto.0, 0);

    // Test arbitrated dispute path
    testing_env!(ctx("w2.testnet", 4_000, 0).build());
    ct.submit_delivery(U64(0), "ipfs://rows".to_string(), DELIV_HASH.to_string());

    testing_env!(ctx("buyer.testnet", 4_200, 0).build());
    let disp = ct.dispute_delivery(U64(0), REASON_HASH.to_string());
    assert_eq!(disp.status, JobStatus::Disputed);

    // Arbiter awards 50% (5000 bps)
    testing_env!(ctx("arbiter.testnet", 4_500, 0).build());
    let _ = ct.resolve_dispute(U64(0), 5_000);
    let settling = ct.get_job(U64(0)).unwrap();
    assert_eq!(settling.status, JobStatus::Settling);
    assert_eq!(
        settling.clearing_price,
        Some(U128(tie_bid)),
        "adjusted price must not be committed before payout succeeds"
    );

    // Simulate async payout failure: rollback must preserve the original clearing price
    testing_env!(ctx("tender.testnet", 4_501, 0).build());
    let failed = ct.on_settlement_complete(
        U64(0),
        "arbiter_resolved".to_string(),
        JobStatus::Disputed,
        Some(U128(tie_bid / 2)),
        Err(PromiseError::Failed),
    );
    assert!(!failed);
    let rolled = ct.get_job(U64(0)).unwrap();
    assert_eq!(rolled.status, JobStatus::Disputed);
    assert_eq!(
        rolled.clearing_price,
        Some(U128(tie_bid)),
        "rollback must not leave the 50% haircut applied"
    );

    // Retry at 50% -> same adjusted payout, no compounding 25% haircut
    testing_env!(ctx("arbiter.testnet", 4_600, 0).build());
    let _ = ct.resolve_dispute(U64(0), 5_000);
    testing_env!(ctx("tender.testnet", 4_601, 0).build());
    let ok = ct.on_settlement_complete(
        U64(0),
        "arbiter_resolved".to_string(),
        JobStatus::Disputed,
        Some(U128(tie_bid / 2)),
        Ok(()),
    );
    assert!(ok);
    let settled = ct.get_job(U64(0)).unwrap();
    assert_eq!(settled.status, JobStatus::Settled);
    assert_eq!(settled.clearing_price, Some(U128(tie_bid / 2)));
}

#[test]
fn dispute_timeout_settles_when_arbiter_never_resolves() {
    testing_env!(ctx("owner.testnet", 1_000, 0).build());
    let mut ct = Tender::new(None);
    let req = ct.required_job_storage_deposit(Some(8)).0;
    let reserve = NearToken::from_near(2).as_yoctonear();

    testing_env!(ctx("buyer.testnet", 1_000, reserve + req).build());
    ct.create_job(
        "Arbiter Liveness".to_string(),
        "code-generation".to_string(),
        SPEC_HASH.to_string(),
        "".to_string(),
        U64(1),
        "module".to_string(),
        U128(reserve),
        Some(AuctionMechanism::FirstPrice),
        U64(1_000),
        U64(1_000),
        U64(5_000),
        U64(1_000),
        None,
        Some(8),
        Some(acct("arbiter.testnet")),
    );

    let bid = NearToken::from_near(1).as_yoctonear();
    let hash = ct.compute_commit_hash(
        U64(0),
        acct("w1.testnet"),
        U128(bid),
        U64(60),
        "liveness_salt".to_string(),
    );
    testing_env!(ctx("w1.testnet", 1_100, 0).build());
    ct.commit_bid(U64(0), hash);
    testing_env!(ctx("w1.testnet", 2_200, 0).build());
    ct.reveal_bid(U64(0), U128(bid), U64(60), "liveness_salt".to_string());
    testing_env!(ctx("keeper.testnet", 3_100, 0).build());
    ct.finalize_auction(U64(0));

    testing_env!(ctx("w1.testnet", 4_000, 0).build());
    ct.submit_delivery(U64(0), "ipfs://module".to_string(), DELIV_HASH.to_string());
    testing_env!(ctx("buyer.testnet", 4_100, 0).build());
    ct.dispute_delivery(U64(0), REASON_HASH.to_string());

    // Before the arbiter resolution window elapses, timeout settlement must fail.
    testing_env!(ctx("keeper.testnet", 5_000, 0).build());
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ct.finalize_after_timeout(U64(0));
    }));
    assert!(early.is_err());

    // After dispute_window_ns from the dispute, anyone may settle at the original clearing price.
    testing_env!(ctx("keeper.testnet", 5_100, 0).build());
    let phase = ct.get_job(U64(0)).unwrap().phase;
    assert_eq!(phase, "DisputeResolutionExpired");
    let _ = ct.finalize_after_timeout(U64(0));
    testing_env!(ctx("tender.testnet", 5_101, 0).build());
    let ok = ct.on_settlement_complete(
        U64(0),
        "dispute_timeout_auto_settled".to_string(),
        JobStatus::Disputed,
        None,
        Ok(()),
    );
    assert!(ok);
    let settled = ct.get_job(U64(0)).unwrap();
    assert_eq!(settled.status, JobStatus::Settled);
    assert_eq!(settled.clearing_price, Some(U128(bid)));
}
