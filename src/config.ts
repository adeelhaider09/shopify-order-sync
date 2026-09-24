import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  API_TOKEN: z.string().min(16, "API_TOKEN should be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
