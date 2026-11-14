import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { TapeDb } from "../src/db.js";
import { Indexer } from "../src/poller.js";

let dir: string;
let db: TapeDb;
let dbPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tender-bounded-sync-"));
  dbPath = join(dir, "bounded.sqlite");
  db = new TapeDb(dbPath);
  for (let height = 1; height <= 3; height += 1) {
    db.applyBlock({ height, hash: `block-${height}`, timestampNs: `${height}` }, []);
  }
});

after(async () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a completed bounded window does not query the public RPC", async () => {
  const rpc = {
    getLatestBlock: async () => {
      throw new Error("RPC must not be queried for an already completed window");
    },
  };
  const config = loadConfig({
    TENDER_DB: dbPath,
    TENDER_START_BLOCK: "1",
    TENDER_END_BLOCK: "3",
  });
  const indexer = new Indexer({ db, config, rpc: rpc as never });
  const summary = await indexer.syncOnce();
  assert.equal(summary.from, null);
  assert.equal(summary.to, null);
  assert.equal(summary.blocks, 0);
  assert.equal(indexer.status().last_error, null);
  assert.equal(indexer.status().last_rpc_height, null);
});
