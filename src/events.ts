import type { Queryable } from "./db.js";

export interface IncomingEvent {
  webhookId: string;
  topic: string;
  shopDomain: string;
  payload: unknown;
}

export interface ClaimedEvent {
  id: string;
  webhookId: string;
  topic: string;
  shopDomain: string;
  payload: unknown;
  attempts: number;
}

/** How long a claimed event stays invisible to other workers before it is retried. */
const LEASE_SECONDS = 300;

/**
 * Stores a delivery once. Shopify retries deliveries it thinks failed, so the
 * same X-Shopify-Webhook-Id can arrive more than once.
 */
export async function recordEvent(db: Queryable, event: IncomingEvent): Promise<{ duplicate: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO webhook_events (webhook_id, topic, shop_domain, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (webhook_id) DO NOTHING
     RETURNING id`,
    [event.webhookId, event.topic, event.shopDomain, JSON.stringify(event.payload)],
  );
  return { duplicate: rows.length === 0 };
}

/**
 * Claims up to `limit` due events. SKIP LOCKED lets several workers pull from
 * the same table without handing out the same row twice. The lease moves
 * available_at forward, so a worker that crashes mid-batch doesn't lose events:
 * they become due again when the lease expires.
 */
export async function claimDueEvents(db: Queryable, limit: number): Promise<ClaimedEvent[]> {
  const { rows } = await db.query<{
    id: string | number;
    webhook_id: string;
    topic: string;
    shop_domain: string;
    payload: unknown;
    attempts: number;
  }>(
    `UPDATE webhook_events
        SET attempts = attempts + 1,
            available_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM webhook_events
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY available_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, webhook_id, topic, shop_domain, payload, attempts`,
    [limit, LEASE_SECONDS],
  );

  return rows
    .map((r) => ({
      id: String(r.id),
      webhookId: r.webhook_id,
      topic: r.topic,
      shopDomain: r.shop_domain,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      attempts: r.attempts,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export async function markProcessed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE webhook_events SET status = 'processed', processed_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

export async function markFailed(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(`UPDATE webhook_events SET status = 'failed', last_error = $2 WHERE id = $1`, [id, error]);
}

export async function scheduleRetry(db: Queryable, id: string, error: string, delaySeconds: number): Promise<void> {
  await db.query(
    `UPDATE webhook_events
        SET last_error = $2, available_at = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [id, error, delaySeconds],
  );
}
