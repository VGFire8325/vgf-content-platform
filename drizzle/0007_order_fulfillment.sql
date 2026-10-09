CREATE TYPE "public"."order_status" AS ENUM('new', 'draft_ready', 'sent', 'confirmed', 'shipped', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."supplier_method" AS ENUM('email', 'portal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sku" text,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"vendor" text,
	"supplier_id" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_order_id" text NOT NULL,
	"order_number" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"customer_name" text NOT NULL,
	"ship_company" text,
	"ship_address1" text,
	"ship_address2" text,
	"ship_city" text,
	"ship_province" text,
	"ship_zip" text,
	"ship_country" text,
	"phone" text,
	"email" text,
	"supplier_id" text,
	"status" "order_status" DEFAULT 'new' NOT NULL,
	"freight_separate" boolean DEFAULT false NOT NULL,
	"freight_note" text,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"tracking_number" text,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_shopify_order_id_unique" UNIQUE("shopify_order_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"order_email" text,
	"method" "supplier_method" DEFAULT 'email' NOT NULL,
	"vendor_names" text[] DEFAULT '{}' NOT NULL,
	"greeting" text DEFAULT 'Hello,' NOT NULL,
	"draft_instructions" text,
	"notes" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alerts_open_key_unique" ON "alerts" USING btree ("key") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
-- Same lockdown as 0002: no anon/authenticated API access to these
-- tables (they hold customer names/addresses). All access is via Drizzle
-- over DATABASE_URL, which bypasses RLS.
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Supplier seed, confirmed by Brendan 2026-10-09. Mirrors SUPPLIER_SEED in
-- src/lib/orders/suppliers.ts (a unit test checks the two agree).
-- vendor_names are the Shopify product `vendor` values seen in the store.
INSERT INTO "suppliers" ("id", "name", "order_email", "method", "vendor_names", "greeting", "draft_instructions", "notes") VALUES
('sustainable_hearth', 'Sustainable Hearth', 'inside.sales@sustainablehearth.com', 'email', ARRAY['Sustainable Hearth', 'European Home'], 'Hi Holly,', 'Please ship to the address below. Include shipping on the invoice.', 'Formerly European Home. Contact: Holly. Wants shipping on the invoice. Do NOT use orders@europeanhome.com.'),
('modern_flames', 'Modern Flames', 'orders@modernflames.com', 'email', ARRAY['Modern Flames'], 'Hello,', NULL, 'Freight is quoted separately and needs Brendan''s approval.'),
('dynasty', 'Dynasty', 'info@dynastyfireplace.com', 'email', ARRAY['Dynasty Fireplaces', 'Dynasty'], 'Hello,', NULL, NULL),
('amantii_remii', 'Amantii and Remii', 'usaorders@cannedheat.com', 'email', ARRAY['Amantii', 'Remii'], 'Hello,', NULL, NULL),
('dimplex', 'Dimplex', 'msanders@tsdsupply.com', 'email', ARRAY['Dimplex'], 'Hello,', NULL, 'Ordered through TSD Supply.'),
('litedeer', 'Litedeer', 'litedeerhomes@gmail.com', 'email', ARRAY['Litedeer', 'Litedeer Homes'], 'Hello,', NULL, 'Never ordered from before: the first order is the test of this address.'),
('evolution_fires', 'Evolution Fires', 'sales@evolutionfires.com', 'email', ARRAY['Evolution Fires'], 'Hello,', NULL, 'sales@evolutionfires.com is probably out of date. Confirm the address before sending.'),
('touchstone', 'Touchstone', NULL, 'portal', ARRAY['Touchstone'], 'Hello,', NULL, 'Orders are placed in the Touchstone dealer portal, not by email.')
ON CONFLICT ("id") DO NOTHING;
