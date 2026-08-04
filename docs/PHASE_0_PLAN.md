# VGF Content Distribution Platform — Phase 0 Plan

Status: **Draft for review.** Per the build brief, this is spec only — no
implementation code has been written. Nothing below should be treated as
committed to until Brendan signs off.

Store confirmed: Very Good Fireplaces (verygoodfireplaces.com), Shopify
Basic plan, EDT.

**Revision note:** this draft resolves five gaps flagged in review: token
storage is now a single decision (§3), retry/failure/auth-renewal is now
a stated policy instead of bare schema columns (§5, new), the job-runner
choice is justified against a simpler alternative (§3), a rough monthly
cost estimate is included (§6, new), and in-place editing is now
explicit about what happens to `status` and `version` on the row (§4).

---

## 1. Critique of the plan

**What's right-sized already:** the workflow shape (detect → extract →
generate → assemble → review → publish → log), the insistence on grounding
claims in the source article, the decision to reuse approved imagery over
AI product renders, and the "light touch" scope for Facebook/Instagram.
Keep all of that as written.

**Overbuilt for V1:**

- **All four platforms at once.** LinkedIn's organic-posting API is
  gated to registered legal entities and can take weeks and still get
  rejected (see §6). Building all four integrations in parallel means
  code sits idle while approvals are pending, and it blurs which platform
  is actually shipping first. Your own instinct in item 2 of the brief —
  "Pinterest + one other beats four half-built" — is correct; the plan
  above it doesn't yet reflect that discipline.
- **A full visual template *editor*.** "Assemble from templates" is the
  right call, but a drag-and-drop layout/font editor is a real subsystem.
  V1 needs 2–3 fixed Pinterest layouts rendered server-side, with
  "regenerate with a different template variant" as one of the review
  actions — not a WYSIWYG canvas. Natural-language edits like "use a
  cleaner font" become a parameter swap into the same renderer, not a
  pixel editor.
- **The full Trusted/Autonomous *behavior*.** Building the per-platform,
  per-content-type *policy table* now (so the toggle exists later without
  a schema rewrite) is correctly called out as cheap and worth doing.
  Building the actual unattended runner, duplicate-content detection, and
  brand-rule-violation scoring is not — that's meaningful new logic with
  no V1 user (everything defaults to Manual). Defer the behavior, keep
  the schema.

**Underspecified — needs a concrete answer before building:**

- **"New/updated article" trigger.** Shopify fires `articles/update` on
  any save, including a typo fix. Firing full regeneration on every save
  will burn LLM calls and spam the review queue. V1 needs a content-hash
  check (only re-extract when `body_html` actually changes) and a manual
  "resync this article" action as the escape hatch.
- **Where approved imagery actually lives.** The brief says "reuse
  approved source imagery" but there's no asset library concept yet.
  This is the single most likely bottleneck in the whole system — if
  there's no tagged, browsable library, "reuse approved imagery" quietly
  degrades into "AI-generate it because nothing matched." V1 needs an
  explicit asset library (product photos pulled from Shopify + manually
  uploaded/tagged photos), addressed in §4.
- **"Spread pins out over time."** Needs a concrete, boring rule (e.g.,
  max N Pinterest posts/day, fixed spacing), not a smart scheduler. I'll
  propose the simple version in §4.
- **Auth for a single-user app.** Don't build an accounts system. A
  single magic-link login restricted to Brendan's email is enough.

**Likely to break against real platform constraints** — covered in depth
in §8, but the headline: LinkedIn's API is very plausibly not available
to VGF at all as an individual/small-business developer without a
registered-entity application; Pinterest requires approval before you
get even baseline access; Meta's restrictions are probably lighter than
the brief assumes *because* this is single-user, but that needs a
same-week smoke test to confirm before the build plan depends on it.

---

## 2. Smallest V1 that gets real value

**Pinterest + Meta (Facebook and Instagram together).** Reasoning:

- Pinterest is explicitly the priority platform and has the richest,
  most distinct workflow (multiple pins/article, board routing,
  time-spread scheduling) — it's the platform worth building well first.
