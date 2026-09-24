import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { upsertOrder } from "../src/orders.js";
import { shopifyOrderSchema } from "../src/shopify-order.js";
import { createTestDb, orderPayload } from "./helpers.js";

const token = "test-api-token-123456";
const shop = "demo.myshopify.com";
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ db, webhookSecret: "unused", apiToken: token });

  // Seven orders one hour apart; two share a timestamp to exercise the id tiebreak.
  for (let i = 1; i <= 7; i++) {
    const hour = i === 7 ? 6 : i;
    const created = `2026-09-10T${String(hour).padStart(2, "0")}:00:00Z`;
    const payload = orderPayload({
      id: 1000 + i,
      name: `#${1000 + i}`,
      financial_status: i % 2 === 0 ? "refunded" : "paid",
      created_at: created,
      updated_at: created,
      line_items: [
        { id: 90_000 + i * 10, sku: "BOARD-01", title: "Board", quantity: 1, price: "99.50" },
        { id: 90_001 + i * 10, sku: null, title: "Fin set", quantity: 2, price: "15.00" },
      ],
    });
    await db.transaction((tx) => upsertOrder(tx, shop, shopifyOrderSchema.parse(payload)));
  }
  await db.transaction((tx) =>
    upsertOrder(tx, "other.myshopify.com", shopifyOrderSchema.parse(orderPayload({ id: 1 }))),
  );
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const get = (url: string, auth = `Bearer ${token}`) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: auth } : {} });

describe("GET /orders", () => {
  it("requires a bearer token", async () => {
    expect((await get(`/orders?shop=${shop}`, "")).statusCode).toBe(401);
    expect((await get(`/orders?shop=${shop}`, "Bearer wrong")).statusCode).toBe(401);
  });

  it("pages through every order newest first without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string = `/orders?shop=${shop}&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await get(url)).json() as { orders: { id: string }[]; nextCursor: string | null };
      seen.push(...body.orders.map((o) => o.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(["1007", "1006", "1005", "1004", "1003", "1002", "1001"]);
  });

  it("scopes results to the requested shop", async () => {
    const body = (await get(`/orders?shop=other.myshopify.com`)).json();
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(["1"]);
  });

  it("filters by financial status", async () => {
    const body = (await get(`/orders?shop=${shop}&financial_status=refunded`)).json();
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(["1006", "1004", "1002"]);
  });

  it("validates query parameters", async () => {
    expect((await get(`/orders`)).statusCode).toBe(400);
    expect((await get(`/orders?shop=${shop}&limit=1000`)).statusCode).toBe(400);
    expect((await get(`/orders?shop=${shop}&cursor=garbage`)).statusCode).toBe(400);
  });
});

describe("GET /orders/:id", () => {
  it("returns the order with its line items", async () => {
    const res = await get(`/orders/1003?shop=${shop}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "1003", name: "#1003", lineItems: [{ sku: "BOARD-01" }, { sku: null }] });
  });

  it("returns 404 for an order in another shop", async () => {
    expect((await get(`/orders/1003?shop=other.myshopify.com`)).statusCode).toBe(404);
  });

  it("rejects non-numeric ids", async () => {
    expect((await get(`/orders/abc?shop=${shop}`)).statusCode).toBe(400);
  });
});

describe("GET /healthz", () => {
  it("reports database connectivity without auth", async () => {
    expect((await get("/healthz", "")).json()).toEqual({ ok: true });
  });
});
