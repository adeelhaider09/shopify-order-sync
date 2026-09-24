import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgDb } from "./db.js";

const config = loadConfig();
const db = createPgDb(config.DATABASE_URL);
const app = buildApp({
  db,
  webhookSecret: config.SHOPIFY_WEBHOOK_SECRET,
  apiToken: config.API_TOKEN,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
