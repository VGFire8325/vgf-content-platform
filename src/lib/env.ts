import { z } from "zod";

// Validated lazily (not at module load) so `next build` doesn't require
// every secret to exist — each route pulls only the keys it needs.

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  // Since Jan 1, 2026 Shopify no longer issues a static Admin API token
  // from the admin for apps created in the Dev Dashboard — these two
  // are the OAuth client credentials this app exchanges for a token
  // itself (see src/lib/platforms/shopify.ts), replacing the old
  // SHOPIFY_ADMIN_API_ACCESS_TOKEN.
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
  // The store's canonical {handle}.myshopify.com domain — OAuth always
  // operates against this, not the custom domain in SHOPIFY_SHOP_DOMAIN.
  SHOPIFY_MYSHOPIFY_DOMAIN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  ADMIN_EMAIL: z.string().min(1),
  SHOPIFY_BLOG_HANDLE: z.string().min(1),
  APP_BASE_URL: z.string().min(1),
  PINTEREST_APP_ID: z.string().min(1),
  PINTEREST_APP_SECRET: z.string().min(1),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
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
