import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums — see docs/PHASE_0_PLAN.md §4 for the schema this implements.

export const platformEnum = pgEnum("platform", [
  "pinterest",
  "linkedin",
  "facebook",
  "instagram",
]);

export const contentTypeEnum = pgEnum("content_type", [
  "pinterest_pin",
  "linkedin_post",
  "fb_post",
  "ig_carousel",
]);

export const contentItemStatusEnum = pgEnum("content_item_status", [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "failed",
]);

export const assetSourceTypeEnum = pgEnum("asset_source_type", [
  "asset_library",
  "rendered_template",
]);

export const librarySourceEnum = pgEnum("library_source", [
  "shopify_product",
  "manual_upload",
]);

export const publishTargetStatusEnum = pgEnum("publish_target_status", [
  "scheduled",
  "publishing",
  "published",
  "failed_retrying",
  "failed",
  "canceled",
]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "connected",
  "expired",
  "revoked",
]);

export const policyModeEnum = pgEnum("policy_mode", [
  "manual",
  "trusted",
  "autonomous",
]);

export const editFieldTargetEnum = pgEnum("edit_field_target", [
  "copy",
  "image",
  "headline",
  "layout",
  "all",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "extract_article",
  "generate_content",
  "render_image",
  "publish_post",
  "refresh_token",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_final",
]);

// Tables

