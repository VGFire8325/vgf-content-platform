// Finds Shopify images that aren't in asset_library yet, adds them, and
// lists every image still waiting for visual tagging (setting, room, …)
// so a person or agent can tag just those. Run by hand after adding new
// products — deliberately not a cron job. See README "Adding or tagging
// images after new products".
//
//   DATABASE_URL=... npm run images:sync               # add new images + list untagged
//   DATABASE_URL=... npm run images:sync -- --dry-run  # report only, write nothing
//
// Scope: every image of every active, in-stock fireplace product (not just
// the featured one), collection images, blog article images (featured and
// inline), and Shopify Files that look like site photography. Never
// deletes or rewrites existing rows; never writes to Shopify.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client";
import { assetLibrary, shopifyConnection } from "../src/db/schema";
import { collectCandidates, numericShopifyId, planSync, type CollectInput, type ShopifyImage } from "../src/lib/image-sync";
import { readSecret } from "../src/lib/vault";

const API_VERSION = "2026-04"; // matches [webhooks].api_version in shopify.app.toml
const REQUIRED_SCOPES = ["read_products", "read_files", "read_content"];
const INSERT_CHUNK = 200;

type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

function graphqlClient(shopDomain: string, accessToken: string): Gql {
  return async (query, variables) => {
    const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await response.json().catch(() => null)) as { data?: unknown; errors?: unknown } | null;
    if (!response.ok || !json || json.errors) {
      throw new Error(`Shopify GraphQL error (HTTP ${response.status}): ${JSON.stringify(json?.errors ?? json)}`);
    }
    return json.data as never;
  };
}

type Page<N> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: N[] };

async function fetchAll<N>(gql: Gql, query: string, root: string): Promise<N[]> {
  const nodes: N[] = [];
  let after: string | null = null;
  do {
    const data: Record<string, Page<N>> = await gql(query, { after });
    const page: Page<N> = data[root]!;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const IMAGE_FIELDS = "id url width height";

type MediaNode = { image?: ShopifyImage };

async function loadShopify(gql: Gql): Promise<CollectInput> {
  const products = await fetchAll<{
    id: string;
    title: string;
    vendor: string;
    productType: string;
    media: { nodes: MediaNode[] };
  }>(
    gql,
    `query($after: String) { products(first: 50, after: $after, query: "status:active AND inventory_total:>0", sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { id title vendor productType media(first: 100) { nodes { ... on MediaImage { image { ${IMAGE_FIELDS} } } } } } } }`,
    "products",
  );
  const allProducts = await fetchAll<{ media: { nodes: { id: string }[] } }>(
    gql,
    `query($after: String) { products(first: 250, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor } nodes { media(first: 100) { nodes { id } } } } }`,
    "products",
  );
  const collections = await fetchAll<{ title: string; image: ShopifyImage | null }>(
    gql,
    `query($after: String) { collections(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor } nodes { title image { ${IMAGE_FIELDS} } } } }`,
    "collections",
  );
  const articles = await fetchAll<{ title: string; isPublished: boolean; image: ShopifyImage | null; body: string | null }>(
    gql,
    `query($after: String) { articles(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor } nodes { title isPublished body image { ${IMAGE_FIELDS} } } } }`,
    "articles",
  );
  const files = await fetchAll<{ alt: string | null; image?: ShopifyImage }>(
    gql,
    `query($after: String) { files(first: 250, after: $after, query: "media_type:IMAGE") {
      pageInfo { hasNextPage endCursor } nodes { alt ... on MediaImage { image { ${IMAGE_FIELDS} } } } } }`,
    "files",
  );

  return {
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      productType: p.productType,
      images: p.media.nodes.flatMap((m) => (m.image ? [m.image] : [])),
    })),
    collections,
    articles,
    files: files.map((f) => ({ alt: f.alt, image: f.image ?? null })),
    productAttachedImageIds: new Set(
      allProducts.flatMap((p) => p.media.nodes.map((m) => numericShopifyId(m.id)).filter((id): id is string => id !== null)),
    ),
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const [connection] = await db.select().from(shopifyConnection).limit(1);
  if (!connection) {
    throw new Error("No shopify_connection row found — connect Shopify first via /api/oauth/shopify/start.");
  }
  const gql = graphqlClient(connection.shopDomain, await readSecret(db, connection.accessTokenVaultId));

  const { currentAppInstallation } = await gql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(
    "{ currentAppInstallation { accessScopes { handle } } }",
  );
  const granted = new Set(currentAppInstallation.accessScopes.map((s) => s.handle));
  const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new Error(
      `The Shopify app token is missing scope(s): ${missing.join(", ")}. Add them to [access_scopes] in shopify.app.toml ` +
        `(and SHOPIFY_SCOPES in src/lib/platforms/shopify.ts), run \`shopify app deploy\`, then reconnect via ` +
        `/api/oauth/shopify/start so the stored token carries them.`,
    );
  }

  const candidates = collectCandidates(await loadShopify(gql));
  const existing = await db
    .select({ id: assetLibrary.id, fileUrl: assetLibrary.fileUrl, shopifyImageId: assetLibrary.shopifyImageId })
    .from(assetLibrary);
  const plan = planSync(existing, candidates);
  console.log(
    `Shopify images in scope: ${candidates.length}. Already in asset_library: ${candidates.length - plan.toInsert.length}. ` +
      `New: ${plan.toInsert.length}. Existing rows to backfill with a Shopify image id: ${plan.toBackfill.length}.`,
  );

  if (!dryRun) {
    for (let i = 0; i < plan.toInsert.length; i += INSERT_CHUNK) {
      await db
        .insert(assetLibrary)
        .values(
          plan.toInsert.slice(i, i + INSERT_CHUNK).map((c) => ({
            fileUrl: c.fileUrl,
            source: "shopify_product" as const,
            shopifyProductId: c.shopifyProductId,
            shopifyImageId: c.shopifyImageId,
            widthPx: c.widthPx,
            heightPx: c.heightPx,
            notes: c.notes,
          })),
        )
        .onConflictDoNothing();
    }
    for (const b of plan.toBackfill) {
      await db
        .update(assetLibrary)
        .set({ shopifyImageId: b.shopifyImageId, widthPx: b.widthPx, heightPx: b.heightPx })
        .where(eq(assetLibrary.id, b.assetId));
    }
  }

  const untagged = await db
    .select({ id: assetLibrary.id, fileUrl: assetLibrary.fileUrl, notes: assetLibrary.notes })
    .from(assetLibrary)
    .where(isNull(assetLibrary.taggedAt))
    .orderBy(asc(assetLibrary.uploadedAt));
  const queuePath = join(tmpdir(), "vgf-image-tagging-queue.json");
  writeFileSync(queuePath, JSON.stringify(untagged, null, 2));
  console.log(`\n${untagged.length} image(s) still need tagging${dryRun ? " (dry run: nothing was written)" : ""}.`);
  for (const row of untagged.slice(0, 50)) console.log(`  ${row.id}  ${row.fileUrl}`);
  if (untagged.length > 50) console.log(`  … and ${untagged.length - 50} more`);
  console.log(`Full list: ${queuePath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
