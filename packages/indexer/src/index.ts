import { createApiServer } from "./api.js";
import { loadConfig } from "./config.js";
import { TapeDb } from "./db.js";
import { Indexer } from "./poller.js";
import { NearRpc } from "./rpc.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new TapeDb(config.dbPath);
  const rpc = new NearRpc(config.rpcUrl);
  const indexer = new Indexer({ rpc, db, config });

  const mode = process.argv[2] ?? "serve";

  if (mode === "--rebuild") {
    const count = db.rebuildAll();
    console.log(`[indexer] rebuilt ${count} job projections from stored events`);
    db.close();
    return;
  }

  if (mode === "--once") {
    const summary = await indexer.syncOnce();
    console.log(JSON.stringify(summary, null, 2));
    db.close();
    return;
  }

  const server = createApiServer({ config, db, indexer });
  server.listen(config.port, config.host, () => {
    console.log(`[api] Tender indexer listening on http://${config.host}:${config.port}`);
    console.log(`[api] rpc=${config.rpcUrl} db=${config.dbPath} network=${config.network}`);
  });

  indexer.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[indexer] received ${signal}, shutting down`);
    void indexer.stop().finally(() => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[indexer] fatal:", error);
  process.exit(1);
});