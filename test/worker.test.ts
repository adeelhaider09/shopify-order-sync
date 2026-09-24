import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db, Queryable } from "../src/db.js";
import { recordEvent } from "../src/events.js";
import { getOrder } from "../src/orders.js";
import { processBatch, retryDelaySeconds } from "../src/worker.js";
import { createTestDb, orderPayload, resetDb } from "./helpers.js";

const shop = "demo.myshopify.com";
const orderId = String(orderPayload().id);
let db: Db;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(() => resetDb(db));

afterAll(async () => {
  await db.close();
});

function enqueue(topic: string, payload: unknown) {
  return recordEvent(db, { webhookId: `wh-${++seq}`, topic, shopDomain: shop, payload });
}

const run = (overrides: Partial<Parameters<typeof processBatch>[1]> = {}) =>
  processBatch(db, { batchSize: 10, maxAttempts: 3, ...overrides });

async function eventStates() {
  const { rows } = await db.query<{ status: string; attempts: number; last_error: string | null }>(
    "SELECT status, attempts, last_error FROM webhook_events ORDER BY id",
  );
  return rows;
}

describe("processBatch", () => {
  it("turns an orders/create event into an order with line items", async () => {
    await enqueue("orders/create", orderPayload());

    expect(await run()).toEqual({ processed: 1, retried: 0, failed: 0 });

    const order = await getOrder(db, shop, orderId);
    expect(order).toMatchObject({
      id: orderId,
      name: "#1001",
      totalPrice: "129.50",
      financialStatus: "paid",
      createdAt: "2026-09-01T14:00:00.000Z",
    });
    expect(order?.lineItems.map((i) => [i.sku, i.quantity, i.price])).toEqual([
      ["BOARD-01", 1, "99.50"],
      [null, 2, "15.00"],
    ]);
    expect((await eventStates())[0]?.status).toBe("processed");
  });

  it("applies a newer update and replaces line items", async () => {
    await enqueue("orders/create", orderPayload());
    await enqueue(
      "orders/updated",
      orderPayload({
        updated_at: "2026-09-02T09:00:00Z",
        fulfillment_status: "fulfilled",
        line_items: [{ id: 9_100_000_000_001, sku: "BOARD-01", title: "Board", quantity: 1, price: "99.50" }],
      }),
    );
    await run();

    const order = await getOrder(db, shop, orderId);
    expect(order?.fulfillmentStatus).toBe("fulfilled");
    expect(order?.lineItems).toHaveLength(1);
  });

  it("ignores a stale update that arrives after a newer one", async () => {
    await enqueue("orders/updated", orderPayload({ updated_at: "2026-09-03T00:00:00Z", financial_status: "refunded" }));
    await enqueue("orders/updated", orderPayload({ updated_at: "2026-09-02T00:00:00Z", financial_status: "paid" }));

    expect(await run()).toEqual({ processed: 2, retried: 0, failed: 0 });
    expect((await getOrder(db, shop, orderId))?.financialStatus).toBe("refunded");
  });

  it("removes the order on orders/delete", async () => {
    await enqueue("orders/create", orderPayload());
    await enqueue("orders/delete", { id: orderPayload().id });
    await run();

    expect(await getOrder(db, shop, orderId)).toBeNull();
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM order_line_items");
    expect(rows[0]?.n).toBe(0);
  });

  it("fails an invalid payload immediately instead of retrying", async () => {
    await enqueue("orders/create", { id: "not-a-number" });

    expect(await run()).toEqual({ processed: 0, retried: 0, failed: 1 });
    const [state] = await eventStates();
    expect(state).toMatchObject({ status: "failed", attempts: 1 });
    expect(state?.last_error).toMatch(/invalid order payload/);
  });

  it("fails unsupported topics without retrying", async () => {
    await enqueue("products/update", { id: 1 });
    expect(await run()).toEqual({ processed: 0, retried: 0, failed: 1 });
  });

  it("retries transient errors with backoff, then gives up after maxAttempts", async () => {
    await enqueue("orders/create", orderPayload());
    const flaky = { "orders/create": async () => { throw new Error("upstream timeout"); } };

    expect(await run({ handlers: flaky })).toEqual({ processed: 0, retried: 1, failed: 0 });

    // Backoff pushed the event into the future, so an immediate second pass finds nothing.
    expect(await run({ handlers: flaky })).toEqual({ processed: 0, retried: 0, failed: 0 });

    const makeDue = () => db.query("UPDATE webhook_events SET available_at = now()");
    await makeDue();
    expect(await run({ handlers: flaky })).toMatchObject({ retried: 1 });
    await makeDue();
    expect(await run({ handlers: flaky })).toMatchObject({ failed: 1 });

    expect((await eventStates())[0]).toMatchObject({ status: "failed", attempts: 3, last_error: "upstream timeout" });
  });

  it("rolls back a handler's partial writes when it throws", async () => {
    await enqueue("orders/create", orderPayload());
    const halfDone = {
      "orders/create": async (tx: Queryable) => {
        await tx.query(
          `INSERT INTO orders (shop_domain, shopify_id, name, currency, total_price, shopify_created_at, shopify_updated_at)
           VALUES ($1, 1, 'partial', 'USD', 1, now(), now())`,
          [shop],
        );
        throw new Error("crashed halfway");
      },
    };
    await run({ handlers: halfDone });

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders");
    expect(rows[0]?.n).toBe(0);
  });
});

describe("retryDelaySeconds", () => {
  it("doubles each attempt and caps at an hour", () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});
