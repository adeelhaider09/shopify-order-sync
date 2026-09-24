import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { recordEvent } from "./events.js";
import { safeEqualStrings, verifyShopifyHmac } from "./hmac.js";
import { decodeCursor, getOrder, listOrders } from "./orders.js";

export interface AppOptions {
  db: Db;
  webhookSecret: string;
  apiToken: string;
  logger?: FastifyServerOptions["logger"];
}

const listQuery = z.object({
  shop: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  financial_status: z.string().optional(),
});

const getQuery = z.object({ shop: z.string().min(1) });
const idParam = z.object({ id: z.string().regex(/^\d+$/, "id must be numeric") });

const header = (value: string | string[] | undefined) => (typeof value === "string" && value.trim()) || undefined;

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.get("/healthz", async (_req, reply) => {
    try {
      await opts.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Webhooks get their own scope so the raw-body parser doesn't leak into the JSON API.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/shopify", async (req, reply) => {
      const raw = req.body as Buffer;
      const hmac = req.headers["x-shopify-hmac-sha256"];
      if (!verifyShopifyHmac(raw, typeof hmac === "string" ? hmac : undefined, opts.webhookSecret)) {
        return reply.code(401).send({ error: "invalid signature" });
      }

      const webhookId = header(req.headers["x-shopify-webhook-id"]);
      const topic = header(req.headers["x-shopify-topic"]);
      const shopDomain = header(req.headers["x-shopify-shop-domain"]);
      if (!webhookId || !topic || !shopDomain) {
        return reply.code(400).send({ error: "missing Shopify headers" });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "body is not valid JSON" });
      }

      // Only persist here. Shopify expects a response within 5 seconds and retries
      // otherwise, so the actual processing happens in the worker.
      const { duplicate } = await recordEvent(opts.db, { webhookId, topic, shopDomain, payload });
      return { received: true, duplicate };
    });
  });

  app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token || !safeEqualStrings(token, opts.apiToken)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    api.get("/orders", async (req, reply) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message });

      let cursor;
      if (q.data.cursor) {
        cursor = decodeCursor(q.data.cursor);
        if (!cursor) return reply.code(400).send({ error: "invalid cursor" });
      }

      return listOrders(opts.db, {
        shop: q.data.shop,
        limit: q.data.limit,
        financialStatus: q.data.financial_status,
        cursor,
      });
    });

    api.get("/orders/:id", async (req, reply) => {
      const params = idParam.safeParse(req.params);
      const q = getQuery.safeParse(req.query);
      if (!params.success) return reply.code(400).send({ error: params.error.issues[0]?.message });
      if (!q.success) return reply.code(400).send({ error: "shop is required" });

      const order = await getOrder(opts.db, q.data.shop, params.data.id);
      if (!order) return reply.code(404).send({ error: "order not found" });
      return order;
    });
  });

  return app;
}