- Facebook and Instagram share one Graph API, one Meta Developer app,
  one OAuth flow, and one Page/Business-account linkage. Once that
  integration exists, Instagram is a caption+carousel variant and
  Facebook is a plain image+caption variant of the *same* posting call —
  marginal cost of the second platform is small, so "Pinterest + one
  other" effectively becomes "Pinterest + two" for barely more work.
  Build Facebook posting first (simplest shape: one image, one caption),
  then Instagram carousel within the same milestone.
- **LinkedIn is deferred out of V1's publish path**, not out of the
  product. The review queue still generates LinkedIn copy (the
  professional-reframe content has value on its own), but V1 ships it as
  "copy to clipboard, mark as posted manually" instead of a live API
  integration. Apply for LinkedIn API access in parallel starting week 1
  (see "What Brendan Must Do" below) — if it comes through, wiring up real publishing later is a
  small addition, not a rebuild, because `platform` is already a clean
  enum/table per the brief's own instruction.

This gets one real platform fully automated end-to-end, a second
essentially free on top of it, and doesn't let a slow/uncertain LinkedIn
approval hold up shipping anything.

---

## 3. Tech stack and hosting

Optimizing for "one person, low maintenance," not enterprise defaults —
no Kubernetes, no self-managed servers, no separate infra to patch.

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router, TypeScript), single codebase for UI + server actions/API routes | Review UI and backend logic live together; no separate frontend/backend deploy to coordinate |
| Hosting | Vercel | Zero-ops deploys, generous headroom for single-user traffic, trivial preview environments |
| Database | Postgres via Supabase | Managed, near-zero ops; Supabase also bundles Storage and Auth so you're not standing up three separate vendors |
| File/image storage | Supabase Storage | Generated pin graphics + approved source asset library; served over CDN with no extra setup |
| Background jobs / scheduling | Vercel Cron (5-minute interval, requires Pro plan) polling a Postgres `jobs` table | See justification below — decided against a dedicated workflow vendor |
| LLM | Claude (Anthropic API) | Extraction, per-platform generation, and a discrete "claim-grounding" pass that checks generated copy against the source article before it reaches review |
| Image composition | Satori (SVG→PNG) or `@napi-rs/canvas` | Composites approved photos + text overlays into the fixed pin templates server-side; no design-tool dependency |
| Auth | Supabase Auth, magic link, allow-listed to Brendan's email only | Two minutes to set up, no password to manage, still real auth since this app will hold OAuth tokens |
| Secrets | Supabase Vault | See justification below — decided, not left open |

Everything here is managed and pay-as-you-go. There is no server to
patch, no container orchestration, and no on-call surface — the
maintenance burden is "occasionally update npm packages."

### Decision: Supabase Vault for OAuth tokens (not app-level encryption)

Going with **Supabase Vault**, not "Vault or app-level encryption." The
practical difference: app-level encryption means writing and maintaining
encrypt/decrypt code in the app itself, and it means a symmetric key has
to live *somewhere* — almost always a Vercel environment variable, which
becomes its own single point of failure and a secret that has to be
rotated by hand. Vault keeps the encryption inside the database layer,
tied to Supabase's own project-level key management, so there's no
separate app secret to manage or leak. Tokens are written via
`vault.create_secret()` and only ever read back through
`vault.decrypted_secrets`, from server-side code using the Supabase
service-role key — the browser/client never has a code path that can
reach a token, decrypted or not. On refresh, the app calls
`vault.update_secret()` on the same secret ID rather than writing a new
row, so `platform_connections` never holds plaintext at rest at any point.

### Decision: Vercel Cron + a jobs table, not Trigger.dev

Trigger.dev (or Inngest) would be justified by *job volume or workflow
complexity* neither of which is present here. Realistic load: ~2
articles/week, each producing roughly a dozen jobs (extract, ~8–9
generation calls, image renders, scheduled publishes) — call it 20–30
jobs/week total. That's not a scale that needs a dedicated durable-
execution vendor; it's a scale a five-minute cron tick handles with room
to spare. Concretely: a Postgres `jobs` table (`id, job_type, payload
jsonb, run_at, status, attempt_count, last_error, created_at,
updated_at`) plus one Vercel Cron endpoint that, every 5 minutes, claims
due rows (`status='pending' AND run_at <= now()`) and executes them. The
retry/backoff behavior Trigger.dev would give for free is instead
implemented directly against those columns per the policy in §5 — at
this volume that's a few `if` statements, not a system. Each pipeline
step (extract, one generation call, one image render, one publish
attempt) is its own job row, which also sidesteps Vercel's function
duration limits by keeping every invocation short instead of one long
chained function call.

