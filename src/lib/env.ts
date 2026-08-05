import { z } from "zod";

// Validated lazily (not at module load) so `next build` doesn't require
// every secret to exist — each route pulls only the keys it needs.

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_API_ACCESS_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

type Env = z.infer<typeof envSchema>;

export function requireEnv<K extends keyof Env>(...keys: K[]): Pick<Env, K> {
  const values = {} as Pick<Env, K>;
  const missing: string[] = [];
  for (const key of keys) {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
    } else {
      values[key] = value as Env[K];
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  return values;
}
