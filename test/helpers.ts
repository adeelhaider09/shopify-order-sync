import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "../src/db.js";
import { migrate } from "../src/migrate.js";

/**
 * Real Postgres compiled to WASM, in-process. Tests exercise the actual SQL
 * (ON CONFLICT, SKIP LOCKED, keyset comparisons) without needing Docker.
 */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();

  const wrap = (client: Pick<PGlite, "query" | "exec">): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
  });

  const db: Db = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };

  await migrate(db);
  return db;
}

export async function resetDb(db: Db): Promise<void> {
  await db.exec("TRUNCATE webhook_events, order_line_items, orders RESTART IDENTITY CASCADE");
}

export function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 5_500_000_000_001,
    name: "#1001",
    email: "buyer@example.com",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "USD",
    total_price: "129.50",
    cancelled_at: null,
    created_at: "2026-09-01T10:00:00-04:00",
    updated_at: "2026-09-01T10:00:00-04:00",
    line_items: [
      { id: 9_100_000_000_001, sku: "BOARD-01", title: "Board", quantity: 1, price: "99.50" },
      { id: 9_100_000_000_002, sku: null, title: "Fin set", quantity: 2, price: "15.00" },
    ],
    ...overrides,
  };
}
