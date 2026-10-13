-- Automatic supplier order emails (src/lib/orders/supplier-email.ts).
-- Additive only, and every statement is guarded so a re-run is a no-op.
--   - supplier_emails: one row per (order, supplier) email; the unique index
--     is the atomic claim that prevents a second send, and the table is the
--     log of what was sent (to, subject, Resend message id, time).
--   - orders.auto_supplier_email: true only for orders stored by the new
--     code. Every existing order gets false, so nothing already in the table
--     is ever auto-emailed.
--   - suppliers.active / ordered_before: Evolution Fires is no longer a
--     supplier; Litedeer has never been ordered from.
-- No order_status value is added: the existing 'sent' already means "sent
-- to every supplier".
CREATE TABLE IF NOT EXISTS "supplier_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"supplier_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"supplier_address" text NOT NULL,
	"to_addresses" text[],
	"subject" text NOT NULL,
	"resend_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "supplier_emails_mode_check" CHECK ("supplier_emails"."mode" in ('test', 'live')),
	CONSTRAINT "supplier_emails_status_check" CHECK ("supplier_emails"."status" in ('sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "auto_supplier_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "ordered_before" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_emails" ADD CONSTRAINT "supplier_emails_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_emails" ADD CONSTRAINT "supplier_emails_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_emails_order_supplier_unique" ON "supplier_emails" USING btree ("order_id","supplier_id");--> statement-breakpoint
-- Same lockdown as 0002/0007: no anon/authenticated API access.
ALTER TABLE "supplier_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "suppliers" SET "active" = false WHERE "id" = 'evolution_fires';--> statement-breakpoint
UPDATE "suppliers" SET "ordered_before" = false WHERE "id" = 'litedeer' AND NOT EXISTS (SELECT 1 FROM "supplier_emails" WHERE "supplier_id" = 'litedeer' AND "mode" = 'live' AND "status" = 'sent');