Honest tradeoff: we give up Trigger.dev's dashboard and built-in
idempotency guarantees. That's mitigated by adding a "Jobs" view to the
Publish Log screen (§4) that reads the `jobs` table directly — cheap to
build, and it's the same information. If real usage ever grows past
"a few articles a week," this is the first piece worth swapping back to
a managed queue; nothing else in the schema depends on the choice.
Note this requires the Vercel **Pro** plan regardless — Hobby's cron
only fires once/day and its function timeout (10s) is too short for an
LLM call anyway, so Pro is a real cost line either way (see §6).

---

## 4. Database schema and core screens

### Schema (V1)

- **`articles`** — `id, shopify_article_id, shopify_blog_id, title, handle, body_html, tags, shopify_updated_at, content_hash, status, fetched_at`. `content_hash` is how we skip no-op re-triggers.
- **`article_extractions`** — `id, article_id, core_subject, audience, search_intent, key_takeaways (jsonb), supported_claims (jsonb), model_used, created_at`. Kept separate from the raw article so regeneration and auditing don't re-run extraction unnecessarily.
- **`platform_connections`** — `id, platform (enum: pinterest|linkedin|facebook|instagram), external_account_id, display_name, access_token_enc, refresh_token_enc, scopes, expires_at, status (connected|expired|revoked), created_at`.
- **`content_items`** — the generated post: `id, article_id, platform, content_type (pinterest_pin|linkedin_post|fb_post|ig_carousel), copy_fields (jsonb), status (draft|in_review|approved|scheduled|published|rejected|failed), version, created_at, updated_at`. **Editing always updates this row in place** — an inline copy edit, a field regeneration, or a free-text instruction all run `UPDATE content_items SET copy_fields = ..., version = version + 1, updated_at = now() WHERE id = ...`. Nothing is ever inserted as a new row or sent anywhere else; the edited post is the same post, still on the same Review Queue screen, immediately re-viewable. `version` is a plain audit counter (paired with the matching `edit_instructions` row for history), not a re-review gate — editing an `in_review` item leaves it `in_review`. The one status transition that does happen automatically: editing an item that's already `approved` or `scheduled` flips its status back to `in_review` and cancels its pending `publish_targets` row, because content changed after sign-off and it shouldn't auto-publish unreviewed. This is still zero round-trip — it's a filter state on the same screen, not a different queue — but it's a deliberate safety property worth stating rather than leaving to guesswork.
- **`content_assets`** — `id, content_item_id, source_type (asset_library|rendered_template), source_asset_id?, template_id?, render_params (jsonb: text placement/font/layout), file_url, status, created_at`.
- **`asset_library`** — the approved-imagery table the brief's workflow currently assumes exists but doesn't define: `id, file_url, tags (text[]), source (shopify_product|manual_upload), shopify_product_id?, uploaded_at, notes`.
- **`publish_targets`** — per-platform scheduling/outcome for a content item: `id, content_item_id, platform_connection_id, scheduled_at, published_at, external_post_id, external_post_url, status (scheduled|publishing|published|failed_retrying|failed|canceled), error_message, attempt_count`. `scheduled_at` spacing rule for Pinterest: cap N pins/day, evenly spaced across the following 3–5 days rather than a smarter scheduler. `attempt_count`/`status` are driven by the retry policy in §5, not ad hoc; `canceled` is the state set when a post-approval edit cancels a pending publish (§4 `content_items` note).
- **`publish_log`** — append-only audit trail: `id, publish_target_id, event_type, detail (jsonb), occurred_at`.
- **`brand_policies`** — the per-platform/content-type approval policy table called for in the brief: `id, platform, content_type, mode (manual|trusted|autonomous), auto_publish_conditions (jsonb), updated_at`. Every row defaults to `manual` in V1; nothing reads `trusted`/`autonomous` yet, but the shape exists so switching later is a data change, not a migration.
- **`edit_instructions`** — audit trail for the free-text regeneration box: `id, content_item_id, instruction_text, field_target, applied_at, result_summary`.
- **`jobs`** — the queue table backing the Vercel Cron runner (§3): `id, job_type (extract_article|generate_content|render_image|publish_post|refresh_token), payload (jsonb), run_at, status (pending|running|succeeded|failed_retryable|failed_final), attempt_count, last_error, created_at, updated_at`. Retry/failure semantics for this table are the policy in §5.

