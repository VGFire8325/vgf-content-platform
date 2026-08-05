// One-off script to register the articles/create and articles/update
// webhook subscriptions this app's ingestion pipeline needs.
//
// Why this exists instead of shopify.app.toml or the admin UI: the
// WebhookSubscriptionTopic GraphQL enum (what config-as-code and the
// App Management API validate against) has no ARTICLES_*/BLOGS_* topic
// at all, and the Shopify admin's Notifications → Webhooks dropdown no
// longer offers "Article creation"/"Article update" either — see
// README.md "What has to exist before this runs against real data".
// The classic REST Admin API still accepts these topics for webhook
// creation as of API version 2026-04; this script calls that endpoint
// directly using the Admin API token this app already has in Vault
// from connecting via /api/oauth/shopify/start.
//
// Not part of the app — run once (safe to re-run; Shopify rejects a
// duplicate topic+address pair as a no-op, not an error) after
// deploying and connecting Shopify:
//   DATABASE_URL=... APP_BASE_URL=https://vgf-content-platform.vercel.app \
//     npx tsx scripts/register-shopify-webhooks.ts
import { db } from "../src/db/client";
import { shopifyConnection } from "../src/db/schema";
import { readSecret } from "../src/lib/vault";

const API_VERSION = "2026-04"; // matches [webhooks].api_version in shopify.app.toml
const TOPICS = ["articles/create", "articles/update"] as const;

interface WebhookCreateResponse {
  webhook?: { id: number; topic: string; address: string };
  errors?: unknown;
}

async function createWebhook(shopDomain: string, accessToken: string, topic: string, address: string) {
  const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/webhooks.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
  });
  const json = (await response.json().catch(() => null)) as WebhookCreateResponse | null;

  if (response.ok && json?.webhook) {
    console.log(`  ✓ ${topic} -> webhook id ${json.webhook.id}`);
    return;
  }

  // "Address for this topic has already been taken" is Shopify's shape
  // for "this exact subscription already exists" — a no-op, not a
  // failure, so re-running this script after the first success is safe.
  const errorText = JSON.stringify(json?.errors ?? json);
  if (response.status === 422 && errorText.toLowerCase().includes("already been taken")) {
    console.log(`  = ${topic} already registered, skipping`);
    return;
  }

  throw new Error(`Failed to create webhook for ${topic}: HTTP ${response.status} ${errorText}`);
}

async function main() {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    throw new Error("APP_BASE_URL is required (e.g. https://vgf-content-platform.vercel.app)");
  }
  const address = `${appBaseUrl}/api/webhooks/shopify/articles`;

  const [connection] = await db.select().from(shopifyConnection).limit(1);
  if (!connection) {
    throw new Error(
      "No shopify_connection row found — connect Shopify first via /api/oauth/shopify/start, then re-run this script.",
    );
  }

  const accessToken = await readSecret(db, connection.accessTokenVaultId);

  console.log(`Registering webhooks on ${connection.shopDomain} -> ${address}`);
  for (const topic of TOPICS) {
    await createWebhook(connection.shopDomain, accessToken, topic, address);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
