#!/usr/bin/env node
/**
 * Tender testnet demo.
 *
 * Drives three real auctions on NEAR testnet against the deployed
 * `tender-hack-1114g.testnet` contract:
 *
 *   Job 0 — Vickrey second-price audit auction (3 bids, buyer accepts)
 *   Job 1 — First-price data-labeling auction (2 bids, worker timeout-settles
 *           through a restricted FunctionCall access key)
 *   Job 2 — Zero-reveal auction (full buyer refund)
 *
 * Worker keys are persisted in `.data/testnet-keys.json` (gitignored).
 * Demo results are written to `.data/testnet-demo.json`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nearApi from "near-api-js";

const { KeyPair, transactions } = nearApi;
const publicKeyFromPrivate = (privateKey) => KeyPair.fromString(privateKey).getPublicKey();

const NETWORK = "testnet";
const NODE_URL = process.env.NEAR_RPC_URL || "https://near-testnet.drpc.org";
const CONTRACT = process.env.TENDER_CONTRACT || "tender-hack-1114g.testnet";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, ".data");
const KEYS_PATH = join(DATA_DIR, "testnet-keys.json");
const RESULT_PATH = join(DATA_DIR, "testnet-demo.json");

const NEAR = 10n ** 24n;
const TGAS = 1_000_000_000_000n;

const BUYER = `buyer.${CONTRACT}`;
const WORKERS = ["worker-a", "worker-b", "worker-c"].map((name) => `${name}.${CONTRACT}`);

const rpcHeaders = { "content-type": "application/json" };
const STATUS_URLS = [
  process.env.NEAR_RPC_URL || "https://near-testnet.drpc.org",
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
];
const RPC_URLS = [...new Set(STATUS_URLS)];
let rpcId = 0;
async function rpc(method, params, options = {}) {
  const url = options.url ?? NODE_URL;
  const attempts = options.attempts ?? 4;
  rpcId += 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
        signal: controller.signal,
      });
      // Keep the abort timer alive through the body read: a gateway can send
      // headers and then stall the response body indefinitely.
      const body = await response.json();
      if (body.error) {
        const detail = body.error.data ?? body.error.cause?.name ?? body.error.message;
        throw new Error(`${method}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      }
      if (body.result && typeof body.result === "object" && body.result.error) {
        throw new Error(`${method}: ${String(body.result.error)}`);
      }
      return body.result;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await sleep(750 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function trace(label) {
  if (process.env.TENDER_DEMO_TRACE === "1") {
    console.log(`[trace] ${label} ${new Date().toISOString()}`);
  }
}

/** Query any healthy gateway, so a single 429 never stalls the demo. */
async function rpcAny(method, params, attemptsPerUrl = 2) {
  let lastError = null;
  for (const url of RPC_URLS) {
    try {
      return await rpc(method, params, { url, attempts: attemptsPerUrl });
    } catch (error) {
      trace(`rpcAny ${method} ${url} failed: ${String(error?.message ?? error).slice(0, 80)}`);
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${method} failed on every RPC endpoint`);
}

function nearToYocto(value) {
  const [whole, fraction = ""] = String(value).split(".");
  const padded = (fraction + "0".repeat(24)).slice(0, 24);
  return BigInt(whole) * NEAR + BigInt(padded);
}

function yoctoToNear(value) {
  const raw = BigInt(value);
  return `${raw / NEAR}.${(raw % NEAR).toString().padStart(24, "0").replace(/0+$/, "") || "0"}`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function commitPreimage({ jobId, worker, bid, etaSeconds, salt }) {
  // Must match `build_commit_preimage` in contracts/tender/src/lib.rs.
  return `tender:v1:${CONTRACT}:${jobId}:${worker}:${bid}:${etaSeconds}:${salt}`;
}

function loadMasterCredential() {
  const path = join(homedir(), ".near-credentials", NETWORK, `${CONTRACT}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing master credential at ${path}. Create/deploy the contract first, or set TENDER_CONTRACT.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function accountExists(accountId) {
  try {
    await rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return true;
  } catch (error) {
    if (String(error).includes("does not exist") || String(error).includes("UNKNOWN_ACCOUNT")) return false;
    throw error;
  }
}

function connectWithKey(accountId, privateKey) {
  const keyPair = KeyPair.fromString(privateKey);
  return {
    accountId,
    keyPair,
    publicKey: keyPair.getPublicKey().toString(),
    async getAccessKeys() {
      const result = await rpcAny("query", {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: accountId,
      });
      return result.keys;
    },
    async getAccountBalance() {
      const account = await rpcAny("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
      const stored = BigInt(account.amount) + BigInt(account.locked ?? 0);
      return {
        total: stored.toString(),
        available: (BigInt(account.amount) - storageCostEstimate(account.storage_usage)).toString(),
      };
    },
  };
}

function storageCostEstimate(storageUsage) {
  // 1e19 yoctoNEAR per byte is the mainnet rate; testnet uses the same
  // storage price for our purposes. Only used for a human-readable log line.
  return BigInt(storageUsage) * 10_000_000_000_000_000_000n;
}

function generateKeyRecord(accountId) {
  const keyPair = KeyPair.fromRandom("ed25519");
  return {
    account_id: accountId,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
}

function loadOrCreateKeyRecords() {
  if (existsSync(KEYS_PATH)) {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8"));
  }
  return {
    buyer: generateKeyRecord(BUYER),
    workers: Object.fromEntries(WORKERS.map((worker) => [worker, generateKeyRecord(worker)])),
    restricted: Object.fromEntries(
      WORKERS.map((worker) => [worker, generateKeyRecord(`${worker}-fc`)]),
    ),
  };
}

/**
 * Sign locally, broadcast through our retrying RPC helper, and recover by
 * transaction hash if the broadcast response itself fails. Public RPC gateways
 * occasionally return 500s after accepting a transaction; near-api-js's
 * `functionCall` would surface that as a fatal error even though the receipt
 * executed. Signing first gives us the hash needed to poll `tx`.
 */
async function sendActions(account, receiverId, actions, label) {
  const SEND_URLS = [...new Set([
    NODE_URL,
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.near.org",
  ])];
  let lastError = null;

  const signer = {
    async getPublicKey() {
      return account.keyPair.getPublicKey();
    },
    async signMessage(message) {
      const digest = new Uint8Array(createHash("sha256").update(Buffer.from(message)).digest());
      return account.keyPair.sign(digest);
    },
  };

  for (let round = 0; round < 6; round += 1) {
    let txHash = null;
    let encoded = null;
    try {
      const accessKey = await rpcAny("query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: account.accountId,
        public_key: account.publicKey,
      });
      const block = await rpcAny("block", { finality: "final" });
      const blockHash = nearApi.utils.serialize.base_decode(block.header.hash);
      const nonce = BigInt(accessKey.nonce) + 1n;
      const [txHashBytes, signedTx] = await transactions.signTransaction(
        receiverId,
        nonce,
        actions,
        blockHash,
        signer,
        account.accountId,
        NETWORK,
      );
      txHash = nearApi.utils.serialize.base_encode(txHashBytes);
      encoded = Buffer.from(signedTx.encode()).toString("base64");
    } catch (error) {
      lastError = error;
      await sleep(1_500 * (round + 1));
      continue;
    }

    // Try every RPC gateway: one of them accepted the original transaction.
    for (const url of SEND_URLS) {
      try {
        const outcome = await rpc(
          "send_tx",
          { signed_tx_base64: encoded, wait_until: "EXECUTED_OPTIMISTIC" },
          { url, attempts: 1 },
        );
        const status = outcome.status;
        const success =
          status !== null &&
          typeof status === "object" &&
          ("SuccessValue" in status || "SuccessReceiptIds" in status);
        if (!success) {
          throw new Error(`${label} failed: ${JSON.stringify(status)}`);
        }
        console.log(
          `[tx] ${label} hash=${txHash} gas=${outcome.transaction_outcome?.outcome?.gas_burnt ?? "?"}`,
        );
        return { hash: txHash, outcome };
      } catch (error) {
        lastError = error;
      }
    }

    // Deterministic rejections cannot succeed on another retry; surface them
    // immediately instead of burning the recovery poll.
    const deterministic = new Set([
      "NotEnoughBalance",
      "AccessKeyNotFound",
      "InvalidSignature",
      "SignerDoesNotExist",
      "InvalidNonce",
      "Expired",
    ]);
    const message = String(lastError?.message ?? lastError);
    if ([...deterministic].some((name) => message.includes(name))) {
      throw lastError;
    }

    // Broadcast errored, but the transaction may still be included. Poll by
    // hash for up to ~30s so we never double-submit a state-changing action.
    for (let probe = 0; probe < 15; probe += 1) {
      await sleep(2_000);
      for (const url of STATUS_URLS) {
        try {
          const status = await rpc(
            "tx",
            { tx_hash: txHash, sender_account_id: account.accountId, wait_until: "EXECUTED_OPTIMISTIC" },
            { url, attempts: 1 },
          );
          const state = status.status;
          const success =
            state !== null &&
            typeof state === "object" &&
            ("SuccessValue" in state || "SuccessReceiptIds" in state);
          if (!success) throw new Error(`${label} failed: ${JSON.stringify(state)}`);
          console.log(
            `[tx] ${label} hash=${txHash} gas=${status.transaction_outcome?.outcome?.gas_burnt ?? "?"} (recovered)`,
          );
          return { hash: txHash, outcome: status };
        } catch (pollError) {
          lastError = pollError;
        }
      }
    }

    console.warn(`[tx-retry] ${label}: ${String(lastError?.message ?? lastError).slice(0, 120)}`);
    await sleep(1_200 * (round + 1));
  }
  throw lastError ?? new Error(`${label} broadcast failed`);
}

async function ensureAccount(master, accountId, record, fundingNear) {
  if (await accountExists(accountId)) {
    console.log(`[account] ${accountId} already exists`);
    return;
  }
  const amount = nearToYocto(fundingNear);
  console.log(`[account] creating ${accountId} with ${fundingNear} NEAR`);
  const { hash } = await sendActions(
    master,
    accountId,
    [
      transactions.createAccount(),
      transactions.transfer(amount),
      transactions.addKey(publicKeyFromPrivate(record.private_key), transactions.fullAccessKey()),
    ],
    `create_account:${accountId}`,
  );
  console.log(`[account] created ${accountId} tx=${hash}`);
}

async function call(account, methodName, args, options = {}) {
  const gas = options.gas ?? 100n * TGAS;
  const deposit = options.deposit ?? 0n;
  const action = transactions.functionCall(
    methodName,
    Buffer.from(JSON.stringify(args)),
    gas,
    deposit,
  );
  const { hash, outcome } = await sendActions(
    account,
    CONTRACT,
    [action],
    `${methodName} ${JSON.stringify(args).slice(0, 110)}`,
  );
  return { hash, outcome };
}

async function view(_account, methodName, args = {}) {
  // Query calls are read-only; cache-bust to avoid stale gateway caches.
  const result = await rpcAny("query", {
    request_type: "call_function",
    account_id: CONTRACT,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "optimistic",
  });
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

async function getJob(buyer, jobId) {
  const job = await view(buyer, "get_job", { job_id: String(jobId) });
  if (!job) throw new Error(`job ${jobId} not found`);
  return job;
}

async function waitForPhase(buyer, jobId, phases, timeoutMs, label) {
  const wanted = new Set(phases);
  const deadline = Date.now() + timeoutMs;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const job = await getJob(buyer, jobId);
    lastPhase = job.phase;
    if (wanted.has(job.phase)) return job;
    await sleep(1_500);
  }
  throw new Error(`timed out waiting for ${label}; last phase=${lastPhase}`);
}

async function waitForStatus(buyer, jobId, statuses, timeoutMs, label) {
  const wanted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const job = await getJob(buyer, jobId);
    lastStatus = job.status;
    if (wanted.has(job.status)) return job;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}; last status=${lastStatus}`);
}

async function blockHeightOf(txHash, signer) {
  const tx = await rpc("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signer,
    wait_until: "FINAL",
  }).catch(() => null);
  const blockHash = tx?.transaction_outcome?.block_hash;
  if (!blockHash) return null;
  const block = await rpc("block", { block_id: blockHash });
  return block?.header?.height ?? null;
}

const SPEC = {
  audit: sha256Hex("Tender demo spec — Rust contract audit, 3 kloc"),
  labeling: sha256Hex("Tender demo spec — 2k rows of labeled inference traces"),
  codegen: sha256Hex("Tender demo spec — SDK adapter scaffold"),
};
const DELIVERABLE = {
  audit: sha256Hex("Tender demo deliverable — audit report + findings"),
  labeling: sha256Hex("Tender demo deliverable — labeled dataset tarball"),
};

const JOB_BIDS = {
  audit: { [WORKERS[0]]: "0.90", [WORKERS[1]]: "1.10", [WORKERS[2]]: "1.30" },
  labeling: { [WORKERS[1]]: "0.55", [WORKERS[2]]: "0.75" },
  codegen: {},
};


/**
 * A prior run can leave jobs open with escrowed reserves. Once their reveal
 * deadline has passed, permissionlessly finalize them so the buyer is refunded
 * before a rerun. Bounded by the job count and safe to call on a clean account.
 */
async function finalizeStaleOpenJobs(buyer) {
  const countRaw = await view(buyer, "get_job_count");
  const count = Number(String(countRaw));
  if (!Number.isInteger(count) || count <= 0) return;
  const terminal = new Set([
    "Settled",
    "CancelledZeroReveals",
    "Refunded",
    "ExpiredNoDelivery",
    "Refunding",
    "Settling",
  ]);
  for (let id = 0; id < count; id += 1) {
    let job = null;
    try {
      job = await view(buyer, "get_job", { job_id: String(id) });
    } catch {
      continue;
    }
    if (!job || job.status !== "Open" || terminal.has(job.status)) continue;
    try {
      const { hash } = await call(buyer, "finalize_auction", { job_id: String(id) }, {
        gas: 150n * TGAS,
      });
      console.log(`[cleanup] finalized stale job ${id} hash=${hash}`);
    } catch (error) {
      console.warn(
        `[cleanup] job ${id} not finalizable yet: ${String(error?.message ?? error).slice(0, 120)}`,
      );
    }
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const masterCred = loadMasterCredential();
  const master = await connectWithKey(CONTRACT, masterCred.private_key ?? masterCred.secret_key);
  const balance = await master.getAccountBalance();
  const availableNear = Number(BigInt(balance.available) / NEAR);
  console.log(`[master] ${CONTRACT} available=${availableNear} NEAR`);

  const keys = loadOrCreateKeyRecords();
  writeFileSync(KEYS_PATH, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  console.log(`[keys] persisted ${KEYS_PATH}`);

  // buyer + workers
  await ensureAccount(master, BUYER, keys.buyer, "4.5");
  for (const worker of WORKERS) {
    await ensureAccount(master, worker, keys.workers[worker], "0.2");
  }

  const buyer = await connectWithKey(BUYER, keys.buyer.private_key);
  trace("cleanup start");
  await finalizeStaleOpenJobs(buyer);
  trace("cleanup done");
  const workers = Object.fromEntries(
    await Promise.all(
      WORKERS.map(async (worker) => [worker, await connectWithKey(worker, keys.workers[worker].private_key)]),
    ),
  );

  const txs = [];
  const record = (label, hash, signer) => {
    if (hash) txs.push({ label, hash, signer });
  };

  // A rerun can find workers low on balance after a slashed bond. Top them up
  // from the master account so the bond deposit plus prepaid gas fits.
  for (const worker of WORKERS) {
    const balance = await workers[worker].getAccountBalance();
    if (BigInt(balance.available) < nearToYocto("0.22")) {
      console.log(`[fund] topping up ${worker} with 0.15 NEAR`);
      const { hash } = await sendActions(
        master,
        worker,
        [transactions.transfer(nearToYocto("0.15"))],
        `top_up:${worker}`,
      );
      record(`${worker}:top_up`, hash, CONTRACT);
    }
  }

  trace("restricted key setup start");
  // Restricted FunctionCall keys: zero-attachment delivery + timeout settlement.
  const restrictedAccounts = {};
  for (const worker of WORKERS) {
    const recordKey = keys.restricted[worker];
    const workerAccount = workers[worker];
    const accessKeys = await workerAccount.getAccessKeys();
    const already = accessKeys.some(
      (key) => key.public_key === recordKey.public_key && key.access_key?.permission?.FunctionCall,
    );
    if (!already) {
      console.log(`[key] adding restricted FunctionCall key to ${worker}`);
      const keyOutcome = await sendActions(
        workerAccount,
        worker,
        [
          transactions.addKey(
            publicKeyFromPrivate(recordKey.private_key),
            transactions.functionCallAccessKey(
              CONTRACT,
              ["commit_bid", "reveal_bid", "submit_delivery", "finalize_after_timeout"],
              nearToYocto("0.25"),
            ),
          ),
        ],
        `add_fc_key:${worker}`,
      );
      record(`${worker}:add_fc_key`, keyOutcome.hash, worker);
    }
    // The generated key belongs to the worker account; this signer uses only
    // that restricted FunctionCall key.
    restrictedAccounts[worker] = connectWithKey(worker, recordKey.private_key);
    trace(`restricted key ready ${worker}`);
  }

  trace("bond check start");
  // Worker bond vault: pre-fund 0.08 NEAR each, locks 0.05 during job 0 bids.
  for (const worker of WORKERS) {
    const bond = await view(workers[worker], "get_worker_bond", { worker_id: worker });
    if (BigInt(bond.available_yocto) < nearToYocto("0.06")) {
      const { hash } = await call(workers[worker], "deposit_bond", {}, {
        gas: 60n * TGAS,
        deposit: nearToYocto("0.08"),
      });
      record(`${worker}:deposit_bond`, hash, worker);
    }
  }

  trace("bond check done");
  const storage = await view(buyer, "required_job_storage_deposit", { max_commits: 8 });
  trace("storage view done");
  console.log(`[storage] required per job: ${yoctoToNear(storage)} NEAR`);

  const jobIds = {};
  const createJob = async (key, args) => {
    const { hash, outcome } = await call(buyer, "create_job", args, {
      gas: 150n * TGAS,
      deposit: BigInt(args.reserve_price) + BigInt(storage),
    });
    record(`create_job:${key}`, hash, BUYER);
    const viewResult = outcome.status?.SuccessValue
      ? JSON.parse(Buffer.from(outcome.status.SuccessValue, "base64").toString("utf8"))
      : null;
    return viewResult?.job_id ?? null;
  };

  const now = Date.now();
  console.log(`[demo] start ${new Date(now).toISOString()}`);

  jobIds.audit = await createJob("audit", {
    title: "Rust smart-contract audit (3 kloc)",
    category: "smart-contract-audit",
    spec_sha256: SPEC.audit,
    spec_uri: "ipfs://bafytender-demo-audit-spec",
    work_units: "3",
    unit_label: "kloc",
    reserve_price: nearToYocto("1.5").toString(),
    mechanism: "VickreySecondPrice",
    commit_duration_ns: String(240n * 1_000_000_000n),
    reveal_duration_ns: String(90n * 1_000_000_000n),
    delivery_duration_ns: String(900n * 1_000_000_000n),
    dispute_window_ns: String(30n * 1_000_000_000n),
    min_worker_bond: nearToYocto("0.05").toString(),
    max_commits: 8,
    arbiter: `${CONTRACT}`,
  });

  jobIds.labeling = await createJob("labeling", {
    title: "Label 2k inference-trace rows",
    category: "data-labeling",
    spec_sha256: SPEC.labeling,
    spec_uri: "ipfs://bafytender-demo-labeling-spec",
    work_units: "2",
    unit_label: "1k-rows",
    reserve_price: nearToYocto("1.0").toString(),
    mechanism: "FirstPrice",
    commit_duration_ns: String(200n * 1_000_000_000n),
    reveal_duration_ns: String(90n * 1_000_000_000n),
    delivery_duration_ns: String(900n * 1_000_000_000n),
    dispute_window_ns: String(20n * 1_000_000_000n),
    min_worker_bond: "0",
    max_commits: 8,
    arbiter: null,
  });

  jobIds.codegen = await createJob("codegen", {
    title: "Generate SDK adapter scaffold",
    category: "code-generation",
    spec_sha256: SPEC.codegen,
    spec_uri: "ipfs://bafytender-demo-codegen-spec",
    work_units: "1",
    unit_label: "repo",
    reserve_price: nearToYocto("0.7").toString(),
    mechanism: "VickreySecondPrice",
    commit_duration_ns: String(120n * 1_000_000_000n),
    reveal_duration_ns: String(15n * 1_000_000_000n),
    delivery_duration_ns: String(900n * 1_000_000_000n),
    dispute_window_ns: String(20n * 1_000_000_000n),
    min_worker_bond: "0",
    max_commits: 4,
    arbiter: null,
  });

  console.log(`[jobs] audit=${jobIds.audit} labeling=${jobIds.labeling} codegen=${jobIds.codegen}`);
  const jobSpecs = Object.fromEntries(
    Object.entries(JOB_BIDS).map(([role, bids]) => [String(jobIds[role]), { bids }]),
  );

  // Commit phase (zero attached NEAR; restricted FunctionCall keys are used for
  // all bidding so the demo proves the agent-safe path on testnet).
  const salts = {};
  for (const [jobKey, jobId] of Object.entries(jobIds)) {
    const spec = jobSpecs[String(jobId)];
    if (!spec) throw new Error(`no spec for job ${jobId}`);
    for (const [worker, bidNear] of Object.entries(spec.bids)) {
      const bid = nearToYocto(bidNear).toString();
      const etaSeconds = "900";
      const salt = randomBytes(12).toString("hex");
      const commitHash = sha256Hex(
        commitPreimage({ jobId: String(jobId), worker, bid, etaSeconds, salt }),
      );
      salts[`${jobId}:${worker}`] = { bid, etaSeconds, salt, commitHash };
      const { hash } = await call(restrictedAccounts[worker], "commit_bid", {
        job_id: String(jobId),
        commit_hash: commitHash,
      });
      record(`${worker}:commit:${jobId}`, hash, worker);
    }
  }

  // Reveal A as soon as its commit window closes.
  await waitForPhase(buyer, jobIds.audit, ["RevealOpen", "AwaitingClear"], 340_000, "audit reveal phase");
  for (const [worker] of Object.entries(jobSpecs[String(jobIds.audit)].bids)) {
    const sealed = salts[`${jobIds.audit}:${worker}`];
    const { hash } = await call(restrictedAccounts[worker], "reveal_bid", {
      job_id: String(jobIds.audit),
      bid_yocto: sealed.bid,
      eta_seconds: sealed.etaSeconds,
      salt: sealed.salt,
    });
    record(`${worker}:reveal:${jobIds.audit}`, hash, worker);
  }

  await waitForPhase(buyer, jobIds.labeling, ["RevealOpen", "AwaitingClear"], 340_000, "labeling reveal phase");
  for (const [worker] of Object.entries(jobSpecs[String(jobIds.labeling)].bids)) {
    const sealed = salts[`${jobIds.labeling}:${worker}`];
    const { hash } = await call(restrictedAccounts[worker], "reveal_bid", {
      job_id: String(jobIds.labeling),
      bid_yocto: sealed.bid,
      eta_seconds: sealed.etaSeconds,
      salt: sealed.salt,
    });
    record(`${worker}:reveal:${jobIds.labeling}`, hash, worker);
  }

  // Clear both auctions. Anyone may call this once the commit window has closed
  // and all committed bids are revealed.
  {
    const { hash } = await call(buyer, "finalize_auction", { job_id: String(jobIds.audit) });
    record("finalize_auction:audit", hash, BUYER);
  }
  {
    const { hash } = await call(buyer, "finalize_auction", { job_id: String(jobIds.labeling) });
    record("finalize_auction:labeling", hash, BUYER);
  }

  const waitForWinner = async (jobId, label) => {
    const deadline = Date.now() + 30_000;
    let job = await getJob(buyer, jobId);
    while (!job.winner && Date.now() < deadline) {
      await sleep(1_000);
      job = await getJob(buyer, jobId);
    }
    if (!job.winner) throw new Error(`${label} job did not clear`);
    return job;
  };
  const auditCleared = await waitForWinner(jobIds.audit, "audit");
  const labelingCleared = await waitForWinner(jobIds.labeling, "labeling");

  // Deliverables from the winners, using their restricted FunctionCall keys.
  {
    const { hash } = await call(
      restrictedAccounts[auditCleared.winner],
      "submit_delivery",
      {
        job_id: String(jobIds.audit),
        deliverable_uri: "ipfs://bafytender-demo-audit-report",
        deliverable_sha256: DELIVERABLE.audit,
      },
      { gas: 80n * TGAS },
    );
    record("submit_delivery:audit", hash, auditCleared.winner);
  }
  {
    const { hash } = await call(
      restrictedAccounts[labelingCleared.winner],
      "submit_delivery",
      {
        job_id: String(jobIds.labeling),
        deliverable_uri: "ipfs://bafytender-demo-labeled-dataset",
        deliverable_sha256: DELIVERABLE.labeling,
      },
      { gas: 80n * TGAS },
    );
    record("submit_delivery:labeling", hash, labelingCleared.winner);
  }

  // Buyer accepts the audit report immediately.
  {
    const { hash } = await call(buyer, "accept_delivery", { job_id: String(jobIds.audit) }, {
      gas: 150n * TGAS,
    });
    record("accept_delivery:audit", hash, BUYER);
  }
  const auditSettled = await waitForStatus(buyer, jobIds.audit, ["Settled"], 120_000, "audit settlement");

  // Labeling job settles optimistically after the dispute window via the
  // winner's restricted FunctionCall key (zero attached NEAR).
  await waitForPhase(buyer, jobIds.labeling, ["ReadyAutoSettle"], 120_000, "labeling dispute window");
  {
    const { hash } = await call(
      restrictedAccounts[labelingCleared.winner],
      "finalize_after_timeout",
      { job_id: String(jobIds.labeling) },
      { gas: 150n * TGAS },
    );
    record("finalize_after_timeout:labeling", hash, labelingCleared.winner);
  }
  const labelingSettled = await waitForStatus(
    buyer,
    jobIds.labeling,
    ["Settled"],
    120_000,
    "labeling settlement",
  );

  // Zero-reveal auction refunds the buyer in full.
  await waitForPhase(buyer, jobIds.codegen, ["AwaitingClear"], 120_000, "codegen reveal close");
  {
    const { hash } = await call(buyer, "finalize_auction", { job_id: String(jobIds.codegen) }, {
      gas: 150n * TGAS,
    });
    record("finalize_auction:codegen", hash, BUYER);
  }
  const codegenRefunded = await waitForStatus(
    buyer,
    jobIds.codegen,
    ["CancelledZeroReveals", "Refunded"],
    120_000,
    "codegen refund",
  );

  // Withdraw the winner's unlocked bond to prove the vault exits cleanly.
  const bond = await view(workers[auditSettled.winner], "get_worker_bond", {
    worker_id: auditSettled.winner,
  });
  if (BigInt(bond.available_yocto) > 0n) {
    const { hash } = await call(
      workers[auditSettled.winner],
      "withdraw_bond",
      { amount: bond.available_yocto },
      { gas: 60n * TGAS, deposit: 1n },
    );
    record("withdraw_bond:audit-winner", hash, auditSettled.winner);
  }

  // Record block heights for the indexer window.
  for (const tx of txs) {
    tx.block_height = await blockHeightOf(tx.hash, tx.signer ?? CONTRACT);
  }
  const heights = txs.map((tx) => tx.block_height).filter((height) => typeof height === "number");
  const latest = await rpc("block", { finality: "final" });

  const summary = {
    network: NETWORK,
    contract_id: CONTRACT,
    generated_at: new Date().toISOString(),
    accounts: { buyer: BUYER, workers: WORKERS },
    jobs: {
      audit: {
        job_id: jobIds.audit,
        category: "smart-contract-audit",
        mechanism: "VickreySecondPrice",
        bids_near: jobSpecs[String(jobIds.audit)].bids,
        winner: auditSettled.winner,
        winning_bid_near: auditSettled.winning_bid ? yoctoToNear(auditSettled.winning_bid) : null,
        runner_up_bid_near: auditSettled.runner_up_bid ? yoctoToNear(auditSettled.runner_up_bid) : null,
        clearing_price_near: auditSettled.clearing_price ? yoctoToNear(auditSettled.clearing_price) : null,
        status: auditSettled.status,
      },
      labeling: {
        job_id: jobIds.labeling,
        category: "data-labeling",
        mechanism: "FirstPrice",
        bids_near: jobSpecs[String(jobIds.labeling)].bids,
        winner: labelingSettled.winner,
        clearing_price_near: labelingSettled.clearing_price
          ? yoctoToNear(labelingSettled.clearing_price)
          : null,
        status: labelingSettled.status,
      },
      codegen: {
        job_id: jobIds.codegen,
        category: "code-generation",
        mechanism: "VickreySecondPrice",
        status: codegenRefunded.status,
      },
    },
    indexer_window: {
      start_block_hint: heights.length > 0 ? Math.max(0, Math.min(...heights) - 3) : null,
      last_tx_block: heights.length > 0 ? Math.max(...heights) : null,
      latest_block: latest.header.height,
    },
    transactions: txs,
  };

  writeFileSync(RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[demo] wrote ${RESULT_PATH}`);
  console.log(
    `[demo] Vickrey audit clearing=${summary.jobs.audit.clearing_price_near} NEAR (winner ${summary.jobs.audit.winner})`,
  );
  console.log(
    `[demo] FirstPrice labeling clearing=${summary.jobs.labeling.clearing_price_near} NEAR (winner ${summary.jobs.labeling.winner})`,
  );
  console.log(`[demo] zero-reveal status=${summary.jobs.codegen.status}`);
  console.log(`[demo] txs=${txs.length} window=${summary.indexer_window.start_block_hint}..${summary.indexer_window.latest_block}`);
}

main().catch((error) => {
  console.error("[demo] FAILED:", error);
  process.exit(1);
});
