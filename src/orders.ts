import type { Queryable } from "./db.js";
import type { ShopifyOrder } from "./shopify-order.js";

export interface OrderSummary {
  id: string;
  shop: string;
  name: string;
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string;
  totalPrice: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDetail extends OrderSummary {
  lineItems: { id: string; sku: string | null; title: string; quantity: number; price: string }[];
}

/**
 * Upserts an order and replaces its line items, all in the caller's transaction.
 * Shopify doesn't guarantee delivery order, so an older payload arriving after
 * a newer one must not overwrite it: the WHERE on the conflict branch keeps the
 * row with the latest updated_at. Returns false when the payload was stale.
 */
export async function upsertOrder(tx: Queryable, shop: string, order: ShopifyOrder): Promise<boolean> {
  const { rows } = await tx.query(
    `INSERT INTO orders (shop_domain, shopify_id, name, email, financial_status, fulfillment_status,
                         currency, total_price, cancelled_at, shopify_created_at, shopify_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (shop_domain, shopify_id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       financial_status = EXCLUDED.financial_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       currency = EXCLUDED.currency,
       total_price = EXCLUDED.total_price,
       cancelled_at = EXCLUDED.cancelled_at,
       shopify_updated_at = EXCLUDED.shopify_updated_at,
       synced_at = now()
     WHERE orders.shopify_updated_at <= EXCLUDED.shopify_updated_at
     RETURNING shopify_id`,
    [
      shop,
      order.id,
      order.name,
      order.email ?? null,
      order.financial_status ?? null,
      order.fulfillment_status ?? null,
      order.currency,
      order.total_price,
      order.cancelled_at ?? null,
      order.created_at,
      order.updated_at,
    ],
  );

  if (rows.length === 0) return false;

  await tx.query(`DELETE FROM order_line_items WHERE shop_domain = $1 AND order_id = $2`, [shop, order.id]);
  for (const item of order.line_items) {
    await tx.query(
      `INSERT INTO order_line_items (shop_domain, shopify_id, order_id, sku, title, quantity, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shop, item.id, order.id, item.sku ?? null, item.title, item.quantity, item.price],
    );
  }
  return true;
}

export async function deleteOrder(tx: Queryable, shop: string, shopifyId: number): Promise<void> {
  await tx.query(`DELETE FROM orders WHERE shop_domain = $1 AND shopify_id = $2`, [shop, shopifyId]);
}

// Bigints and numerics are cast to text in SQL so ids and money never pass through a JS float.
const SUMMARY_COLUMNS = `
  shopify_id::text AS id, shop_domain AS shop, name, email,
  financial_status, fulfillment_status, currency, total_price::text AS total_price,
  cancelled_at, shopify_created_at, shopify_updated_at`;

interface OrderRow {
  id: string;
  shop: string;
  name: string;
  email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string;
  total_price: string;
  cancelled_at: Date | string | null;
  shopify_created_at: Date | string;
  shopify_updated_at: Date | string;
}

const iso = (v: Date | string) => new Date(v).toISOString();

function toSummary(r: OrderRow): OrderSummary {
  return {
    id: r.id,
    shop: r.shop,
    name: r.name,
    email: r.email,
    financialStatus: r.financial_status,
    fulfillmentStatus: r.fulfillment_status,
    currency: r.currency,
    totalPrice: r.total_price,
    cancelledAt: r.cancelled_at ? iso(r.cancelled_at) : null,
    createdAt: iso(r.shopify_created_at),
    updatedAt: iso(r.shopify_updated_at),
  };
}

export interface ListOrdersQuery {
  shop: string;
  limit: number;
  financialStatus?: string;
  cursor?: { createdAt: string; id: string };
}

/**
 * Keyset pagination on (created_at, id) rather than OFFSET: page cost stays
 * flat however deep the client goes, and rows inserted between requests don't
 * shift or duplicate results.
 */
export async function listOrders(db: Queryable, q: ListOrdersQuery) {
  const params: unknown[] = [q.shop, q.limit + 1];
  const where = [`shop_domain = $1`];

  if (q.financialStatus) {
    params.push(q.financialStatus);
    where.push(`financial_status = $${params.length}`);
  }
  if (q.cursor) {
    params.push(q.cursor.createdAt, q.cursor.id);
    where.push(`(shopify_created_at, shopify_id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  const { rows } = await db.query<OrderRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM orders
      WHERE ${where.join(" AND ")}
      ORDER BY shopify_created_at DESC, shopify_id DESC
      LIMIT $2`,
    params,
  );

  const page = rows.slice(0, q.limit).map(toSummary);
  const last = page.at(-1);
  const nextCursor = rows.length > q.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { orders: page, nextCursor };
}

export async function getOrder(db: Queryable, shop: string, id: string): Promise<OrderDetail | null> {
  const { rows } = await db.query<OrderRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM orders WHERE shop_domain = $1 AND shopify_id = $2::bigint`,
    [shop, id],
  );
  const row = rows[0];
  if (!row) return null;

  const items = await db.query<{ id: string; sku: string | null; title: string; quantity: number; price: string }>(
    `SELECT shopify_id::text AS id, sku, title, quantity, price::text AS price
       FROM order_line_items
      WHERE shop_domain = $1 AND order_id = $2::bigint
      ORDER BY shopify_id`,
    [shop, id],
  );
  return { ...toSummary(row), lineItems: items.rows };
}

export function encodeCursor(c: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof value?.createdAt !== "string" || !/^\d+$/.test(value?.id)) return null;
    if (Number.isNaN(Date.parse(value.createdAt))) return null;
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    return null;
  }
}
