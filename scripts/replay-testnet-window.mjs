#!/usr/bin/env node
/** Seed a fresh database from the committed public testnet replay; no credentials required. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TapeDb } from "../packages/indexer/dist/src/db.js";
import { applyReplayWindow } from "../packages/indexer/dist/src/replay.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(process.env.TENDER_DB ?? `${ROOT}/.data/e2e.sqlite`);
const replay = JSON.parse(readFileSync(`${ROOT}/deployments/testnet-replay.json`, "utf8"));
mkdirSync(dirname(dbPath), { recursive: true });
const db = new TapeDb(dbPath);
try {
  const summary = applyReplayWindow(db, replay);
  console.log(
    `[replay] seeded ${summary.blocks} public ${replay.network} blocks and ${summary.events} events into ${dbPath}`,
  );
} finally {
  db.close();
}
