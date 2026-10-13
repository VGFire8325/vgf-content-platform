import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCandidates,
  inlineImageUrls,
  isLikelySitePhotoFile,
  normalizeImageUrl,
  numericShopifyId,
  planSync,
  type CollectInput,
} from "./image-sync";

const CDN = "https://cdn.shopify.com/s/files/1/0304/1243/9690/files";
const img = (id: string, name: string, width = 1200) => ({
  id: `gid://shopify/ImageSource/${id}`,
  url: `${CDN}/${name}?v=1`,
  width,
  height: 800,
});
const empty: CollectInput = { products: [], collections: [], articles: [], files: [], productAttachedImageIds: new Set() };

test("numericShopifyId strips the gid prefix", () => {
  assert.equal(numericShopifyId("gid://shopify/MediaImage/123"), "123");
  assert.equal(numericShopifyId(null), null);
});

test("normalizeImageUrl drops the ?v= cache-buster and adds a scheme", () => {
  assert.equal(normalizeImageUrl(`${CDN}/a.jpg?v=99`), `${CDN}/a.jpg`);
  assert.equal(normalizeImageUrl("//cdn.shopify.com/x.png?v=1"), "https://cdn.shopify.com/x.png");
});

test("isLikelySitePhotoFile rejects logos, banners, drawings, AI images and small files", () => {
  assert.equal(isLikelySitePhotoFile(`${CDN}/VGF_Logo_Standard.png`, 1000), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/SHOP_NOW_3.png`, 1920), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/touchstone-80011-Sideline60Dimensions.jpg`, 3300), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/DALL_E_2025-01-09_15.34.57_-_A_cozy_living_room.webp`, 1024), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/ChatGPT_Image_Sep_16_2026.png`, 2048), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/ULT60_LSF_Livingroom_300dpi.jpg`, 500), false);
  assert.equal(isLikelySitePhotoFile(`${CDN}/ULT60_LSF_Livingroom_300dpi.jpg`, 3840), true);
});

test("inlineImageUrls keeps only Shopify CDN images", () => {
  const html = `<p><img src="//cdn.shopify.com/s/a.jpg?v=1"><img alt="x" src="https://example.com/b.jpg"></p>`;
  assert.deepEqual(inlineImageUrls(html), ["https://cdn.shopify.com/s/a.jpg?v=1"]);
  assert.deepEqual(inlineImageUrls(null), []);
});

test("collectCandidates skips non-fireplace products and dedupes by id and URL", () => {
  const out = collectCandidates({
    ...empty,
    products: [
      { id: "gid://shopify/Product/1", title: "Plan", vendor: "Extend", productType: "Extend Service Contract", images: [img("9", "extend.png")] },
      { id: "gid://shopify/Product/2", title: "Sideline", vendor: "Touchstone", productType: "Electric Fireplace", images: [img("10", "room.jpg"), img("11", "cutout.png")] },
      // Same image attached to a second product: kept once, under the first.
      { id: "gid://shopify/Product/3", title: "Bundle", vendor: "Touchstone", productType: "Bundle", images: [img("10", "room.jpg")] },
    ],
    collections: [{ title: "Built-In", image: { ...img("20", "room.jpg"), url: `${CDN}/room.jpg?v=7` } }],
  });
  assert.deepEqual(
    out.map((c) => [c.shopifyImageId, c.shopifyProductId]),
    [
      ["10", "2"],
      ["11", "2"],
    ],
  );
});

test("collectCandidates leaves out Files attached to any product, and non-photo Files", () => {
  const out = collectCandidates({
    ...empty,
    files: [
      { image: img("30", "archived-product.jpg"), alt: null },
      { image: img("31", "VGF_Wordmark.png"), alt: null },
      { image: img("32", "XLF7417-XD_Bay_Lifestyle_300dpi.jpg", 4500), alt: "Dimplex lifestyle" },
    ],
    productAttachedImageIds: new Set(["30"]),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.shopifyImageId, "32");
  assert.match(out[0]!.notes, /Shopify Files.*alt text: Dimplex lifestyle/);
});

test("planSync inserts only new images and backfills ids on rows imported before shopify_image_id", () => {
  const candidates = collectCandidates({
    ...empty,
    products: [
      { id: "gid://shopify/Product/2", title: "Sideline", vendor: "Touchstone", productType: "Electric Fireplace", images: [img("10", "room.jpg"), img("11", "cutout.png"), img("12", "new.jpg")] },
    ],
  });
  const plan = planSync(
    [
      { id: "a", fileUrl: `${CDN}/room.jpg?v=old`, shopifyImageId: null },
      { id: "b", fileUrl: `${CDN}/elsewhere.jpg`, shopifyImageId: "11" },
    ],
    candidates,
  );
  assert.deepEqual(plan.toInsert.map((c) => c.shopifyImageId), ["12"]);
  assert.deepEqual(plan.toBackfill, [{ assetId: "a", shopifyImageId: "10", widthPx: 1200, heightPx: 800 }]);
});
