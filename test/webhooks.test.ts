import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { signShopifyBody } from "../src/hmac.js";
import { createTestDb, orderPayload, resetDb } from "./helpers.js";

const secret = "webhook-secret";
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ db, webhookSecret: secret, apiToken: "test-api-token-123456" });
});

beforeEach(() => resetDb(db));

afterAll(async () => {
  await app.close();
  await db.close();
});

function deliver(body: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/webhooks/shopify",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signShopifyBody(body, secret),
      "x-shopify-webhook-id": "wh-1",
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": "demo.myshopify.com",
      ...headers,
    },
  });
}

describe("POST /webhooks/shopify", () => {
  it("stores a signed delivery as a pending event", async () => {
    const res = await deliver(JSON.stringify(orderPayload()));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });

    const { rows } = await db.query<{ topic: string; status: string; shop_domain: string }>(
      "SELECT topic, status, shop_domain FROM webhook_events",
    );
    expect(rows).toEqual([{ topic: "orders/create", status: "pending", shop_domain: "demo.myshopify.com" }]);
  });

  it("treats a redelivery with the same webhook id as a no-op", async () => {
    const body = JSON.stringify(orderPayload());
    await deliver(body);
    const second = await deliver(body);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ received: true, duplicate: true });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events");
    expect(rows[0]?.n).toBe(1);
  });

  it("rejects an invalid signature and stores nothing", async () => {
    const res = await deliver(JSON.stringify(orderPayload()), { "x-shopify-hmac-sha256": "bm9wZQ==" });

    expect(res.statusCode).toBe(401);
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events");
    expect(rows[0]?.n).toBe(0);
  });

  it("requires the Shopify metadata headers", async () => {
    const res = await deliver(JSON.stringify(orderPayload()), { "x-shopify-topic": "" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a signed body that isn't JSON", async () => {
    const res = await deliver("not json");
    expect(res.statusCode).toBe(400);
  });
});
