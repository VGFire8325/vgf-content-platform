# VGF Content Distribution Platform

Turns Very Good Fireplaces' Shopify blog articles into reviewed,
platform-specific posts for Pinterest, Facebook, and Instagram (LinkedIn
copy is generated but published manually — see plan for why).

Full architecture, schema rationale, retry/cost/security decisions:
[`docs/PHASE_0_PLAN.md`](./docs/PHASE_0_PLAN.md).

## Status

Phase 1, milestones 1–8 done — Pinterest, Facebook, and Instagram are
all publish-capable end to end:

1. Schema in place (all 11 tables from the plan plus `shopify_connection`, migrations generated and verified).
2. Shopify ingestion + extraction pipeline: webhook receiver (`/api/webhooks/shopify/articles`), content-hash dedup, job queue (`jobs` table with `SKIP LOCKED` claiming), a Vercel Cron runner (`/api/cron/run-jobs`) implementing the §5 retry/backoff policy, and the `extract_article` job (Claude call → structured extraction → `article_extractions`). Shopify's own connection (`/api/oauth/shopify/*`) uses the OAuth authorization code grant, not a static token — Shopify stopped issuing those for Dev Dashboard apps on Jan 1, 2026.
3. Per-platform content generation (`generate_content` job) for all four platforms, plus the discrete claim-grounding pass from §3 that flags any generated claim not backed by the article.
4. Review Queue UI (`/review`) and server actions: approve / approve-all / reject, inline copy edit, free-text instruction box, and per-field "regenerate" buttons — all going through the same in-place-edit rule from §4 (editing an approved/scheduled item reverts it to `in_review` and cancels its pending publish).
5. Image compositor: two fixed Pinterest pin templates plus a square Instagram slide template (`src/lib/templates/`) rendered server-side with Satori → resvg (`src/lib/render.ts`), a `render_image` job wired to run automatically after Pinterest/Instagram copy generation, tag-based approved-image selection (`src/lib/assets.ts`) that explicitly refuses to guess — no tag overlap means the item is flagged `needs_asset` rather than silently picking an unrelated photo or falling back to an AI-generated visual.
6. **Publishing**: OAuth connect flows for Pinterest (`/api/oauth/pinterest/*`) and Meta (`/api/oauth/meta/*`, one flow produces both the `facebook` and `instagram` connections since they share a Page token), token storage via Supabase Vault (`src/lib/vault.ts`, per §3's decision), Pinterest/Facebook/Instagram API clients (`src/lib/platforms/`) — Instagram's is the full three-step Graph API container/publish flow for carousels — fixed-schedule spacing (`src/lib/scheduling.ts` — Pinterest capped at 2/day spread 6h apart, Facebook ~weekly, both "boring by design" per §1/§4), and the `publish_post` job implementing §5's retry + one-shot auth-renewal policy exactly: one refresh attempt, one retry with the new token, and on failure the connection is marked `expired` and every other pending publish for that platform is paused rather than left to fail one at a time. A `publish_target` still unpublished 24h past its scheduled time stops auto-retrying too, per the same section. Approving a Pinterest, Facebook, or Instagram item now auto-schedules it if that platform is connected; otherwise it stays `approved` until Brendan connects it.
7. **Auth**: Supabase magic-link sign-in (`/login`, `/auth/callback`), allow-listed to a single `ADMIN_EMAIL`, gating every route via `middleware.ts` except the two that authenticate themselves (Shopify's webhook HMAC, Vercel Cron's `CRON_SECRET`).

Not yet built: the Article detail, Asset Library (upload/tag UI), and
Publish Log screens, and the Connections/Policy screen (right now
connecting is a plain link on the home page, and there's no UI for the
per-platform Manual/Trusted/Autonomous toggle from `brand_policies` —
the table exists, the screen doesn't).

Verified in four tiers, in order of how real they are:
- No live credentials needed: `npm run typecheck`, `npx next build`, and `npm test` (55 unit tests) all pass.
- **Against a real local Postgres** (`scripts/integration-check.ts`): confirmed the Shopify webhook dedup logic, the cron auth check, the approve → auto-schedule → edit → cancel-pending-publish chain (including that a canceled target's already-enqueued job no-ops cleanly instead of trying to publish), and both `render_image` paths end to end. This caught a real bug earlier (raw-SQL snake_case vs. camelCase in `claimDueJobs`) and this round confirmed the *new* scheduling logic picks the exact right slot (`2026-08-06T14:00:00Z` for the first Pinterest pin approved with nothing else scheduled — matches the spacing rule precisely).
- **Rendering itself** (`scripts/render-sample.ts`, no DB): produces real PNGs from both templates, verified by magic bytes/size and by looking at the output — caught a `ReferenceError: React is not defined` outside Next's JSX runtime and a webpack build failure on `@resvg/resvg-js`'s native binary (fixed via `serverExternalPackages`).
- **What could not be verified here, and why**: the outbound proxy in this environment explicitly blocks `api.pinterest.com`, `graph.facebook.com`, and `*.myshopify.com` by policy (confirmed via the proxy's own status endpoint and a direct `curl`, not assumed), so none of the actual Pinterest/Meta/Shopify-OAuth HTTP calls were ever made — the clients are built against each platform's stable, documented contract, and the signature/HMAC verification logic (`src/lib/platforms/errors.ts`, `src/lib/platforms/shopify.ts`) is unit-tested against realistic fixtures instead of a live response. Supabase Vault is a Supabase-platform extension unavailable in a plain local Postgres, so `src/lib/vault.ts` is typecheck-verified only. Supabase Auth (magic-link) likewise needs a real Supabase project — `middleware.ts` and the login/callback routes are typecheck- and build-verified only. All of the above need Brendan's real Pinterest/Meta/Shopify apps and Supabase project to exercise for real — flagging this plainly rather than overstating what a green test suite proves here.

### Re-running the integration check

```bash
# once, in any environment with apt/postgres available:
apt-get install -y postgresql && service postgresql start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su postgres -c "createdb vgf_test"

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" npx drizzle-kit push

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" \
SHOPIFY_WEBHOOK_SECRET="test-secret" CRON_SECRET="test-cron-secret" \
SHOPIFY_SHOP_DOMAIN="verygoodfireplaces.com" \
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
- A **Shopify custom app**, created in the [Dev Dashboard](https://dev.shopify.com/dashboard)
  (not the old Settings → Apps → Develop apps flow — Shopify stopped
  issuing a static Admin API token from the admin for new apps as of
  Jan 1, 2026). Note the app's Client ID/Secret for `SHOPIFY_CLIENT_ID` /
  `SHOPIFY_CLIENT_SECRET`. `SHOPIFY_MYSHOPIFY_DOMAIN` is the store's real
  `*.myshopify.com` admin domain (not the custom domain), and
  `SHOPIFY_WEBHOOK_SECRET` is set separately, same as before. This app
  runs the standard OAuth authorization code grant itself to get its
  token (`/api/oauth/shopify/start` on the home page) — the simpler
  client_credentials grant doesn't work here, since it's restricted to
  dev stores / stores in the app's own Shopify Organization and fails
  with `shop_not_permitted` against a real paid store. Shopify does not
  expose an API to create a new app with its own credentials — this
  step requires a few minutes in the Dev Dashboard regardless of what
  access this project already has.

  App config (Admin API scope, application URL, OAuth redirect URL) is
  declared as code in [`shopify.app.toml`](./shopify.app.toml) rather
  than clicked through the dashboard, so it stays in the same repo and
  under version control. `client_id` is filled in with the app's real
  value already:
  ```bash
  shopify auth login
  shopify app deploy
  ```
  This requires an interactive browser login to the Partner/Dev
  Dashboard account that owns the app, and a real Node/Shopify CLI
  install — this environment's outbound network is blocked from
  reaching `accounts.shopify.com` entirely (confirmed directly, same
  restriction as the platform hosts below), so both `auth login` and
  `app deploy` have to run from a real machine, not this session. Since
  Shopify validates and creates an app version atomically, a bad field
  anywhere in the file (an earlier draft of this one had an invalid
  webhook topic — see below) fails the whole deploy, not just that
  piece — re-run `shopify app deploy` after any `shopify.app.toml`
  change until it succeeds cleanly.

  **Not covered by `shopify.app.toml`**: the `articles/create` /
  `articles/update` webhook subscription this app's ingestion pipeline
  needs. The `WebhookSubscriptionTopic` GraphQL enum that config-as-code
  validates against has no `ARTICLES_*` (or `BLOGS_*`) topic at all —
  blog article events aren't declarable through the App Management API
  as of this API version. The subscription has to be registered the
  classic way instead: Shopify admin → Settings → Notifications →
  Webhooks (pick "Article creation" / "Article update", point at
  `${APP_BASE_URL}/api/webhooks/shopify/articles`), or a one-time REST
  Admin API call (`POST /admin/api/2026-04/webhooks.json`) using the
  Admin API access token this app gets once connected via
  `/api/oauth/shopify/start`. `SHOPIFY_WEBHOOK_SECRET` still verifies
  the signature on the receiving end either way.
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

The read-only Shopify access already available to this session (via the
Shopify MCP connector) was used to confirm the store's blog structure
and available API scopes while building this milestone, but it's a
session-scoped connector credential, not a substitute for the app's own
production Shopify access token above.
