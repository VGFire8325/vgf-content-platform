# VGF Content Distribution Platform

Turns Very Good Fireplaces' Shopify blog articles into reviewed,
platform-specific posts for Pinterest, Facebook, and Instagram (LinkedIn
copy is generated but published manually — see plan for why).

Full architecture, schema rationale, retry/cost/security decisions:
[`docs/PHASE_0_PLAN.md`](./docs/PHASE_0_PLAN.md).

## Status

Phase 1, milestones 1–2 done:

1. Schema in place (all 11 tables from the plan, migration generated and verified).
2. Shopify ingestion + extraction pipeline: webhook receiver (`/api/webhooks/shopify/articles`), content-hash dedup, job queue (`jobs` table with `SKIP LOCKED` claiming), a Vercel Cron runner (`/api/cron/run-jobs`) implementing the §5 retry/backoff policy, and the `extract_article` job (Claude call → structured extraction → `article_extractions`). Covered by unit tests (`npm test`) for HMAC verification, content hashing, and the extraction schema.

Not yet built: per-platform content generation, the image compositor,
the review UI, and the platform publishers.

Verified locally without live credentials: `npm run typecheck`,
`npx next build`, and `npm test` all pass. Nothing has been run against
a real database or the live Anthropic API yet — that needs the Supabase
project and Anthropic key from "What Brendan Must Do".

## Stack

Next.js (App Router) + Drizzle ORM + Supabase Postgres, per §3 of the plan.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real values — see below
npm run db:push              # applies the schema to your Supabase Postgres
npm run dev
```

### What has to exist before this runs against real data

These are the vendor accounts and platform-side setup only Brendan can
do (§7 / "What Brendan Must Do" in the plan) — none of it can be created
via API from this session:

- A Supabase project (for `DATABASE_URL` / `SUPABASE_*`).
- A Vercel project (Pro plan, for cron + hosting).
- A **Shopify custom app**, created in the Shopify admin under
  Settings → Apps and sales channels → Develop apps, with `read_content`
  scope, for `SHOPIFY_ADMIN_API_ACCESS_TOKEN` and
  `SHOPIFY_WEBHOOK_SECRET`. Shopify does not expose an API to create a
  new app with its own credentials — this step requires a few minutes
  in the admin UI regardless of what access this project already has.
- Pinterest and Meta developer apps (§8 of the plan covers what each
  requires and current approval friction).
- An Anthropic API key.
- Once deployed, a webhook subscription pointing at
  `https://<your-deployment>/api/webhooks/shopify/articles` for the
  `articles/create` and `articles/update` topics (Shopify admin →
  Settings → Notifications → Webhooks, or via `webhookSubscriptionCreate`
  once a real endpoint exists to point at).

The read-only Shopify access already available to this session (via the
Shopify MCP connector) was used to confirm the store's blog structure
and available API scopes while building this milestone, but it's a
session-scoped connector credential, not a substitute for the app's own
production Shopify access token above.
