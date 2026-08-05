# VGF Content Distribution Platform

Turns Very Good Fireplaces' Shopify blog articles into reviewed,
platform-specific posts for Pinterest, Facebook, and Instagram (LinkedIn
copy is generated but published manually — see plan for why).

Full architecture, schema rationale, retry/cost/security decisions:
[`docs/PHASE_0_PLAN.md`](./docs/PHASE_0_PLAN.md).

## Status

Phase 1, milestones 1–5 done:

1. Schema in place (all 11 tables from the plan, migration generated and verified).
2. Shopify ingestion + extraction pipeline: webhook receiver (`/api/webhooks/shopify/articles`), content-hash dedup, job queue (`jobs` table with `SKIP LOCKED` claiming), a Vercel Cron runner (`/api/cron/run-jobs`) implementing the §5 retry/backoff policy, and the `extract_article` job (Claude call → structured extraction → `article_extractions`).
3. Per-platform content generation (`generate_content` job) for all four platforms, plus the discrete claim-grounding pass from §3 that flags any generated claim not backed by the article.
4. Review Queue UI (`/review`) and server actions: approve / approve-all / reject, inline copy edit, free-text instruction box, and per-field "regenerate" buttons — all going through the same in-place-edit rule from §4 (editing an approved/scheduled item reverts it to `in_review` and cancels its pending publish).
5. Image compositor: two fixed Pinterest pin templates (`src/lib/templates/pinterest.tsx`) rendered server-side with Satori → resvg (`src/lib/render.ts`), a `render_image` job wired to run automatically after Pinterest copy generation, tag-based approved-image selection (`src/lib/assets.ts`) that explicitly refuses to guess — no tag overlap means the item is flagged `needs_asset` in the Review Queue rather than silently picking an unrelated photo or falling back to an AI-generated visual. A "regenerate image" button in the review UI cycles between the two templates.

Not yet built: the platform publishers (Pinterest/Meta API clients,
OAuth, scheduling/publishing).

Verified two ways:
- No live credentials needed: `npm run typecheck`, `npx next build`, and `npm test` (27 unit tests) all pass.
- **Against a real local Postgres** (`scripts/integration-check.ts` — see below): this caught and fixed a real bug where the job-claiming query returned raw SQL column names (`job_type`) instead of the camelCase the rest of the code expected (`jobType`), which would have made every job retry/failure silently crash in production. It also confirmed the Shopify webhook dedup logic, the cron auth check, the approve → edit → auto-revert-to-in_review → cancel-pending-publish chain, and both `render_image` paths (empty library → `needs_asset`, matching asset → a real Satori/resvg render that only stops at the Supabase Storage upload, which needs credentials this environment doesn't have).
- **Rendering itself** (`scripts/render-sample.ts`, no DB needed): produces real PNGs from both templates against a synthetic test photo, verified by magic bytes/size and by actually looking at the output — caught a real bug (`ReferenceError: React is not defined` when run outside Next's own JSX runtime) and a webpack build failure (`@resvg/resvg-js`'s native `.node` binary can't be bundled — fixed via `serverExternalPackages` in `next.config.mjs`).

Nothing has been run against the live Anthropic API with a real key, or
against real Supabase Storage (tested against a local Postgres and a
synthetic in-memory test photo instead) — those need the accounts from
"What Brendan Must Do".

### Re-running the integration check

```bash
# once, in any environment with apt/postgres available:
apt-get install -y postgresql && service postgresql start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su postgres -c "createdb vgf_test"

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" npx drizzle-kit push

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" \
SHOPIFY_WEBHOOK_SECRET="test-secret" CRON_SECRET="test-cron-secret" \
SHOPIFY_SHOP_DOMAIN="verygoodfireplaces.com" SHOPIFY_ADMIN_API_ACCESS_TOKEN="unused" \
ANTHROPIC_API_KEY="<real-or-invalid-key>" \
npx tsx scripts/integration-check.ts
```

A real `ANTHROPIC_API_KEY` will additionally exercise `extract_article`
end to end; an invalid one still verifies everything except the actual
model call (it'll fail with a clean 401, not a crash).

To check the image templates without any of the above:
`npx tsx scripts/render-sample.ts` — no DB, no credentials, writes two
sample PNGs (one per template) so you can look at them directly.

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
- A public Supabase Storage bucket named `content-assets` (created once
  in the Supabase dashboard) for rendered pin images.
- Approved product/lifestyle photos uploaded into `asset_library`,
  tagged so they overlap the tags on the articles they should illustrate
  — without at least one tag match, `render_image` intentionally leaves
  a pin flagged `needs_asset` instead of guessing.
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