### Core screens

1. **Review Queue** (the main screen) — batch/card view grouped by source article, platform tabs, inline copy edit, regenerate-image/caption/headline, approve/approve-all/reject/reschedule, and the free-text instruction box, all without leaving the screen.
2. **Article detail** — original article + extraction summary + every generated content item tied to it, for traceability back to source.
3. **Asset Library** — upload/tag approved imagery, see what's been used where.
4. **Publish Log** — what published, where, when, from which article; filterable, surfaces failures.
5. **Connections & Policy** — OAuth connect/reconnect per platform with token-expiry status, and the brand-policy table (only Manual is functional in V1, but the toggle UI exists).

### Flow

Shopify webhook → article ingested (hash-checked) → extraction job →
per-platform generation job → claim-grounding pass → image assembly from
asset library + template → lands in Review Queue as `in_review` →
Brendan approves/edits/regenerates in place → approved items get
`publish_targets` with `scheduled_at` → scheduled job publishes via
platform API at that time → `publish_log` entry + status update → visible
in Publish Log.

---

## 5. Retry, failure, and auth-renewal policy

The schema has had `attempt_count`/`status` columns since the first
draft; this is the policy that actually drives them, split by job type
since "retry a Claude call" and "retry a scheduled publish" have
different stakes.

**Generation jobs** (`extract_article`, `generate_content`,
`render_image`): retry transient failures (5xx, timeout, rate-limit)
up to **3 attempts**, backoff 30s → 2min → 8min. On the 3rd failure, set
`status='failed_final'`, leave the `content_item` at `draft` (it never
reaches the review queue half-finished), and surface it as a visible
error card at the top of the Review Queue grouped under its source
article — not buried in a log. Non-retryable errors (e.g., a content
policy refusal from the model) skip straight to `failed_final` after one
attempt; retrying a rejection doesn't help.

**Publish jobs** (`publish_post`): a scheduled post has slack before
it's meaningfully "late," so retries are more patient — up to **5
attempts** over roughly an hour (1min → 5min → 15min → 30min → 60min) on
retryable errors (5xx, 429, network timeout). Non-retryable errors
(401/403, validation errors, platform content-policy rejection) fail
after **1 attempt** — there's no backoff that fixes a bad token or a
rejected image. If all retries are exhausted, or a `publish_target`
first became due more than **24 hours ago** and still hasn't succeeded,
stop auto-retrying and mark `status='failed'` — it needs Brendan's eyes,
not another silent attempt. This is the one hard rule for what's
"silent" vs. "surfaced": every retry *inside* the backoff window is
invisible by design; anything after the last scheduled retry is never
silent — it always lands as a flagged item in the Publish Log with a
"needs attention" badge.

**Auth renewal**: on a `401` from any platform, attempt exactly one
refresh-token exchange. If that succeeds, retry the original call once
more with the new token (doesn't count against the job's normal retry
budget). If the refresh itself fails, immediately set
`platform_connections.status='expired'` — do not keep retrying — and (a)
pause every pending `publish_target` for that platform (moved to
`failed_retrying` with `error_message='auth expired'`, not silently
dropped), and (b) show a persistent banner on the Review Queue and
Connections screens until Brendan reconnects. Expired auth is exactly
the kind of exception the brief's Autonomous-mode description calls out
by name, so this is also the first real exercise of "surface exceptions,"
even though V1 defaults every policy row to Manual.

---

## 6. Cost estimate

Rough monthly numbers, single-user volume (~2 articles/week):

