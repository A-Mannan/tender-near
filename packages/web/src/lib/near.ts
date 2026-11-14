import { CONTRACT_ID, NEAR_NETWORK, NEAR_RPC_URL, ENABLE_LOCAL_SIGNER } from "./api";

export interface ContractCall {
  methodName: string;
  args: Record<string, unknown>;
  gasTgas?: number;
  depositYocto?: string;
}

export interface WalletSigner {
  kind: "wallet";
  accountId: string;
  wallet: {
    signAndSendTransaction: (params: {
      receiverId: string;
      actions: Array<{
        type: "FunctionCall";
        params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
      }>;
    }) => Promise<unknown>;
  };
}

export interface LocalSigner {
  kind: "local";
  accountId: string;
  account: {
    functionCall: (params: {
      contractId: string;
      methodName: string;
      args: Record<string, unknown>;
      gas: bigint;
      attachedDeposit: bigint;
    }) => Promise<unknown>;
  };
}

export type Signer = WalletSigner | LocalSigner;

interface QueryResponse {
  result?: { result: number[] };
  error?: { message?: string; data?: unknown };
}

export async function viewFunction<T>(methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const argsBase64 = btoa(JSON.stringify(args));
  const response = await fetch(NEAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tender-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: argsBase64,
      },
    }),
  });
  const body = (await response.json()) as QueryResponse;
  if (!response.ok || body.error || !body.result) {
    const detail =
      body.error?.data !== undefined
        ? JSON.stringify(body.error.data)
        : body.error?.message ?? `RPC HTTP ${response.status}`;
    throw new Error(`Contract view ${methodName} failed: ${detail}`);
  }
  const text = new TextDecoder().decode(Uint8Array.from(body.result.result));
  return JSON.parse(text) as T;
}

export async function connectWallet(): Promise<WalletSigner | null> {
  const [{ setupWalletSelector }, { setupMyNearWallet }, { setupModal }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/modal-ui"),
  ]);
  await import("@near-wallet-selector/modal-ui/styles.css");

  const selector = await setupWalletSelector({
    network: NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet",
    modules: [setupMyNearWallet()],
  });
  const modal = setupModal(selector, {
    contractId: CONTRACT_ID,
    description: "Connect a NEAR wallet to post and settle escrowed AI labor jobs.",
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WalletSigner | null) => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      resolve(value);
    };
    const subscription = selector.store.observable.subscribe(async (state) => {
      const account = state.accounts[0];
      if (!account) return;
      try {
        const wallet = (await selector.wallet()) as unknown as WalletSigner["wallet"];
        finish({ kind: "wallet", accountId: account.accountId, wallet });
      } catch {
        finish(null);
      }
    });
    modal.show();
    window.setTimeout(() => finish(null), 180_000);
  });
}

export async function connectLocalSigner(accountId: string, privateKey: string): Promise<LocalSigner> {
  if (!ENABLE_LOCAL_SIGNER) {
    throw new Error("Local testnet signer is disabled in this build.");
  }
  const { connect, keyStores, KeyPair } = await import("near-api-js");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    NEAR_NETWORK,
    accountId,
    KeyPair.fromString(privateKey as Parameters<typeof KeyPair.fromString>[0]),
  );
  const near = await connect({
    networkId: NEAR_NETWORK,
    nodeUrl: NEAR_RPC_URL,
    keyStore,
    headers: {},
  });
  const account = await near.account(accountId);
  return {
    kind: "local",
    accountId,
    account: account as unknown as LocalSigner["account"],
  };
}

export async function executeCall(signer: Signer, call: ContractCall): Promise<string | null> {
  const gasTgas = call.gasTgas ?? 100;
  const deposit = call.depositYocto ?? "0";
  if (signer.kind === "local") {
    const outcome = (await signer.account.functionCall({
      contractId: CONTRACT_ID,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(gasTgas) * 1_000_000_000_000n,
      attachedDeposit: BigInt(deposit),
    })) as { transaction?: { hash?: string } } | null;
    return outcome?.transaction?.hash ?? null;
  }
  const result = (await signer.wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: call.methodName,
          args: call.args,
          gas: (BigInt(gasTgas) * 1_000_000_000_000n).toString(),
          deposit,
        },
      },
    ],
  })) as Array<{ transaction?: { hash?: string } }> | { transaction?: { hash?: string } } | null;
  if (Array.isArray(result)) return result[0]?.transaction?.hash ?? null;
  return result?.transaction?.hash ?? null;
}

export async function requiredStorageDeposit(maxCommits: number): Promise<bigint> {
  const value = await viewFunction<string>("required_job_storage_deposit", { max_commits: maxCommits });
  return BigInt(value);
}

export function buildCommitPreimage(params: {
  jobId: string;
  workerId: string;
  bidYocto: string;
  etaSeconds: string;
  salt: string;
}): string {
  return `tender:v1:${CONTRACT_ID}:${params.jobId}:${params.workerId}:${params.bidYocto}:${params.etaSeconds}:${params.salt}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function randomSaltHex(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function nearToYocto(near: string): string {
  const cleaned = near.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(cleaned)) throw new Error("Enter a non-negative NEAR amount");
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const padded = fraction.padEnd(24, "0").slice(0, 24);
  return (BigInt(whole) * 10n ** 24n + BigInt(padded || "0")).toString();
}

export function yoctoToNearInput(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}
