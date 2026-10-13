// Pure logic behind `npm run images:sync` (scripts/images-sync.ts): turns
// what Shopify returns into asset_library candidate rows, deduped by
// Shopify image id and by URL, and decides which ones are new. No db or
// network access here so the dedupe and filtering rules are unit-testable.

// Not fireplace products: protection plans, shipping insurance, and the
// hidden placeholder products the theme uses for product options.
export const EXCLUDED_VENDORS = new Set(["Extend", "Route"]);
export const EXCLUDED_PRODUCT_TYPES = new Set(["OPTIONS_HIDDEN_PRODUCT", "Extend Service Contract"]);

// Shopify Files that aren't site photography (logos, promo banners, UI
// assets, screenshots, dimension drawings) or are AI-generated. AI images
// are left out on purpose: the library must only hold real photos.
const NON_PHOTO_FILE_NAME =
  /logo|wordmark|usp-\d|banner|shop_now|screen_?shot|screenshot|dimension|drawing|dall_e|chatgpt_image|blackfriday|_off\.png|buy_more|add_a_heading|financing|christmas_20|pre_?order|alexa_turn|more_heat|cast_iron_stove_ad|onlinepngtools|hqdefault|page-0001|disclai?mer|\.heic|\.gif|\.svg|icon|removebg/i;
export const MIN_FILE_WIDTH_PX = 600;

export type ShopifyImage = { id: string | null; url: string; width: number | null; height: number | null };

export type ShopifyProductInput = {
  id: string;
  title: string;
  vendor: string;
  productType: string;
  images: ShopifyImage[];
};

export type ImageCandidate = {
  shopifyImageId: string | null;
  fileUrl: string;
  widthPx: number | null;
  heightPx: number | null;
  shopifyProductId: string | null;
  notes: string;
};

export type ExistingAsset = { id: string; fileUrl: string; shopifyImageId: string | null };

// Shopify gids ("gid://shopify/MediaImage/123") → "123". The numeric id is
// shared by a product's MediaImage, its ImageSource and the Files entry.
export function numericShopifyId(gid: string | null | undefined): string | null {
  if (!gid) return null;
  return gid.slice(gid.lastIndexOf("/") + 1) || null;
}

// The ?v= cache-buster changes whenever Shopify re-processes a file, so it
// can't be part of the identity.
export function normalizeImageUrl(url: string): string {
  const withScheme = url.startsWith("//") ? `https:${url}` : url;
  return withScheme.split("?")[0]!.split("#")[0]!;
}

export function isLikelySitePhotoFile(url: string, widthPx: number | null): boolean {
  const name = normalizeImageUrl(url).split("/").pop() ?? "";
  if (NON_PHOTO_FILE_NAME.test(name)) return false;
  return (widthPx ?? 0) >= MIN_FILE_WIDTH_PX;
}

export function isFireplaceProduct(product: Pick<ShopifyProductInput, "vendor" | "productType">): boolean {
  return !EXCLUDED_VENDORS.has(product.vendor) && !EXCLUDED_PRODUCT_TYPES.has(product.productType);
}

export function inlineImageUrls(bodyHtml: string | null): string[] {
  if (!bodyHtml) return [];
  const urls: string[] = [];
  for (const match of bodyHtml.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = match[1]!.startsWith("//") ? `https:${match[1]}` : match[1]!;
    if (src.startsWith("https://cdn.shopify.com/")) urls.push(src);
  }
  return urls;
}

export type CollectInput = {
  // Active, in-stock products only — the caller's Shopify query does that.
  products: ShopifyProductInput[];
  collections: { title: string; image: ShopifyImage | null }[];
  articles: { title: string; isPublished: boolean; image: ShopifyImage | null; body: string | null }[];
  files: { image: ShopifyImage | null; alt: string | null }[];
  // Numeric media ids attached to ANY product (any status), so Files that
  // belong to archived/draft/out-of-stock products stay out of scope.
  productAttachedImageIds: Set<string>;
};

