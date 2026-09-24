// End-to-end check against a running API + worker + Postgres:
// sign and deliver an orders/create webhook, then poll the read API until the worker has stored it.
import { createHmac, randomUUID } from "node:crypto";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
const token = process.env.API_TOKEN;
const shop = "smoke-test.myshopify.com";
const orderId = Date.now();

const body = JSON.stringify({
  id: orderId,
  name: "#SMOKE",
  email: "smoke@example.com",
  financial_status: "paid",
  currency: "USD",
  total_price: "42.00",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [{ id: orderId + 1, sku: "SMOKE-1", title: "Smoke item", quantity: 1, price: "42.00" }],
});

const res = await fetch(`${base}/webhooks/shopify`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
    "x-shopify-webhook-id": randomUUID(),
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": shop,
  },
  body,
});
if (res.status !== 200) throw new Error(`webhook returned ${res.status}: ${await res.text()}`);
console.log("webhook accepted");

for (let i = 0; i < 30; i++) {
  const r = await fetch(`${base}/orders/${orderId}?shop=${shop}`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 200) {
    const order = await r.json();
    if (order.totalPrice !== "42.00" || order.lineItems.length !== 1) throw new Error(`unexpected order ${JSON.stringify(order)}`);
    console.log(`order ${order.name} synced by worker`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
throw new Error("order never appeared; is the worker running?");
