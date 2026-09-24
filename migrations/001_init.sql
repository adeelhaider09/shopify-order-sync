-- Raw webhook deliveries. Acts as both an audit log and a job queue for the worker.
CREATE TABLE webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    TEXT        NOT NULL UNIQUE,  -- X-Shopify-Webhook-Id, used for idempotency
  topic         TEXT        NOT NULL,
  shop_domain   TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processed', 'failed')),
  attempts      INT         NOT NULL DEFAULT 0,
  last_error    TEXT,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

-- The worker only ever scans pending rows that are due, so keep that index small.
CREATE INDEX webhook_events_due_idx ON webhook_events (available_at, id) WHERE status = 'pending';

CREATE TABLE orders (
  shop_domain         TEXT          NOT NULL,
  shopify_id          BIGINT        NOT NULL,
  name                TEXT          NOT NULL,
  email               TEXT,
  financial_status    TEXT,
  fulfillment_status  TEXT,
  currency            CHAR(3)       NOT NULL,
  total_price         NUMERIC(12,2) NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  shopify_created_at  TIMESTAMPTZ   NOT NULL,
  shopify_updated_at  TIMESTAMPTZ   NOT NULL,
  synced_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_domain, shopify_id)
);

-- Supports keyset pagination: newest orders first, per shop.
CREATE INDEX orders_shop_created_idx ON orders (shop_domain, shopify_created_at DESC, shopify_id DESC);

CREATE TABLE order_line_items (
  shop_domain  TEXT          NOT NULL,
  shopify_id   BIGINT        NOT NULL,
  order_id     BIGINT        NOT NULL,
  sku          TEXT,
  title        TEXT          NOT NULL,
  quantity     INT           NOT NULL CHECK (quantity >= 0),
  price        NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (shop_domain, shopify_id),
  FOREIGN KEY (shop_domain, order_id) REFERENCES orders (shop_domain, shopify_id) ON DELETE CASCADE
);

CREATE INDEX order_line_items_order_idx ON order_line_items (shop_domain, order_id);
