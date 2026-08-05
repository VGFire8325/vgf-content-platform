# VGF Content Distribution Platform

Turns Very Good Fireplaces' Shopify blog articles into reviewed,
platform-specific posts for Pinterest, Facebook, and Instagram (LinkedIn
copy is generated but published manually — see plan for why).

Full architecture, schema rationale, retry/cost/security decisions:
[`docs/PHASE_0_PLAN.md`](./docs/PHASE_0_PLAN.md).

## Status

Phase 1, milestones 1–6 done — Pinterest is publish-capable end to end,
and Facebook rides the same Meta connection:

1. Schema in place (all 11 tables from the plan, migration generated and verified).
2. Shopify ingestion + extraction pipeline: webhook receiver (`/api/webhooks/shopify/articles`), content-hash dedup, job queue (`jobs` table with `SKIP LOCKED` claiming), a Vercel Cron runner (`/api/cron/run-jobs`) implementing the §5 retry/backoff policy, and the `extract_article` job (Claude call → structured extraction → `article_extractions`).
3. Per-platform content generation (`generate_content` job) for all four platforms, plus the discrete claim-grounding pass from §3 that flags any generated claim not backed by the article.
4. Review Queue UI (`/review`) and server actions: approve / approve-all / reject, inline copy edit, free-text instruction box, and per-field "regenerate" buttons — all going through the same in-place-edit rule from §4 (editing an approved/scheduled item reverts it to `in_review` and cancels its pending publish).
5. Image compositor: two fixed Pinterest pin templates (`src/lib/templates/pinterest.tsx`) rendered server-side with Satori → resvg (`src/lib/render.ts`), a `render_image` job wired to run automatically after Pinterest copy generation, tag-based approved-image selection (`src/lib/assets.ts`) that explicitly refuses to guess — no tag overlap means the item is flagged `needs_asset` rather than silently picking an unrelated photo or falling back to an AI-generated visual.
6. **Publishing**: OAuth connect flows for Pinterest (`/api/oauth/pinterest/*`) and Meta (`/api/oauth/meta/*`, one flow produces both the `facebook` and `instagram` connections since they share a Page token — Instagram's actual publish handler still needs its own image template first), token storage via Supabase Vault (`src/lib/vault.ts`, per §3's decision), Pinterest and Facebook API clients (`src/lib/platforms/`), fixed-schedule spacing (`src/lib/scheduling.ts` — Pinterest capped at 2/day spread 6h apart, Facebook ~weekly, both "boring by design" per §1/§4), and the `publish_post` job implementing §5's retry + one-shot auth-renewal policy exactly: one refresh attempt, one retry with the new token, and on failure the connection is marked `expired` and every other pending publish for that platform is paused rather than left to fail one at a time. Approving a Pinterest or Facebook item now auto-schedules it if that platform is connected; otherwise it stays `approved` until Brendan connects it.

Not yet built: Instagram's actual publish handler (needs its own image
template — carousels need real slide images, which don't exist yet),
and the Connections/Policy screen (right now connecting is a plain link
on the home page, and there's no UI for the per-platform Manual/
Trusted/Autonomous toggle from `brand_policies` — the table exists, the
screen doesn't).

Verified in four tiers, in order of how real they are:
- No live credentials needed: `npm run typecheck`, `npx next build`, and `npm test` (34 unit tests) all pass.
- **Against a real local Postgres** (`scripts/integration-check.ts`): confirmed the Shopify webhook dedup logic, the cron auth check, the approve → auto-schedule → edit → cancel-pending-publish chain (including that a canceled target's already-enqueued job no-ops cleanly instead of trying to publish), and both `render_image` paths end to end. This caught a real bug earlier (raw-SQL snake_case vs. camelCase in `claimDueJobs`) and this round confirmed the *new* scheduling logic picks the exact right slot (`2026-08-06T14:00:00Z` for the first Pinterest pin approved with nothing else scheduled — matches the spacing rule precisely).
- **Rendering itself** (`scripts/render-sample.ts`, no DB): produces real PNGs from both templates, verified by magic bytes/size and by looking at the output — caught a `ReferenceError: React is not defined` outside Next's JSX runtime and a webpack build failure on `@resvg/resvg-js`'s native binary (fixed via `serverExternalPackages`).
- **What could not be verified here, and why**: the outbound proxy in this environment explicitly blocks `api.pinterest.com` and `graph.facebook.com` by policy (confirmed via the proxy's own status endpoint, not assumed), so the actual Pinterest/Meta HTTP calls were never made — the clients are built against each platform's stable, documented contract and the error-classification logic (`src/lib/platforms/errors.ts` — notably that Meta returns auth errors as HTTP 400, not 401) is unit-tested against realistic fixtures instead of a live response. Supabase Vault is a Supabase-platform extension unavailable in a plain local Postgres, so `src/lib/vault.ts` is typecheck-verified only. Both need Brendan's real Pinterest/Meta apps and Supabase project to exercise for real — flagging this plainly rather than overstating what a green test suite proves here.

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
  requires and current approval friction), each with their OAuth redirect
  URI registered as `${APP_BASE_URL}/api/oauth/pinterest/callback` and
  `${APP_BASE_URL}/api/oauth/meta/callback` respectively — then connect
  from the home page (`/`) once the app is deployed and those env vars
  are set.
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
