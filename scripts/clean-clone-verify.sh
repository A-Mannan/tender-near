#!/usr/bin/env bash
# Clean-clone gate proof. Clones the local repository into an isolated
# directory (no node_modules, no target, no .data) and runs every gate.
#
# Usage: scripts/clean-clone-verify.sh [target-dir]
# Requires: git, node >=22.5, npm, rustc/cargo 1.86, openspec, network access
# to the public NEAR testnet RPC.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-/tmp/opencode/tender-clean-verify}"

echo "==> source: ${REPO_ROOT}"
echo "==> target: ${TARGET}"

rm -rf "${TARGET}"
git clone --quiet "${REPO_ROOT}" "${TARGET}"
cd "${TARGET}"

# Prove the clone has no local artifacts or secrets.
test ! -d .data
test ! -d node_modules
test ! -d packages/web/dist

echo "==> npm ci"
npm ci --silent

echo "==> openspec validate"
openspec validate tender-mvp --strict

echo "==> contract tests (unit + near-sandbox)"
cargo test --manifest-path contracts/tender/Cargo.toml

echo "==> contract wasm build"
(
  cd contracts/tender
  cargo near build non-reproducible-wasm
)
test -s contracts/tender/target/near/tender.wasm

echo "==> indexer tests"
npm run indexer:test

echo "==> web typecheck + production build"
npm --prefix packages/web run build

echo "==> testnet read-only check"
node -e '
const { readFileSync } = require("node:fs");
const deploy = JSON.parse(readFileSync("deployments/testnet.json", "utf8"));
const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "query",
  params: {
    request_type: "call_function",
    finality: "final",
    account_id: deploy.contract_id,
    method_name: "get_job_count",
    args_base64: Buffer.from("{}").toString("base64"),
  },
};
fetch(process.env.NEAR_RPC_URL || "https://near-testnet.drpc.org", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
  .then((response) => response.json())
  .then((json) => {
    if (json.error || json.result?.error) throw new Error(JSON.stringify(json.error ?? json.result.error));
    const count = JSON.parse(Buffer.from(json.result.result).toString("utf8"));
    console.log(`[clean-clone] get_job_count=${count}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
'

echo "==> Playwright browser"
(
  cd packages/web
  npx playwright install chromium
)

echo "==> Playwright (desktop 1440x900 + mobile 375x812)"
(
  cd packages/web
  # Isolated ports: the verifier must not depend on (or fight over) a local dev server.
  TENDER_E2E_INDEXER_PORT="${TENDER_E2E_INDEXER_PORT:-8877}" \
  TENDER_E2E_WEB_PORT="${TENDER_E2E_WEB_PORT:-4274}" \
  npx playwright test
)

echo "==> clean-clone gates passed"
