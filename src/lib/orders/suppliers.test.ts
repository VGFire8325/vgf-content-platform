import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isFulfillableLineItem, matchSupplier, SUPPLIER_SEED } from "./suppliers";

// Every vendor value present in the live store's product catalog on
// 2026-10-09 (Shopify productVendors), and where it should route.
const EXPECTED: Record<string, string | null> = {
  Amantii: "amantii_remii",
  Remii: "amantii_remii",
  Dimplex: "dimplex",
  "Dynasty Fireplaces": "dynasty",
  "European Home": "sustainable_hearth",
  "Sustainable Hearth": "sustainable_hearth",
  "Evolution Fires": "evolution_fires",
  Litedeer: "litedeer",
  "Litedeer Homes": "litedeer",
  "Modern Flames": "modern_flames",
  Touchstone: "touchstone",
  // No confirmed supplier yet: these must flag needs_attention.
  Faber: null,
  Flamerite: null,
  "Sierra Flame": null,
  "Solution Electric Fires": null,
  "Very Good Fireplace": null,
};

test("every real store vendor routes to the expected supplier (or none)", () => {
  for (const [vendor, expected] of Object.entries(EXPECTED)) {
    assert.equal(matchSupplier(vendor, SUPPLIER_SEED)?.id ?? null, expected, vendor);
  }
});

test("matching ignores case and surrounding whitespace", () => {
  assert.equal(matchSupplier("  modern flames ", SUPPLIER_SEED)?.id, "modern_flames");
});

test("blank or missing vendor matches nothing", () => {
  assert.equal(matchSupplier("", SUPPLIER_SEED), null);
  assert.equal(matchSupplier(null, SUPPLIER_SEED), null);
});

test("protection plans and shipping insurance are not sent to a manufacturer", () => {
  assert.equal(isFulfillableLineItem({ vendor: "Extend", requires_shipping: false }), false);
  assert.equal(isFulfillableLineItem({ vendor: "Route", requires_shipping: true }), false);
  assert.equal(isFulfillableLineItem({ vendor: "Modern Flames", requires_shipping: false }), false);
  assert.equal(isFulfillableLineItem({ vendor: "Modern Flames", requires_shipping: true }), true);
  // Custom items with no vendor still need fulfilling (and will flag).
  assert.equal(isFulfillableLineItem({ vendor: null }), true);
});

test("seed matches Brendan's confirmed values", () => {
  const byId = Object.fromEntries(SUPPLIER_SEED.map((s) => [s.id, s]));
  assert.equal(byId.sustainable_hearth!.orderEmail, "inside.sales@sustainablehearth.com");
  assert.equal(byId.sustainable_hearth!.greeting, "Hi Holly,");
  assert.equal(byId.touchstone!.method, "portal");
  assert.equal(byId.touchstone!.orderEmail, null);
  assert.ok(SUPPLIER_SEED.every((s) => s.orderEmail !== "orders@europeanhome.com"));
});

test("SUPPLIER_SEED and the migration seed agree", () => {
  const sqlText = readFileSync(new URL("../../../drizzle/0007_order_fulfillment.sql", import.meta.url), "utf8");
  for (const s of SUPPLIER_SEED) {
    const row = sqlText.split("\n").find((line) => line.startsWith(`('${s.id}',`));
    assert.ok(row, `migration has no seed row for ${s.id}`);
    assert.ok(row.includes(s.orderEmail ? `'${s.orderEmail}'` : "NULL"), `${s.id} email`);
    assert.ok(row.includes(`'${s.method}'`), `${s.id} method`);
    assert.ok(row.includes(`ARRAY[${s.vendorNames.map((v) => `'${v}'`).join(", ")}]`), `${s.id} vendor names`);
    assert.ok(row.includes(`'${s.greeting}'`), `${s.id} greeting`);
  }
});
