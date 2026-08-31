# VGF Content Distribution Platform

Turns Very Good Fireplaces' Shopify blog articles into reviewed,
platform-specific posts for Pinterest, Facebook, and Instagram (LinkedIn
copy is generated but published manually — see plan for why).

Full architecture, schema rationale, retry/cost/security decisions:
[`docs/PHASE_0_PLAN.md`](./docs/PHASE_0_PLAN.md).

## Status

Phase 1, milestones 1–8 done — Pinterest, Facebook, Instagram, and (as
of this milestone) LinkedIn are all publish-capable end to end. Meta
(Facebook + Instagram) is currently paused by choice, not broken —
Pinterest and LinkedIn are the active focus; Meta picks back up
whenever that's revisited, no code changes needed to resume it.

1. Schema in place (all 11 tables from the plan plus `shopify_connection`, migrations generated and verified).
2. Shopify ingestion + extraction pipeline: a daily poll (`/api/cron/poll-shopify-articles`, `src/lib/platforms/shopify-articles.ts`) rather than a webhook — Shopify has no webhook topic for blog articles on any API surface, see below — with the same content-hash dedup, job queue (`jobs` table with `SKIP LOCKED` claiming), a Vercel Cron runner (`/api/cron/run-jobs`) implementing the §5 retry/backoff policy, and the `extract_article` job (Claude call → structured extraction → `article_extractions`). Shopify's own connection (`/api/oauth/shopify/*`) uses the OAuth authorization code grant, not a static token — Shopify stopped issuing those for Dev Dashboard apps on Jan 1, 2026.
3. Per-platform content generation (`generate_content` job) for all four platforms, plus the discrete claim-grounding pass from §3 that flags any generated claim not backed by the article.
4. Review Queue UI (`/review`) and server actions: approve / approve-all / reject, inline copy edit, free-text instruction box, and per-field "regenerate" buttons — all going through the same in-place-edit rule from §4 (editing an approved/scheduled item reverts it to `in_review` and cancels its pending publish). `/review` is strictly the to-do list — `REVIEW_QUEUE_STATUSES` (`src/lib/review.ts`) is just `in_review`, so an item disappears from it the moment it's approved, not when it publishes. Approved/scheduled items move to a separate `/scheduled` screen (`SCHEDULED_VIEW_STATUSES`) showing what's queued and when, or "waiting for platform connection" for an approved item with nowhere to schedule yet. Published/rejected/failed items don't get a screen at all — `publish_log` is already the history, so `contentItems.status` now actually flips to `published`/`failed` on a terminal publish outcome (a real gap fixed alongside this: `runPublishPost` used to only ever update `publishTargets.status`, so a successfully-published item would have sat in `scheduled` forever).
5. Image compositor: two fixed Pinterest pin templates plus a square Instagram slide template (`src/lib/templates/`) rendered server-side with Satori → resvg (`src/lib/render.ts`), a `render_image` job wired to run automatically after Pinterest/Instagram copy generation, approved-image selection (`src/lib/assets.ts`) that still explicitly refuses to guess — nothing reasonable means the item is flagged `needs_asset` rather than silently picking an unrelated photo or falling back to an AI-generated visual. Selection tries exact tag overlap first (free, instant), then falls back to a Claude call that judges topical/visual fit from the article's title, extraction, and each candidate's tags/notes. That fallback is the common path, not a rare one — Shopify's article tags are a generic content taxonomy (e.g. `"Room & Space"`) that was never going to share a string space with the asset library's vendor/product-type tags, discovered when the first real bulk-imported Pinterest post still came back `needs_asset` despite the library having 108 tagged photos.
6. **Publishing**: OAuth connect flows for Pinterest (`/api/oauth/pinterest/*`), Meta (`/api/oauth/meta/*`, one flow produces both the `facebook` and `instagram` connections since they share a Page token), and LinkedIn (`/api/oauth/linkedin/*`, resolves the connecting account's administered organization the same way Meta resolves its Page), token storage via Supabase Vault (`src/lib/vault.ts`, per §3's decision), Pinterest/Facebook/Instagram/LinkedIn API clients (`src/lib/platforms/`) — Instagram's is the full three-step Graph API container/publish flow for carousels, LinkedIn's targets the Community Management API's Posts endpoint (`POST /rest/posts`, organization-authored) — fixed-schedule spacing (`src/lib/scheduling.ts` — Pinterest capped at 2/day spread 6h apart, Facebook and LinkedIn both ~weekly, all "boring by design" per §1/§4), and the `publish_post` job implementing §5's retry + one-shot auth-renewal policy exactly: one refresh attempt, one retry with the new token, and on failure the connection is marked `expired` and every other pending publish for that platform is paused rather than left to fail one at a time. A `publish_target` still unpublished 24h past its scheduled time stops auto-retrying too, per the same section. Approving a Pinterest, Facebook, LinkedIn, or Instagram item now auto-schedules it if that platform is connected; otherwise it stays `approved` until Brendan connects it. LinkedIn was deferred out of V1's publish path in the original plan (§2/§8 — Community Management API access requires a registered-entity application with no approval guarantee) purely because that approval was pending, not for a technical reason; the client and OAuth flow are now built and ready the moment that approval comes through.
7. **Approve is idempotent**: `approveContentItem`'s status update is gated on the item currently being `in_review` in the same statement, so a double-click or duplicate form submit can't schedule the same item to publish twice — found as a real duplicate Pinterest `publish_target` in production and fixed at the root (see `app/review/actions.ts`).
8. **Auth**: Supabase magic-link sign-in (`/login`, `/auth/callback`), allow-listed to a single `ADMIN_EMAIL`, gating every route via `middleware.ts` except the `/api/cron/*` routes, which authenticate themselves via Vercel Cron's `CRON_SECRET` bearer token instead.
9. **Asset Library** (`/assets`): the library was empty until now, which meant every Pinterest/Instagram item was landing in Review flagged `needs_asset` with nothing to render. Unblocked two ways — a one-time bulk import of all 108 active, in-stock Shopify products with a product photo (`source: 'shopify_product'`, tagged by vendor + product type + a keyword scan of installation style/finish so the existing tag-overlap matching in `src/lib/assets.ts` has something real to match against), and a permanent upload/tag screen (`app/assets/*`) for photos that aren't product shots — installation, lifestyle, etc. Uploads go to the same `content-assets` Storage bucket as rendered images, under a `library/` prefix (`uploadLibraryAsset` in `src/lib/storage.ts`); tags are editable in place per asset, and assets can be deleted. Excluded from the bulk import: archived products, the two non-fireplace vendors (protection plans, shipping insurance), and any product with no featured image.
10. **Ingestion triggers on the publish transition, not the save**: `articles.shopify_published_at` now tracks Shopify's own live/scheduled/draft state (`isArticleLive`/`decideSyncAction` in `src/lib/platforms/shopify-articles.ts`), separate from the content-hash diff. A brand-new article isn't stored at all until it's actually live — it naturally resurfaces on its own once it is, since Shopify bumps `updated_at` the moment an article actually goes live (confirmed directly: a republished article's `updatedAt` and `publishedAt` landed on the same timestamp). An already-known article going from not-live to live now enqueues extraction unconditionally, even with an unchanged body — the real bug this fixes: an article drafted and hash-stored well before its scheduled publish date was silently skipped as "unchanged" the day it actually went live, since content-hash diffing alone can't see a publish-date change. The reverse direction matters too — an already-live article that gets unpublished/rescheduled stops triggering entirely while offline, so `fetchAllArticles` now explicitly requests `published_status=any` rather than trusting Shopify's default, or the "went offline" half of that cycle would go undetected and the eventual republish would look unchanged all over again. An already-live article with a real content edit still triggers exactly as before.
11. **Connections & Policy screen** (`/connections`): per-platform connection status with an expiry warning inside 7 days, and a Manual/Trusted/Autonomous toggle backed by `brand_policies` (upserted per platform on save). Only Manual is actually enforced — nothing in the publish pipeline reads `brand_policies.mode` yet, so this stages a policy decision rather than acting on one; the page says so.
12. **LinkedIn, exercised live against production** (first real end-to-end test of any platform integration in this project, not just against docs/fixtures): OAuth handshake, org resolution, and a real organization post all confirmed working against VGF's actual Page — see "LinkedIn Development Tier: corrected assumptions" below for what that run disproved about the docs. Two fixes came out of that test: the `LinkedIn-Version` header had aged out of LinkedIn's support window (`src/lib/platforms/linkedin.ts`, bumped `202506` → `202606` — LinkedIn only supports a rolling ~12 months, this needs periodic attention), and posts had no thumbnail image (LinkedIn's Posts API doesn't scrape the link for one, unlike the old share API) — `createOrganizationPost` now uploads an approved photo through LinkedIn's Images API and sets it as the article's `thumbnail`, using the same asset-library selection as Pinterest/Instagram (`selectLinkedInImageItem` in `app/api/cron/run-jobs/route.ts`) but without any template compositing, since a LinkedIn thumbnail is just the photo itself. Unlike Pinterest/Instagram, a missing or failed image doesn't block the publish — a LinkedIn post is still complete as a plain link card without one.