// Order matters: product images first so a picture that's both a product
// image and a File keeps its shopify_product_id.
export function collectCandidates(input: CollectInput): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const add = (c: ImageCandidate) => {
    const url = normalizeImageUrl(c.fileUrl);
    if (c.shopifyImageId && seenIds.has(c.shopifyImageId)) return;
    if (seenUrls.has(url)) return;
    if (c.shopifyImageId) seenIds.add(c.shopifyImageId);
    seenUrls.add(url);
    out.push(c);
  };

  for (const p of input.products) {
    if (!isFireplaceProduct(p)) continue;
    for (const img of p.images) {
      add({
        shopifyImageId: numericShopifyId(img.id),
        fileUrl: img.url,
        widthPx: img.width,
        heightPx: img.height,
        shopifyProductId: numericShopifyId(p.id),
        notes: `Imported from Shopify product gallery: ${p.title} (${p.vendor})`,
      });
    }
  }
  for (const c of input.collections) {
    if (!c.image) continue;
    add({
      shopifyImageId: numericShopifyId(c.image.id),
      fileUrl: c.image.url,
      widthPx: c.image.width,
      heightPx: c.image.height,
      shopifyProductId: null,
      notes: `Imported from Shopify collection image: ${c.title}`,
    });
  }
  for (const a of input.articles) {
    if (!a.image) continue;
    add({
      shopifyImageId: numericShopifyId(a.image.id),
      fileUrl: a.image.url,
      widthPx: a.image.width,
      heightPx: a.image.height,
      shopifyProductId: null,
      notes: `Imported from Shopify blog article featured image (${a.isPublished ? "published" : "unpublished"}): ${a.title}`,
    });
  }
  for (const a of input.articles) {
    for (const url of inlineImageUrls(a.body)) {
      add({
        shopifyImageId: null,
        fileUrl: url,
        widthPx: null,
        heightPx: null,
        shopifyProductId: null,
        notes: `Imported from an image inside Shopify blog article (${a.isPublished ? "published" : "unpublished"}): ${a.title}`,
      });
    }
  }
  for (const f of input.files) {
    if (!f.image) continue;
    const id = numericShopifyId(f.image.id);
    if (id && input.productAttachedImageIds.has(id)) continue;
    if (!isLikelySitePhotoFile(f.image.url, f.image.width)) continue;
    add({
      shopifyImageId: id,
      fileUrl: f.image.url,
      widthPx: f.image.width,
      heightPx: f.image.height,
      shopifyProductId: null,
      notes: `Imported from Shopify Files (not attached to a product)${f.alt ? `; Shopify alt text: ${f.alt}` : ""}`,
    });
  }
  return out;
}

export type SyncPlan = {
  toInsert: ImageCandidate[];
  // Existing rows that match a candidate by URL but were imported before
  // shopify_image_id existed: fill in the id and pixel size (null columns
  // only — file_url, tags and notes are never rewritten).
  toBackfill: { assetId: string; shopifyImageId: string | null; widthPx: number | null; heightPx: number | null }[];
};

export function planSync(existing: ExistingAsset[], candidates: ImageCandidate[]): SyncPlan {
  const byId = new Map<string, ExistingAsset>();
  const byUrl = new Map<string, ExistingAsset>();
  for (const e of existing) {
    if (e.shopifyImageId) byId.set(e.shopifyImageId, e);
    byUrl.set(normalizeImageUrl(e.fileUrl), e);
  }
  const plan: SyncPlan = { toInsert: [], toBackfill: [] };
  for (const c of candidates) {
    if (c.shopifyImageId && byId.has(c.shopifyImageId)) continue;
    const match = byUrl.get(normalizeImageUrl(c.fileUrl));
    if (match) {
      if (!match.shopifyImageId && c.shopifyImageId) {
        plan.toBackfill.push({ assetId: match.id, shopifyImageId: c.shopifyImageId, widthPx: c.widthPx, heightPx: c.heightPx });
      }
      continue;
    }
    plan.toInsert.push(c);
  }
  return plan;
}
