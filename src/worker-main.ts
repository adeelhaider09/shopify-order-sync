import { loadConfig } from "./config.js";
import { createPgDb } from "./db.js";
import { runWorker } from "./worker.js";

const config = loadConfig();
const db = createPgDb(config.DATABASE_URL);
const controller = new AbortController();

const log = (msg: string, meta?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...meta }));

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

log("worker started", { batchSize: config.WORKER_BATCH_SIZE });
await runWorker(db, {
  batchSize: config.WORKER_BATCH_SIZE,
  maxAttempts: config.WORKER_MAX_ATTEMPTS,
  pollMs: config.WORKER_POLL_MS,
  signal: controller.signal,
  log,
});
await db.close();
log("worker stopped");
