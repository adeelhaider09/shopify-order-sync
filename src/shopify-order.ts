import { z } from "zod";

/**
 * The subset of Shopify's order webhook payload this service stores. Shopify
 * sends many more fields; unknown keys are ignored rather than rejected so a
 * new API version doesn't break ingestion.
 */
const money = z.union([z.string(), z.number()]).transform((v) => String(v));

const lineItem = z.object({
  id: z.number().int(),
  sku: z.string().nullish(),
  title: z.string(),
  quantity: z.number().int().nonnegative(),
  price: money,
});

export const shopifyOrderSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullish(),
  financial_status: z.string().nullish(),
  fulfillment_status: z.string().nullish(),
  currency: z.string().length(3),
  total_price: money,
  cancelled_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  line_items: z.array(lineItem).default([]),
});

export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;

export const shopifyOrderDeleteSchema = z.object({ id: z.number().int() });