export const articles = pgTable("articles", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopifyArticleId: text("shopify_article_id").notNull().unique(),
  shopifyBlogId: text("shopify_blog_id").notNull(),
  title: text("title").notNull(),
  handle: text("handle").notNull(),
  bodyHtml: text("body_html").notNull(),
  tags: text("tags").array().notNull().default([]),
  shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }).notNull(),
  // Null means unpublished/draft; a future timestamp means scheduled but
  // not live yet. See isArticleLive/decideSyncAction in
  // src/lib/platforms/shopify-articles.ts — this is what lets the sync
  // treat a publish-date change as its own trigger, independent of
  // whether the article body itself changed.
  shopifyPublishedAt: timestamp("shopify_published_at", { withTimezone: true }),
  contentHash: text("content_hash").notNull(),
  status: text("status").notNull().default("new"), // new | processing | processed | error
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const articleExtractions = pgTable("article_extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  coreSubject: text("core_subject").notNull(),
  audience: text("audience").notNull(),
  searchIntent: text("search_intent").notNull(),
  keyTakeaways: jsonb("key_takeaways").notNull(), // string[]
  supportedClaims: jsonb("supported_claims").notNull(), // string[] — grounds the claim-grounding pass
  modelUsed: text("model_used").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformConnections = pgTable("platform_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: platformEnum("platform").notNull(),
  externalAccountId: text("external_account_id").notNull(),
  displayName: text("display_name").notNull(),
  // Vault secret references, not raw tokens — see docs/PHASE_0_PLAN.md §3
  // "Decision: Supabase Vault for OAuth tokens". These columns hold the
  // vault.secrets id, never plaintext.
  accessTokenVaultId: uuid("access_token_vault_id").notNull(),
  refreshTokenVaultId: uuid("refresh_token_vault_id"),
  scopes: text("scopes").array().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: connectionStatusEnum("status").notNull().default("connected"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contentItems = pgTable("content_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  platform: platformEnum("platform").notNull(),
  contentType: contentTypeEnum("content_type").notNull(),
  copyFields: jsonb("copy_fields").notNull(), // { title?, description?, caption?, altText?, ... }
  status: contentItemStatusEnum("status").notNull().default("draft"),
  // Null = the normal ongoing pipeline. Set for a one-off content
  // campaign (e.g. the evergreen-backlog "blitz") so it can run its own
  // independent posting cadence — see nextLinkedInDailySlot in
  // src/lib/scheduling.ts — without distorting the normal pipeline's
  // slot math for new-article approvals happening at the same time.
  campaign: text("campaign"),
  // Audience/content-type tags (Spec 4, one-month test, 2026-10) —
  // inferred from the source article at generation time (see
  // inferAudienceTag/inferTopicTag in src/lib/tagging.ts), editable by a
  // reviewer in the Review Queue. "homeowner" | "trade" and
  // "how_to" | "comparison" | "buying_guide" | "trade" respectively —
  // plain text, not an enum, so a wrong early guess at the value set
  // doesn't need a migration to fix (same precedent as articles.status).
  audienceTag: text("audience_tag"),
  topicTag: text("topic_tag"),
  // Advisory-only platform-fit label from the audience/topic routing
  // preference (see platformFitForArticle in src/lib/tagging.ts) — null
  // when AUDIENCE_PLATFORM_PREFERENCE_ENABLED is off. Never gates
  // generation; purely informational for the reviewer.
  platformFit: text("platform_fit"),
  // Non-blocking reasons this item was flagged for a human to check
  // before approving (Pinterest quality-gate misses, a flagged
  // deliberate-repost distinctness violation, etc.) — same
  // "flag, don't silently drop or auto-fix" pattern as copyFields.
  // flaggedClaims, just not claim-specific, so it lives as its own
  // column rather than another copyFields key.
  qualityFlags: text("quality_flags").array().notNull().default([]),
  // Audit counter, NOT a re-review gate. Edits update this row in place
  // and increment version; they do not create a new row. See
  // docs/PHASE_0_PLAN.md §4 for the full in-place-edit rule, including
  // the one automatic transition (approved/scheduled -> in_review on edit).
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contentAssets = pgTable("content_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentItemId: uuid("content_item_id")
    .notNull()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  sourceType: assetSourceTypeEnum("source_type").notNull(),
  sourceAssetId: uuid("source_asset_id"), // references asset_library.id when sourceType = asset_library
  templateId: text("template_id"), // fixed template identifier when sourceType = rendered_template
  renderParams: jsonb("render_params"), // { textPlacement, font, layout, ... }
  fileUrl: text("file_url"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assetLibrary = pgTable("asset_library", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileUrl: text("file_url").notNull(),
  tags: text("tags").array().notNull().default([]),
  source: librarySourceEnum("source").notNull(),
  shopifyProductId: text("shopify_product_id"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
});

export const publishTargets = pgTable("publish_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentItemId: uuid("content_item_id")
    .notNull()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  platformConnectionId: uuid("platform_connection_id")
    .notNull()
    .references(() => platformConnections.id),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  externalPostId: text("external_post_id"),
  externalPostUrl: text("external_post_url"),
  // The actual outbound link used at publish time (article URL + UTM
  // params), and the UTM values themselves broken out for easy
  // querying/export — see Spec 5 (measurability). Null for platforms/
  // content types that don't carry a destination link (none currently;
  // kept nullable since not every historical row has this).
  destinationUrl: text("destination_url"),
  utm: jsonb("utm"), // { source, medium, campaign }
  status: publishTargetStatusEnum("status").notNull().default("scheduled"),
  errorMessage: text("error_message"),
  // Retry/backoff behavior driven by these two columns is defined in
  // docs/PHASE_0_PLAN.md §5 (Retry, failure, and auth-renewal policy).
  attemptCount: integer("attempt_count").notNull().default(0),
});

export const publishLog = pgTable("publish_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  publishTargetId: uuid("publish_target_id")
    .notNull()
    .references(() => publishTargets.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // scheduled | published | failed | retried | canceled
  detail: jsonb("detail"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const brandPolicies = pgTable("brand_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: platformEnum("platform").notNull(),
  contentType: contentTypeEnum("content_type").notNull(),
  mode: policyModeEnum("mode").notNull().default("manual"),
  autoPublishConditions: jsonb("auto_publish_conditions"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const editInstructions = pgTable("edit_instructions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentItemId: uuid("content_item_id")
    .notNull()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  instructionText: text("instruction_text").notNull(),
  fieldTarget: editFieldTargetEnum("field_target").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  resultSummary: text("result_summary"),
});

// Single-row-in-practice table for the store's own OAuth connection —
// distinct from platform_connections, which models publish-destination
// accounts (Pinterest/Meta/LinkedIn). Shopify changed how custom apps
// get their Admin API credentials on Jan 1, 2026: apps created in the
// new Dev Dashboard no longer receive a static token from the admin —
// this app must complete the authorization code grant itself and store
// the resulting token, same Vault pattern as platform_connections.
export const shopifyConnection = pgTable("shopify_connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopDomain: text("shop_domain").notNull(), // the {handle}.myshopify.com domain
  accessTokenVaultId: uuid("access_token_vault_id").notNull(),
  scope: text("scope").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single-row-per-key cursor store. Currently just one row
// ("shopify_articles"): when set, /api/cron/poll-shopify-articles only
// fetches articles Shopify reports as updated after this timestamp,
// instead of re-scanning the whole blog every day. Null means "no
// cutoff yet" (full backfill) — the state before any manual seed or
// first-ever poll has run.
export const syncCursors = pgTable("sync_cursors", {
  key: text("key").primaryKey(),
  cutoff: timestamp("cutoff", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobType: jobTypeEnum("job_type").notNull(),
  payload: jsonb("payload").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  status: jobStatusEnum("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Order fulfillment (drop-ship helper, 2026-10) ---
// Turns each paid Shopify order into a ready-to-send manufacturer email
// that Brendan reviews and sends himself — nothing here ever emails a
// manufacturer on its own. See src/lib/orders/ and app/review/orders.

export const supplierMethodEnum = pgEnum("supplier_method", ["email", "portal"]);

export const orderStatusEnum = pgEnum("order_status", [
  "new",
  "draft_ready",
  "sent",
  "confirmed",
  "shipped",
  "needs_attention",
]);

// One row per manufacturer/distributor Brendan places orders with.
// Slug primary key (e.g. "sustainable_hearth") rather than a uuid so the
// seed is deterministic and rows are readable in SQL.
export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Null for portal suppliers (Touchstone) — there's no address to email.
  orderEmail: text("order_email"),
  method: supplierMethodEnum("method").notNull().default("email"),
  // Shopify product `vendor` values that route to this supplier, matched
  // case-insensitively (see matchSupplier in src/lib/orders/suppliers.ts).
  vendorNames: text("vendor_names").array().notNull().default([]),
  // First line of the draft ("Hello," / "Hi Holly,").
  greeting: text("greeting").notNull().default("Hello,"),
  // Extra wording placed between the item list and "Shipping to:" — e.g.
  // Sustainable Hearth wants shipping included on the invoice.
  draftInstructions: text("draft_instructions"),
  notes: text("notes"),
});

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The webhook's idempotency key — Shopify retries deliveries, and a
  // retry must never create a second order or a second notification.
  shopifyOrderId: text("shopify_order_id").notNull().unique(),
  orderNumber: text("order_number").notNull(), // e.g. "1322" (no leading #)
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  customerName: text("customer_name").notNull(),
  shipCompany: text("ship_company"),
  shipAddress1: text("ship_address1"),
  shipAddress2: text("ship_address2"),
  shipCity: text("ship_city"),
  shipProvince: text("ship_province"), // state/province code, e.g. "TX"
  shipZip: text("ship_zip"),
  shipCountry: text("ship_country"),
  phone: text("phone"),
  email: text("email"),
  // The single supplier for this order; null when its items span more
  // than one supplier (one draft per supplier, see order_items.supplier_id)
  // or when a vendor didn't match any supplier.
  supplierId: text("supplier_id").references(() => suppliers.id),
  status: orderStatusEnum("status").notNull().default("new"),
  // Brendan's checkbox: adds "(1) Freight for shipping to zip code ..."
  // to the draft when freight is billed separately.
  freightSeparate: boolean("freight_separate").notNull().default(false),
  freightNote: text("freight_note"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  trackingNumber: text("tracking_number"),
  // The Shopify webhook body with payment fields stripped (see
  // sanitizeOrderPayload) — kept for debugging and for later agents.
  rawPayload: jsonb("raw_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  sku: text("sku"),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  vendor: text("vendor"),
  // Null = the vendor didn't match any supplier (order is needs_attention
  // until Brendan assigns one on the orders page).
  supplierId: text("supplier_id").references(() => suppliers.id),
  // Per-supplier "sent" — an order spanning two suppliers is two emails,
  // and the order only counts as sent once every item's draft has gone.
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// Shared alerting plumbing (meant for reuse by later agents): at most one
// OPEN row per key, enforced by the partial unique index below. Reopening
// after a resolve creates a new row, so history is preserved.
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    severity: text("severity").notNull(), // "info" | "warning" | "urgent"
    message: text("message").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("alerts_open_key_unique").on(table.key).where(sql`${table.resolvedAt} is null`)],
);
