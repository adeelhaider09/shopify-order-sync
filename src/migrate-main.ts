import { createPgDb } from "./db.js";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createPgDb(url);
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date");
await db.close();