| Item | Monthly cost | Notes |
|---|---|---|
| Vercel Pro | ~$20 | Required regardless of the Trigger.dev decision — Hobby's cron (once/day) and 10s function timeout don't work for this workload |
| Supabase Pro | ~$25 | Free tier auto-pauses projects after a week of inactivity, which an always-on webhook receiver can't tolerate; Pro also includes backups |
| Anthropic API usage | ~$5–15 | At ~2 articles/week × ~10 LLM calls/article (extraction + per-platform generation + claim-grounding + a few edit regenerations), token volume is genuinely small — this line is padding for iteration and retries, not the real driver of cost |
| Domain (optional) | ~$1 (amortized) | Skippable — a `*.vercel.app` subdomain works fine for a single-user internal tool |
| **Total** | **~$50–60/month** | |

Dropping Trigger.dev removes a third subscription and its own cost line
(free tier likely covers this volume, but a paid tier would have added
another $10–25/month once usage grew) without changing the Vercel/
Supabase numbers above, which are driven by uptime and function limits,
not by job orchestration. No image-generation API cost, since the brief
calls for template-composited approved imagery over AI-rendered visuals.
This is a real new monthly line for the business (~$50–60) — flagging it
plainly rather than letting it stay implicit across four vendor signups.

---

## 7. What requires Brendan vs. what can be built unattended

**Requires Brendan** (accounts, approvals, credentials, judgment,
ongoing supply — none of this can be done from inside this session):

- Shopify: a dedicated custom app / Admin API access token with
  `read_content` scope and a webhook secret, created in the Shopify
  admin (separate from any session-level access used for this planning).
- Pinterest: business account + Developer app registration + the API
  access application itself (privacy policy, OAuth demo video, use-case
  description) — Pinterest requires this attestation come from the
  account owner.
- Meta: confirm/convert the Instagram account to Business/Creator,
  link it to the Facebook Page, create the Meta Developer app with
  Brendan as sole admin, generate a long-lived Page token.
- LinkedIn: a go/no-go decision on pursuing API access at all, since it
  requires VGF to apply as a registered legal entity with a verified
  company Page, business email, and a super-admin verification step —
  real turnaround time with no approval guarantee.
- Ongoing: curating and tagging the initial (and continuing) approved
  image library — this is recurring work, not a one-time setup step.
- Hosting/vendor signups: Vercel (Pro), Supabase (Pro), Anthropic API
  key, payment methods on each (~$50–60/month combined, see §6).
- Brand-voice sign-off on the generation prompt before go-live, and
  later judgment calls on when to flip any `brand_policies` row from
  Manual to Trusted.

**Can be built unattended:** the full schema/migrations, the Next.js
app, the review UI, the extraction/generation/claim-grounding pipeline,
the image compositor and fixed templates, the scheduling/publish jobs,
the OAuth *code* (Brendan only has to click "connect" once the app/
credentials exist on the platform side), the publish log, the policy
scaffolding, and tests.

---

## 8. Current platform API restrictions (verified, August 2026)

