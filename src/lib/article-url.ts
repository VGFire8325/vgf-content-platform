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