### LinkedIn Development Tier: corrected assumptions

A live test publish on 2026-08-31 (`/connections`'s "Very Good Fireplaces"
org, real production data, not this dev environment — see below)
disproved two assumptions this codebase had been carrying about
LinkedIn's Community Management API:

- **Development Tier does not block posting to a real (non-test)
  organization Page.** LinkedIn's own docs say Development Tier is for
  building against test pages, with Standard Tier required for
  production use on real Pages. In practice, the OAuth org lookup
  (`listAdministeredOrganizations`) returned VGF's actual Page, and
  `createOrganizationPost` published to it successfully — all still on
  Development Tier (confirmed directly against the Developer Portal's
  product tier badge immediately before the test). Take this as "worked
  for this app today," not as a guarantee the restriction never applies
  — it may be enforced more selectively than the docs suggest, or apply
  to something this test didn't exercise.
- **A refresh_token isn't gated on Standard Tier approval either** — the
  live connection received one while still on Development Tier. See the
  comments in `app/api/oauth/linkedin/callback/route.ts` and
  `app/api/cron/run-jobs/route.ts`'s `attemptRefresh`.

Given that, applying for Standard Tier is less urgent than §8 of the
plan assumed — but this was one successful post at low volume, not a
load test. Development Tier's documented 500-requests/day (app) and
100/day (member) caps, and any other throttling or visibility
limitation LinkedIn applies underneath the write path, haven't been
hit yet and are worth watching for as posting frequency increases.