- **Pinterest** — apps must be approved before receiving even baseline
  ("Trial") access; Trial is capped around 1,000 requests/day (300 for
  ad endpoints), which is a non-issue at this volume. Approval requires
  a developer account, documented OAuth flow, working privacy policy,
  and a video demo of the app's core actions — approval can take weeks
  and rejections don't always come with a reason. **Action: apply in
  week 1**, since it's on the critical path for the priority platform.
  [Access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/) · [Rate limits](https://developers.pinterest.com/docs/reference/rate-limits/)

- **LinkedIn** — the Community Management API (needed for any organic
  posting) is explicitly **not available to individual developers**.
  It's restricted to registered legal organizations for commercial use
  cases: verified business email, organization's legal name/registered
  address/website/privacy policy, and a super-admin of the LinkedIn Page
  verifying the application, followed by a screencast-based review for
  Standard tier access. If VGF is a registered legal entity (likely,
  given it's an operating ecommerce business) this is achievable but
  slow and not guaranteed; if not, it's a hard blocker. This is why
  LinkedIn is scoped out of V1's live publishing path in §2.
  [LinkedIn Community Management API access](https://singhamandeep.com/linkedin-community-management-api-access/)

- **Instagram** (Meta Graph API) — requires a Business or Creator
  account linked to a Facebook Page (personal IG accounts cannot be
  accessed via any official API in 2026), a registered Meta Developer
  app, and reviewed permissions for **Advanced Access**, which itself
  requires business verification and a Live-mode app. **However**:
  Meta grants **Standard Access** automatically to people holding an
  admin/developer/tester role on the app, without App Review — and
  since Brendan will always be the app's sole user, this may cover V1
  indefinitely. This needs a direct smoke test (attempt a real publish
  call against Brendan's own connected account) before the build plan
  assumes it, since Meta's permission tiers have shifted before and a
  written summary isn't a substitute for a live check.
  [Instagram Graph API 2026 guide](https://www.netrows.com/blog/instagram-graph-api-guide-2026)

- **Facebook Pages** — same nuance as Instagram: apps in Development
  Mode can access Pages where the same person holds both the Page admin
  role and a developer/tester role on the app — which is exactly
  Brendan's situation. Advanced Access / full App Review is only forced
  once the app needs to manage a Page it doesn't own (an agency-style
  use case, not this one). **Action: verify with the same smoke test as
  Instagram before committing to the build order.**
  [Facebook Page API permissions & app review](https://singhamandeep.com/facebook-page-api-permissions-app-review/)

- **Shopify** — no restriction of note. The Basic plan supports the
  Admin API and webhooks (`articles/create`, `articles/update`) needed
  to detect new/updated blog posts.

Net effect on sequencing: Meta (Facebook + Instagram) is probably the
*fastest* platform to get live despite being "second priority" in the
brief, because it likely needs no external approval at all for a
single-user app. Pinterest needs an approval that should be filed
immediately because of turnaround time, not because it's technically
hard. LinkedIn is the one genuinely uncertain dependency and shouldn't
gate anything else.

---

## What Brendan Must Do

In order, before implementation can proceed against real APIs:

1. **Confirm VGF's legal entity status** (LLC/corp registered, business
   email available) — determines whether LinkedIn API access is even
   worth pursuing. Answer this first since it's the slowest-moving item.
2. **Shopify**: create a custom app in the Shopify admin with
   `read_content` scope, generate an Admin API access token, and note
   the webhook signing secret. (Separate from this session's Shopify
   access — this is a persistent credential for the running app.)
3. **Pinterest**: create/confirm a Pinterest business account, register
   a Developer app, and submit the API access application (privacy
   policy URL + OAuth demo). This has the longest lead time of the
   items that are unambiguously needed — start it this week.
4. **Meta**: convert/confirm the Instagram account as Business or
   Creator, link it to the VGF Facebook Page, create a Meta Developer
   app with yourself as admin. I'll then run a live smoke-test publish
   call against your own account to confirm Standard Access is
   sufficient before we build the full pipeline around that assumption.
5. **LinkedIn** (only if step 1 confirms a registered entity and you
   want to pursue it): gather the business verification details
   (legal name, registered address, website, privacy policy, verified
   business email) and identify the LinkedIn Page super-admin who can
   verify the application. Submit in parallel — don't wait on it.
6. **Approved image library, first pass**: pull together an initial set
   of product/installation/manufacturer photos you're comfortable being
   reused across platforms — this seeds the asset library and is the
   one piece of ongoing manual work the system can't do for you.
7. **Vendor sign-ups**: Vercel (Pro plan), Supabase (Pro plan), and an
   Anthropic API key — accounts + payment method on each. No Trigger.dev/
   Inngest signup needed per §3.
8. **Sign off on this plan** — specifically confirm: (a) Pinterest +
   Meta as the V1 scope with LinkedIn deferred, (b) the fixed-template
   approach to imagery instead of a full editor, (c) the tech stack in
   §3 including Supabase Vault and Vercel Cron + jobs table, (d) the
   retry/failure/auth-renewal policy in §5, and (e) the ~$50–60/month
   cost estimate in §6 — before implementation begins.

---

*End of Phase 0. Per the build brief, implementation does not begin
until this plan is reviewed and signed off.*
