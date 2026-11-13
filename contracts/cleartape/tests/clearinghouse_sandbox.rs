use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use std::sync::Arc;

const SPEC_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const DELIV_HASH: &str = "2222222222222222222222222222222222222222222222222222222222222222";

#[derive(Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
struct JobViewDto {
    job_id: String,
    status: String,
    phase: String,
    commit_count: u32,
    reveal_count: u32,
    winner: Option<AccountId>,
    winning_bid: Option<String>,
    runner_up_bid: Option<String>,
    clearing_price: Option<String>,
    unit_price: Option<String>,
}

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
    near_amount: u128,
) -> testresult::TestResult<Account> {
    let sdk_account_id: near_sdk::AccountId = name.parse()?;
    let api_account_id: AccountId = name.parse()?;
    sandbox
        .create_account(sdk_account_id)
        .initial_balance(NearToken::from_near(near_amount))
        .send()
        .await?;
    Ok(Account(api_account_id))
}

async fn fetch_job(
    contract: &Contract,
    net: &NetworkConfig,
    job_id: u64,
) -> testresult::TestResult<JobViewDto> {
    let data: Option<JobViewDto> = contract
        .call_function("get_job", json!({ "job_id": job_id.to_string() }))
        ?.read_only()
        .fetch_from(net)
        .await?
        .data;
    Ok(data.expect("job should exist"))
}

async fn advance_until_phase(
    sandbox: &near_sandbox::Sandbox,
    contract: &Contract,
    net: &NetworkConfig,
    job_id: u64,
    expected_phase: &str,
) -> testresult::TestResult<JobViewDto> {
    for _ in 0..80 {
        let j = fetch_job(contract, net, job_id).await?;
        if j.phase == expected_phase {
            return Ok(j);
        }
        sandbox.fast_forward(3).await?;
    }
    let final_j = fetch_job(contract, net, job_id).await?;
    panic!(
        "Timed out waiting for job {} to reach phase '{}'; current phase='{}', status='{}'",
        job_id, expected_phase, final_j.phase, final_j.status
    );
}

async fn compute_hash_view(
    contract: &Contract,
    net: &NetworkConfig,
    job_id: u64,
    worker: &AccountId,
    bid_yocto: u128,
    eta_seconds: u64,
    salt: &str,
) -> testresult::TestResult<String> {
    let h: String = contract
        .call_function(
            "compute_commit_hash",
            json!({
                "job_id": job_id.to_string(),
                "worker_id": worker,
                "bid_yocto": bid_yocto.to_string(),
                "eta_seconds": eta_seconds.to_string(),
                "salt": salt,
            }),
        )
        ?.read_only()
        .fetch_from(net)
        .await?
        .data;
    Ok(h)
}