Not yet built: the Article detail and Publish Log screens.

Verified in four tiers, in order of how real they are:
- No live credentials needed: `npm run typecheck`, `npx next build`, and `npm test` (60 unit tests) all pass.
- **Against a real local Postgres** (`scripts/integration-check.ts`): confirmed the Shopify article sync dedup logic, the cron auth check, the approve → auto-schedule → edit → cancel-pending-publish chain (including that a canceled target's already-enqueued job no-ops cleanly instead of trying to publish), and both `render_image` paths end to end. This caught a real bug earlier (raw-SQL snake_case vs. camelCase in `claimDueJobs`) and this round confirmed the *new* scheduling logic picks the exact right slot (`2026-08-06T14:00:00Z` for the first Pinterest pin approved with nothing else scheduled — matches the spacing rule precisely).
- **Rendering itself** (`scripts/render-sample.ts`, no DB): produces real PNGs from both templates, verified by magic bytes/size and by looking at the output — caught a `ReferenceError: React is not defined` outside Next's JSX runtime and a webpack build failure on `@resvg/resvg-js`'s native binary (fixed via `serverExternalPackages`).
- **What could not be verified here, and why**: the outbound proxy in this environment explicitly blocks `api.pinterest.com`, `graph.facebook.com`, `*.myshopify.com`, and `linkedin.com`/`api.linkedin.com` (confirmed directly — `curl` to any of them fails the CONNECT tunnel with a 403), so none of the actual Pinterest/Meta/Shopify HTTP calls have been made from this environment, and neither had LinkedIn's until production did it directly — the OAuth handshake, org resolution, and a real post all succeeded against VGF's live Page from the deployed app (see "LinkedIn Development Tier: corrected assumptions" above), which is also how the stale `LinkedIn-Version` bug and the missing-thumbnail gap were actually caught. Pinterest/Meta/Shopify's clients remain built against each platform's stable, documented contract only, and the error-classification logic (`src/lib/platforms/errors.ts`) is unit-tested against realistic fixtures instead of a live response for those three. Supabase Vault is a Supabase-platform extension unavailable in a plain local Postgres, so `src/lib/vault.ts` is typecheck-verified only. Supabase Auth (magic-link) likewise needs a real Supabase project — `middleware.ts` and the login/callback routes are typecheck- and build-verified only. All of the above need Brendan's real Pinterest/Meta/Shopify apps and Supabase project to exercise for real — flagging this plainly rather than overstating what a green test suite proves here.

### Re-running the integration check

```bash
# once, in any environment with apt/postgres available:
apt-get install -y postgresql && service postgresql start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su postgres -c "createdb vgf_test"

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" npx drizzle-kit push

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vgf_test" \
CRON_SECRET="test-cron-secret" \
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
  `*.myshopify.com` admin domain (not the custom domain). This app
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

  **Article ingestion polls instead of using a webhook.** Shopify has no
  webhook topic for blog articles at all, on either API surface: the
  `WebhookSubscriptionTopic` GraphQL enum that config-as-code validates
  against has no `ARTICLES_*`/`BLOGS_*` entry, the Shopify admin's
  Notifications → Webhooks dropdown doesn't offer "Article
  creation"/"Article update" either, and the classic REST
  `POST /admin/api/2026-04/webhooks.json` endpoint rejects
  `articles/create`/`articles/update` outright with "Invalid topic
  specified" — confirmed directly against all three, not just the
  GraphQL side. So `/api/cron/poll-shopify-articles`
  (`src/lib/platforms/shopify-articles.ts`) polls the blog named by
  `SHOPIFY_BLOG_HANDLE` once daily (`vercel.json`, 16:00 UTC) once
  Shopify is connected via `/api/oauth/shopify/start`, diffing each
  article's content hash the same way a webhook receiver would have.
  Nothing to register — it just needs the cron schedule deployed and a
  live Shopify connection.
- Pinterest and Meta developer apps (§8 of the plan covers what each
  requires and current approval friction), each with their OAuth redirect
  URI registered as `${APP_BASE_URL}/api/oauth/pinterest/callback` and
  `${APP_BASE_URL}/api/oauth/meta/callback` respectively — then connect
  from the home page (`/`) once the app is deployed and those env vars
  are set. Meta is currently paused (not actively being worked on), so
  this can wait.
- A LinkedIn Developer app with **Community Management API** access —
  per §8, this requires VGF to apply as a registered legal entity
  (verified business email, organization details, a super-admin of the
  LinkedIn Page verifying the application, then a screencast-based
  review), with no approval guarantee. OAuth redirect URI is
  `${APP_BASE_URL}/api/oauth/linkedin/callback` — register that exactly
  when creating the app, then connect from the home page once
  `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET` are set. The client and
  OAuth flow (`src/lib/platforms/linkedin.ts`, `/api/oauth/linkedin/*`)
  are built and ready; nothing here is blocked on code, only on approval.
- An Anthropic API key.
- A public Supabase Storage bucket named `content-assets` (created once
  in the Supabase dashboard) for rendered pin images.
- Product photos are seeded via the one-time bulk import (see above);
  anything else — installation/lifestyle shots — goes in through
  `/assets`, tagged so it overlaps the tags on the articles it should
  illustrate. Without at least one tag match, `render_image`
  intentionally leaves a pin flagged `needs_asset` instead of guessing.

The read-only Shopify access already available to this session (via the
Shopify MCP connector) was used to confirm the store's blog structure
and available API scopes while building this milestone, but it's a
session-scoped connector credential, not a substitute for the app's own
production Shopify access token above.
