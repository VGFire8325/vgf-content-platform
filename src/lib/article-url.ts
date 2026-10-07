// Shopify's article webhook payload gives a blog_id (numeric), not the
// blog's handle needed to build the public URL, and this is a
// single-blog store — so rather than an extra Admin API round-trip or a
// schema migration to store it, the blog handle is a small env var.
// Confirmed against the real store: verygoodfireplaces.com's blog is
// "electric-fireplaces" (checked via the Shopify Admin API during
// Phase 0 planning).
export function articlePublicUrl(shopDomain: string, blogHandle: string, articleHandle: string): string {
  return `https://${shopDomain}/blogs/${blogHandle}/${articleHandle}`;
}

// UTM-tags a pin's destination link so Pinterest traffic is attributable
// in analytics — added 2026-10 alongside Standard API access, scoped to
// Pinterest only per Brendan's rule (Facebook/LinkedIn links are
// untouched; their platforms' own click analytics already attribute
// referral traffic well enough that nobody asked for this there).
// contentItemId as utm_content is stable at link-build time, unlike the
// pin's own id which only exists after Pinterest creates it.
export function withPinterestUtm(articleUrl: string, contentItemId: string): string {
  const url = new URL(articleUrl);
  url.searchParams.set("utm_source", "pinterest");
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", "organic_pins");
  url.searchParams.set("utm_content", contentItemId);
  return url.toString();
}