#[tokio::test]
async fn sandbox_vickrey_function_call_key_and_adversarial_edge_cases() -> testresult::TestResult<()>
{
    // Always build from the current source unless a prebuilt artifact is explicitly supplied,
    // so sandbox tests can never silently execute a stale `.wasm` after contract changes.
    let contract_wasm = match std::env::var("CLEARTAPE_WASM") {
        Ok(path) => std::fs::read(path)?,
        Err(_) => {
            let built = cargo_near_build::build_with_cli(Default::default())?;
            std::fs::read(built)?
        }
    };

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis_signer: Arc<Signer> = Signer::new(Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    ))?;

    let contract_acct = create_subaccount(&sandbox, "cleartape.sandbox", 20).await?;
    let contract = contract_acct.as_contract();
    let buyer = create_subaccount(&sandbox, "buyer.sandbox", 25).await?;
    let worker1 = create_subaccount(&sandbox, "worker1.sandbox", 5).await?;
    let worker2 = create_subaccount(&sandbox, "worker2.sandbox", 5).await?;
    let worker3 = create_subaccount(&sandbox, "worker3.sandbox", 5).await?;
    let eve = create_subaccount(&sandbox, "eve.sandbox", 5).await?;

    // Deploy and initialize ClearTape
    Contract::deploy(contract.account_id().clone())
        .use_code(contract_wasm)
        .with_init_call("new", json!({ "owner_id": buyer.account_id() }))?
        .with_signer(genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Provision a restricted FunctionCall Access Key on worker1.sandbox (cannot attach >0 NEAR!)
    let fc_secret = near_api::signer::generate_secret_key()?;
    let fc_pub = fc_secret.public_key();
    worker1
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_millinear(250)),
                receiver_id: contract.account_id().to_string(),
                method_names: vec![
                    "commit_bid".to_string(),
                    "reveal_bid".to_string(),
                    "submit_delivery".to_string(),
                    "finalize_after_timeout".to_string(),
                ],
            }),
            fc_pub,
        )
        .with_signer(genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let worker1_fc_signer: Arc<Signer> = Signer::new(Signer::from_secret_key(fc_secret))?;

    let storage_req_str: String = contract
        .call_function("required_job_storage_deposit", json!({ "max_commits": 16 }))
        ?.read_only()
        .fetch_from(&net)
        .await?
        .data;
    let storage_req: u128 = storage_req_str.parse()?;
    let reserve_yocto = NearToken::from_near(3).as_yoctonear();

    // 1. Insufficient deposit on create_job MUST fail
    contract
        .call_function(
            "create_job",
            json!({
                "title": "Underfunded Job",
                "category": "smart-contract-audit",
                "spec_sha256": SPEC_HASH,
                "spec_uri": "ipfs://spec0",
                "work_units": "3",
                "unit_label": "kloc",
                "reserve_price": reserve_yocto.to_string(),
                "mechanism": "VickreySecondPrice",
                "commit_duration_ns": "8000000000",
                "reveal_duration_ns": "12000000000",
                "delivery_duration_ns": "40000000000",
                "dispute_window_ns": "8000000000",
                "max_commits": 16
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .deposit(NearToken::from_yoctonear(reserve_yocto)) // missing storage_req!
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // 2. Happy-path Vickrey Second-Price Job #0
    let create_res = contract
        .call_function(
            "create_job",
            json!({
                "title": "Audit NEP-141 Vault",
                "category": "smart-contract-audit",
                "spec_sha256": SPEC_HASH,
                "spec_uri": "ipfs://spec-vault",
                "work_units": "3",
                "unit_label": "kloc",
                "reserve_price": reserve_yocto.to_string(),
                "mechanism": "VickreySecondPrice",
                "commit_duration_ns": "9000000000",
                "reveal_duration_ns": "14000000000",
                "delivery_duration_ns": "40000000000",
                "dispute_window_ns": "9000000000",
                "max_commits": 16
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .deposit(NearToken::from_yoctonear(reserve_yocto + storage_req))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?;
    assert!(
        create_res
            .logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"job_created\""))
    );
    create_res.assert_success();

    let buyer_after_escrow = buyer.tokens().near_balance().fetch_from(&net).await?.total;

    let b1 = NearToken::from_millinear(1_200).as_yoctonear(); // 1.2 NEAR
    let b2 = NearToken::from_millinear(1_800).as_yoctonear(); // 1.8 NEAR
    let b3 = NearToken::from_millinear(2_400).as_yoctonear(); // 2.4 NEAR

    let h1 = compute_hash_view(&contract, &net, 0, worker1.account_id(), b1, 120, "salt_w1_secret").await?;
    let h2 = compute_hash_view(&contract, &net, 0, worker2.account_id(), b2, 180, "salt_w2_secret").await?;
    let h3 = compute_hash_view(&contract, &net, 0, worker3.account_id(), b3, 240, "salt_w3_secret").await?;

    // worker1 commits using restricted FunctionCall Access Key (0 attached NEAR!)
    contract
        .call_function("commit_bid", json!({ "job_id": "0", "commit_hash": h1 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Eve copies worker1's exact commit_hash onto Job #0!
    contract
        .call_function("commit_bid", json!({ "job_id": "0", "commit_hash": h1 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(eve.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function("commit_bid", json!({ "job_id": "0", "commit_hash": h2 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function("commit_bid", json!({ "job_id": "0", "commit_hash": h3 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker3.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Wrong-phase check: early reveal during CommitOpen MUST fail
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "0",
                "bid_yocto": b1.to_string(),
                "eta_seconds": "120",
                "salt": "salt_w1_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Advance into RevealOpen window
    advance_until_phase(&sandbox, &contract, &net, 0, "RevealOpen").await?;

    // Wrong-phase check: late commit during RevealOpen MUST fail
    contract
        .call_function("commit_bid", json!({ "job_id": "0", "commit_hash": h1 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // worker1 reveals with FunctionCall key (0 deposit)
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "0",
                "bid_yocto": b1.to_string(),
                "eta_seconds": "120",
                "salt": "salt_w1_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Adversarial check: Eve replays worker1's now-public (bid, eta, salt) -> MUST FAIL!
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "0",
                "bid_yocto": b1.to_string(),
                "eta_seconds": "120",
                "salt": "salt_w1_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(eve.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // worker2 & worker3 reveal
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "0",
                "bid_yocto": b2.to_string(),
                "eta_seconds": "180",
                "salt": "salt_w2_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "0",
                "bid_yocto": b3.to_string(),
                "eta_seconds": "240",
                "salt": "salt_w3_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker3.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Because Eve did not reveal, wait until AwaitingClear
    advance_until_phase(&sandbox, &contract, &net, 0, "AwaitingClear").await?;

    contract
        .call_function("finalize_auction", json!({ "job_id": "0" }))
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .with_signer(eve.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let cleared = fetch_job(&contract, &net, 0).await?;
    assert_eq!(cleared.job_id, "0");
    assert_eq!(cleared.commit_count, 4);
    assert_eq!(cleared.reveal_count, 3);
    assert_eq!(cleared.status, "Assigned");
    assert_eq!(cleared.winner.as_ref(), Some(worker1.account_id()));
    assert_eq!(cleared.winning_bid.as_deref(), Some(b1.to_string().as_str()));
    assert_eq!(cleared.runner_up_bid.as_deref(), Some(b2.to_string().as_str()));
    // Vickrey second-price: clearing_price == 1.8 NEAR (runner-up bid), unit_price == 0.6 NEAR
    assert_eq!(cleared.clearing_price.as_deref(), Some(b2.to_string().as_str()));
    assert_eq!(
        cleared.unit_price.as_deref(),
        Some((b2 / 3).to_string().as_str())
    );

    let worker1_before_payout = worker1.tokens().near_balance().fetch_from(&net).await?.total;

    // worker1 submits delivery via FunctionCall Access Key (0 deposit)
    contract
        .call_function(
            "submit_delivery",
            json!({
                "job_id": "0",
                "deliverable_uri": "ipfs://audit-report-v1",
                "deliverable_sha256": DELIV_HASH
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Adversarial check: external caller invoking #[private] callback directly MUST fail
    contract
        .call_function(
            "on_settlement_complete",
            json!({
                "job_id": "0",
                "trigger": "forged",
                "prev_status": "Delivered"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(eve.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Buyer accepts delivery -> worker1 receives 1.8 NEAR, buyer receives 1.2 NEAR Vickrey surplus!
    let settle_res = contract
        .call_function("accept_delivery", json!({ "job_id": "0" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?;
    assert!(
        settle_res
            .logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"job_settled\""))
    );
    settle_res.assert_success();

    let settled = fetch_job(&contract, &net, 0).await?;
    assert_eq!(settled.status, "Settled");

    let worker1_after_payout = worker1.tokens().near_balance().fetch_from(&net).await?.total;
    let buyer_after_surplus = buyer.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(
        worker1_after_payout.as_yoctonear()
            >= worker1_before_payout.as_yoctonear() + NearToken::from_millinear(1_795).as_yoctonear(),
        "worker1 should receive ~1.8 NEAR Vickrey clearing price"
    );
    assert!(
        buyer_after_surplus.as_yoctonear()
            >= buyer_after_escrow.as_yoctonear() + NearToken::from_millinear(1_190).as_yoctonear(),
        "buyer should automatically receive ~1.2 NEAR Vickrey surplus refund"
    );

    // Double-settlement check: second accept_delivery or finalize_after_timeout MUST fail
    contract
        .call_function("accept_delivery", json!({ "job_id": "0" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // =========================================================================
    // 3. Job #1: Cross-Job Replay, Reserve-Exceeding Reveal, Zero-Reveal Refund
    // =========================================================================
    let reserve_j1 = NearToken::from_near(2).as_yoctonear();
    let buyer_before_j1 = buyer.tokens().near_balance().fetch_from(&net).await?.total;

    contract
        .call_function(
            "create_job",
            json!({
                "title": "Zero Valid Reveals Job",
                "category": "code-generation",
                "spec_sha256": SPEC_HASH,
                "spec_uri": "ipfs://spec1",
                "work_units": "1",
                "unit_label": "repo",
                "reserve_price": reserve_j1.to_string(),
                "mechanism": "FirstPrice",
                "commit_duration_ns": "8000000000",
                "reveal_duration_ns": "10000000000",
                "delivery_duration_ns": "30000000000",
                "dispute_window_ns": "8000000000",
                "max_commits": 8
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .deposit(NearToken::from_yoctonear(reserve_j1 + storage_req))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // worker1 replays h1 (created for Job #0) onto Job #1
    contract
        .call_function("commit_bid", json!({ "job_id": "1", "commit_hash": h1 }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // worker2 commits an over-reserve bid (5 NEAR > 2 NEAR reserve)
    let over_bid = NearToken::from_near(5).as_yoctonear();
    let h_over = compute_hash_view(&contract, &net, 1, worker2.account_id(), over_bid, 100, "salt_over_999").await?;
    contract
        .call_function("commit_bid", json!({ "job_id": "1", "commit_hash": h_over }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    advance_until_phase(&sandbox, &contract, &net, 1, "RevealOpen").await?;

    // Cross-job replay reveal MUST fail
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "1",
                "bid_yocto": b1.to_string(),
                "eta_seconds": "120",
                "salt": "salt_w1_secret"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Reserve-exceeding reveal MUST fail
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "1",
                "bid_yocto": over_bid.to_string(),
                "eta_seconds": "100",
                "salt": "salt_over_999"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Zero valid reveals -> finalize_auction refunds full 2 NEAR escrow to buyer!
    advance_until_phase(&sandbox, &contract, &net, 1, "AwaitingClear").await?;
    let refund_res = contract
        .call_function("finalize_auction", json!({ "job_id": "1" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(eve.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?;
    assert!(
        refund_res
            .logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"job_refunded\""))
    );
    refund_res.assert_success();

    let j1_done = fetch_job(&contract, &net, 1).await?;
    assert_eq!(j1_done.status, "CancelledZeroReveals");
    let buyer_after_j1_refund = buyer.tokens().near_balance().fetch_from(&net).await?.total;
    // Buyer paid (2 NEAR + storage_req + gas) and received 2 NEAR refund back
    assert!(
        buyer_after_j1_refund.as_yoctonear() + storage_req + NearToken::from_millinear(20).as_yoctonear()
            >= buyer_before_j1.as_yoctonear(),
        "buyer should receive full 2 NEAR reserve refund when 0 valid bids are revealed"
    );

    // =========================================================================
    // 4. Job #2: Exact Tie-Breaking, Failed-Payout Callback Rollback & Silent-Buyer Timeout
    // =========================================================================
    let reserve_j2 = NearToken::from_near(2).as_yoctonear();
    contract
        .call_function(
            "create_job",
            json!({
                "title": "Tie + Rollback + Timeout Job",
                "category": "data-labeling",
                "spec_sha256": SPEC_HASH,
                "spec_uri": "ipfs://spec2",
                "work_units": "500",
                "unit_label": "rows",
                "reserve_price": reserve_j2.to_string(),
                "mechanism": "FirstPrice",
                "commit_duration_ns": "8000000000",
                "reveal_duration_ns": "10000000000",
                "delivery_duration_ns": "40000000000",
                "dispute_window_ns": "8000000000",
                "max_commits": 8
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .deposit(NearToken::from_yoctonear(reserve_j2 + storage_req))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let tie_bid = NearToken::from_millinear(1_500).as_yoctonear();
    let h_early = compute_hash_view(&contract, &net, 2, worker2.account_id(), tie_bid, 90, "salt_early_tie").await?;
    let h_late = compute_hash_view(&contract, &net, 2, worker1.account_id(), tie_bid, 30, "salt_late_tie").await?;

    // worker2 commits FIRST, worker1 commits SECOND
    contract
        .call_function("commit_bid", json!({ "job_id": "2", "commit_hash": h_early }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("commit_bid", json!({ "job_id": "2", "commit_hash": h_late }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    advance_until_phase(&sandbox, &contract, &net, 2, "RevealOpen").await?;

    // worker1 reveals FIRST, worker2 reveals SECOND -> worker2 still wins tie due to lower commit_seq!
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "2",
                "bid_yocto": tie_bid.to_string(),
                "eta_seconds": "30",
                "salt": "salt_late_tie"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "2",
                "bid_yocto": tie_bid.to_string(),
                "eta_seconds": "90",
                "salt": "salt_early_tie"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // All 2 committed workers revealed -> finalize_auction works immediately!
    contract
        .call_function("finalize_auction", json!({ "job_id": "2" }))
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let j2_cleared = fetch_job(&contract, &net, 2).await?;
    assert_eq!(j2_cleared.winner.as_ref(), Some(worker2.account_id()));

    // worker2 submits delivery
    contract
        .call_function(
            "submit_delivery",
            json!({
                "job_id": "2",
                "deliverable_uri": "ipfs://labeled-500",
                "deliverable_sha256": DELIV_HASH
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Early finalize_after_timeout BEFORE dispute_window_ns elapses MUST fail
    contract
        .call_function("finalize_after_timeout", json!({ "job_id": "2" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Point payout_account to a non-existent/deleted account to force real async transfer failure in near-sandbox!
    contract
        .call_function(
            "set_payout_account",
            json!({
                "job_id": "2",
                "payout_account": "nonexistent-deleted-receiver.sandbox"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Advance past dispute window (silent buyer never responds)
    advance_until_phase(&sandbox, &contract, &net, 2, "ReadyAutoSettle").await?;

    let failed_payout_tx = contract
        .call_function("finalize_after_timeout", json!({ "job_id": "2" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?;
    assert!(
        !failed_payout_tx.receipt_failures().is_empty(),
        "Transfer sub-receipt to deleted account should fail on-chain"
    );
    assert!(
        failed_payout_tx
            .logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"payout_failed\"")),
        "on_settlement_complete callback must emit payout_failed event"
    );

    // Verify state rolled back cleanly to Delivered (NOT Settled, NOT stuck in Settling!)
    let j2_rolled_back = fetch_job(&contract, &net, 2).await?;
    assert_eq!(j2_rolled_back.status, "Delivered");
    assert_eq!(j2_rolled_back.phase, "ReadyAutoSettle");

    // worker2 fixes payout_account back to worker2.sandbox and settles via finalize_after_timeout!
    let w2_before = worker2.tokens().near_balance().fetch_from(&net).await?.total;
    contract
        .call_function(
            "set_payout_account",
            json!({
                "job_id": "2",
                "payout_account": worker2.account_id()
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(worker2.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let retry_tx = contract
        .call_function("finalize_after_timeout", json!({ "job_id": "2" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone()) // even 0-deposit FunctionCall key can trigger timeout settlement!
        .send_to(&net)
        .await?;
    retry_tx.assert_success();

    let j2_settled = fetch_job(&contract, &net, 2).await?;
    assert_eq!(j2_settled.status, "Settled");
    let w2_after = worker2.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(
        w2_after.as_yoctonear()
            >= w2_before.as_yoctonear() + NearToken::from_millinear(1_490).as_yoctonear(),
        "worker2 should receive 1.5 NEAR after payout recovery"
    );

    // =========================================================================
    // 5. Job #3: NEP-141 FT Escrow & Failed FT Payout Callback Rollback
    // =========================================================================
    let fake_ft = create_subaccount(&sandbox, "usdc-mock.sandbox", 5).await?;
    contract
        .call_function(
            "register_ft_job_storage",
            json!({ "buyer_id": buyer.account_id() }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(40))
        .deposit(NearToken::from_yoctonear(storage_req + NearToken::from_millinear(50).as_yoctonear()))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let ft_msg = json!({
        "title": "FT Escrowed Summarization",
        "category": "research-synthesis",
        "spec_sha256": SPEC_HASH,
        "spec_uri": "ipfs://ft-spec",
        "work_units": "10",
        "unit_label": "docs",
        "mechanism": "FirstPrice",
        "commit_duration_ns": "8000000000",
        "reveal_duration_ns": "10000000000",
        "delivery_duration_ns": "30000000000",
        "dispute_window_ns": "8000000000",
        "max_commits": 8
    })
    .to_string();

    contract
        .call_function(
            "ft_on_transfer",
            json!({
                "sender_id": buyer.account_id(),
                "amount": "5000000",
                "msg": ft_msg
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .with_signer(fake_ft.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let h_ft = compute_hash_view(&contract, &net, 3, worker1.account_id(), 4_000_000, 60, "salt_ft_job_3").await?;
    contract
        .call_function("commit_bid", json!({ "job_id": "3", "commit_hash": h_ft }))
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    advance_until_phase(&sandbox, &contract, &net, 3, "RevealOpen").await?;
    contract
        .call_function(
            "reveal_bid",
            json!({
                "job_id": "3",
                "bid_yocto": "4000000",
                "eta_seconds": "60",
                "salt": "salt_ft_job_3"
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function("finalize_auction", json!({ "job_id": "3" }))
        ?.transaction()
        .gas(NearGas::from_tgas(80))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function(
            "submit_delivery",
            json!({
                "job_id": "3",
                "deliverable_uri": "ipfs://ft-deliv",
                "deliverable_sha256": DELIV_HASH
            }),
        )
        ?.transaction()
        .gas(NearGas::from_tgas(50))
        .with_signer(worker1.account_id().clone(), worker1_fc_signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Buyer calls accept_delivery -> ft_transfer to fake_ft (no contract deployed) fails -> callback rolls back to Delivered!
    let ft_fail_tx = contract
        .call_function("accept_delivery", json!({ "job_id": "3" }))
        ?.transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(buyer.account_id().clone(), genesis_signer.clone())
        .send_to(&net)
        .await?;
    assert!(
        ft_fail_tx
            .logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"payout_failed\""))
    );
    let j3_after_fail = fetch_job(&contract, &net, 3).await?;
    assert_eq!(j3_after_fail.status, "Delivered");

    Ok(())
}
