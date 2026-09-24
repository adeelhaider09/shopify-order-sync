import type { Db, Queryable } from "./db.js";
import { claimDueEvents, markFailed, markProcessed, scheduleRetry, type ClaimedEvent } from "./events.js";
import { deleteOrder, upsertOrder } from "./orders.js";
import { shopifyOrderDeleteSchema, shopifyOrderSchema } from "./shopify-order.js";

/** Thrown for events that can never succeed (bad payload, unknown topic): no point retrying. */
export class PermanentError extends Error {}

export type TopicHandler = (tx: Queryable, event: ClaimedEvent) => Promise<void>;

async function handleOrderUpsert(tx: Queryable, event: ClaimedEvent) {
  const parsed = shopifyOrderSchema.safeParse(event.payload);
  if (!parsed.success) throw new PermanentError(`invalid order payload: ${parsed.error.issues[0]?.message}`);
  await upsertOrder(tx, event.shopDomain, parsed.data);
}

async function handleOrderDelete(tx: Queryable, event: ClaimedEvent) {
  const parsed = shopifyOrderDeleteSchema.safeParse(event.payload);
  if (!parsed.success) throw new PermanentError("invalid orders/delete payload");
  await deleteOrder(tx, event.shopDomain, parsed.data.id);
}

export const defaultHandlers: Record<string, TopicHandler> = {
  "orders/create": handleOrderUpsert,
  "orders/updated": handleOrderUpsert,
  "orders/paid": handleOrderUpsert,
  "orders/cancelled": handleOrderUpsert,
  "orders/fulfilled": handleOrderUpsert,
  "orders/delete": handleOrderDelete,
};

/** Exponential backoff capped at one hour: 30s, 60s, 120s, ... */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 3600);
}

export interface WorkerOptions {
  batchSize: number;
  maxAttempts: number;
  handlers?: Record<string, TopicHandler>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BatchResult {
  processed: number;
  retried: number;
  failed: number;
}

/**
 * Claims one batch and applies each event in its own transaction, so one bad
 * event can't roll back the others.
 */
export async function processBatch(db: Db, opts: WorkerOptions): Promise<BatchResult> {
  const handlers = opts.handlers ?? defaultHandlers;
  const log = opts.log ?? (() => {});
  const result: BatchResult = { processed: 0, retried: 0, failed: 0 };

  const events = await claimDueEvents(db, opts.batchSize);

  for (const event of events) {
    const handler = handlers[event.topic];
    try {
      if (!handler) throw new PermanentError(`unsupported topic ${event.topic}`);
      await db.transaction(async (tx) => {
        await handler(tx, event);
        await markProcessed(tx, event.id);
      });
      result.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PermanentError || event.attempts >= opts.maxAttempts) {
        await markFailed(db, event.id, message);
        result.failed++;
        log("event failed", { id: event.id, topic: event.topic, attempts: event.attempts, error: message });
      } else {
        const delay = retryDelaySeconds(event.attempts);
        await scheduleRetry(db, event.id, message, delay);
        result.retried++;
        log("event retry scheduled", { id: event.id, topic: event.topic, attempts: event.attempts, delay });
      }
    }
  }

  return result;
}

/** Polls until the signal aborts. Drains back-to-back while there is work, sleeps when idle. */
export async function runWorker(db: Db, opts: WorkerOptions & { pollMs: number; signal: AbortSignal }) {
  while (!opts.signal.aborted) {
    let claimed = 0;
    try {
      const r = await processBatch(db, opts);
      claimed = r.processed + r.retried + r.failed;
    } catch (err) {
      opts.log?.("batch error", { error: err instanceof Error ? err.message : String(err) });
    }
    if (claimed === 0) await sleep(opts.pollMs, opts.signal);
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
