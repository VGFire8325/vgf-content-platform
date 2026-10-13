import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildSupplierEmailBody, sendSupplierEmail, SupplierEmailNotSentError, supplierEmailMode, type SupplierEmailConfig } from "@/lib/email";
import { buildSupplierOrderEmail, outcomeLine, planSupplierEmails, type PlanItem } from "./supplier-email";
import { matchActiveSupplier, SUPPLIER_SEED, type Supplier } from "./suppliers";

const supplier = (id: string): Supplier => SUPPLIER_SEED.find((s) => s.id === id)!;

let nextId = 0;
function item(vendor: string | null, supplierId: string | null, overrides: Partial<PlanItem> = {}): PlanItem {
  nextId++;
  return { id: `i${nextId}`, sku: `SKU-${nextId}`, productName: `Product ${nextId}`, quantity: 1, vendor, supplierId, sentAt: null, ...overrides };
}

// --- vendor matching -------------------------------------------------------

test("matchActiveSupplier is case-insensitive and never returns an inactive supplier", () => {
  assert.equal(matchActiveSupplier("MODERN FLAMES", SUPPLIER_SEED)?.id, "modern_flames");
  assert.equal(matchActiveSupplier(" litedeer homes ", SUPPLIER_SEED)?.id, "litedeer");
  assert.equal(matchActiveSupplier("Evolution Fires", SUPPLIER_SEED), null);
  assert.equal(matchActiveSupplier("Faber", SUPPLIER_SEED), null);
});

test("the seed marks Evolution Fires inactive and Litedeer as never ordered from; Modern Flames is a normal email supplier", () => {
  assert.equal(supplier("evolution_fires").active, false);
  assert.equal(supplier("litedeer").orderedBefore, false);
  const mf = supplier("modern_flames");
  assert.deepEqual([mf.active, mf.method, mf.orderedBefore], [true, "email", true]);
  assert.ok(SUPPLIER_SEED.filter((s) => s.id !== "evolution_fires").every((s) => s.active));
});

// --- grouping --------------------------------------------------------------

test("planSupplierEmails: one email per supplier, portal and unmatched/inactive reported, sent items left out", () => {
  const mf1 = item("Modern Flames", "modern_flames");
  const dimplex = item("Dimplex", "dimplex");
  const mf2 = item("Modern Flames", "modern_flames");
  const touchstone = item("Touchstone", "touchstone");
  const evolution = item("Evolution Fires", null);
  const faber1 = item("Faber", null);
  const faber2 = item("faber", null);
  const alreadySent = item("Dynasty", "dynasty", { sentAt: new Date() });

  const plans = planSupplierEmails([mf1, dimplex, mf2, touchstone, evolution, faber1, faber2, alreadySent], SUPPLIER_SEED);
  assert.deepEqual(
    plans.map((p) => [p.kind, p.kind === "unmatched" ? p.vendor : p.supplier.id, p.items.map((i) => i.id)]),
    [
      ["email", "modern_flames", [mf1.id, mf2.id]],
      ["email", "dimplex", [dimplex.id]],
      ["portal", "touchstone", [touchstone.id]],
      ["unmatched", "Evolution Fires", [evolution.id]],
      ["unmatched", "Faber", [faber1.id, faber2.id]],
    ],
  );
  const evo = plans.find((p) => p.kind === "unmatched" && p.vendor === "Evolution Fires");
  assert.equal(evo?.kind === "unmatched" && evo.inactiveSupplier?.id, "evolution_fires");
  const fab = plans.find((p) => p.kind === "unmatched" && p.vendor === "Faber");
  assert.equal(fab?.kind === "unmatched" && fab.inactiveSupplier, null);
});

test("planSupplierEmails never emails an item assigned to an inactive supplier", () => {
  const plans = planSupplierEmails([item("Evolution Fires", "evolution_fires")], SUPPLIER_SEED);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.kind, "unmatched");
});

test("planSupplierEmails returns nothing when every item is already sent", () => {
  assert.deepEqual(planSupplierEmails([item("Modern Flames", "modern_flames", { sentAt: new Date() })], SUPPLIER_SEED), []);
});

// --- content ---------------------------------------------------------------

const ORDER = {
  orderNumber: "1322",
  customerName: "Brenda Peek",
  shipCompany: "Peek Builders",
  shipAddress1: "756 Pegasus Lane",
  shipAddress2: "Unit 2",
  shipCity: "League City",
  shipProvince: "TX",
  shipZip: "77573",
  shipCountry: "United States",
  phone: "+1 702-204-3839",
  email: "brenda@example.com",
};

test("buildSupplierOrderEmail: greeting, items, ship-to, PO, the three asks, instructions and sign-off", () => {
  const { subject, text } = buildSupplierOrderEmail(
    ORDER,
    [
      { sku: "E-FX-60", productName: "E-FX 60 3-Sided", quantity: 1 },
      { sku: null, productName: "Trim kit", quantity: 2 },
    ],
    supplier("sustainable_hearth"),
    "Brendan@verygoodfireplaces.com",
  );
  assert.equal(subject, "New Order [#1322] from Very Good Fireplaces");
  assert.equal(
    text,
    [
      "Hi Holly,",
      "",
      "We have a new order to place with you.",
      "",
      "PO reference: #1322",
      "",
      "Items:",
      "- Qty 1: E-FX 60 3-Sided (SKU E-FX-60)",
      "- Qty 2: Trim kit",
      "",
      "Please ship to the address below. Include shipping on the invoice.",
      "",
      "Ship to:",
      "Brenda Peek",
      "Peek Builders",
      "756 Pegasus Lane",
      "Unit 2",
      "League City, TX 77573",
      "United States",
      "Phone: +1 702-204-3839",
      "Email: brenda@example.com (for the carrier)",
      "",
      "Please reply to this email to:",
      "1. Confirm the items are in stock and ready to ship.",
      "2. If anything isn't in stock, tell us the lead time.",
      "3. Send the freight quote, and the tracking number when it ships.",
      "",
      "Thank you,",
      "Very Good Fireplaces",
      "Brendan@verygoodfireplaces.com",
    ].join("\n"),
  );
});

test("buildSupplierOrderEmail: no instructions line without draft_instructions, no blank lines for missing address parts, no prices", () => {
  const { text } = buildSupplierOrderEmail(
    { ...ORDER, shipCompany: null, shipAddress2: null, phone: null, email: null },
    [{ sku: "LPM-12016", productName: "Landscape Pro Multi 120''", quantity: 1 }],
    supplier("modern_flames"),
    "Brendan@verygoodfireplaces.com",
  );
  assert.ok(text.startsWith("Hello,\n\nWe have a new order to place with you."));
  assert.match(text, /Ship to:\nBrenda Peek\n756 Pegasus Lane\nLeague City, TX 77573\nUnited States\n\nPlease reply/);
  assert.doesNotMatch(text, /\$|price|card|payment/i);
});

// --- recipients (test-mode redirect) ---------------------------------------

const CONFIG: SupplierEmailConfig = {
  mode: "test",
  from: "Very Good Fireplaces <orders@verygoodfireplaces.com>",
  replyTo: "Brendan@verygoodfireplaces.com",
  bcc: ["Brendan@verygoodfireplaces.com"],
  notifyTo: ["brendan@example.com"],
};
const EMAIL = { supplier: supplier("modern_flames"), subject: "New Order [#1322] from Very Good Fireplaces", text: "body", idempotencyKey: "k" };

test("test mode: the only recipient is ORDER_NOTIFY_TO, no BCC, subject says where it would have gone", () => {
  const body = buildSupplierEmailBody(EMAIL, CONFIG);
  assert.deepEqual(body.to, ["brendan@example.com"]);
  assert.equal(body.bcc, undefined);
  assert.equal(body.subject, "[TEST - would go to orders@modernflames.com] New Order [#1322] from Very Good Fireplaces");
  assert.equal(body.from, CONFIG.from);
  assert.equal(body.reply_to, CONFIG.replyTo);
});

test("live mode: to the supplier's order_email only, BCC Brendan, Reply-To Brendan", () => {
  const body = buildSupplierEmailBody(EMAIL, { ...CONFIG, mode: "live" });
  assert.deepEqual(body.to, ["orders@modernflames.com"]);
  assert.deepEqual(body.bcc, ["Brendan@verygoodfireplaces.com"]);
  assert.equal(body.reply_to, "Brendan@verygoodfireplaces.com");
  assert.equal(body.subject, EMAIL.subject);
});

test("never emails a portal, inactive or address-less supplier, in either mode", () => {
  for (const mode of ["test", "live"] as const) {
    const config = { ...CONFIG, mode };
    assert.throws(() => buildSupplierEmailBody({ ...EMAIL, supplier: supplier("touchstone") }, config), /portal supplier/);
    assert.throws(() => buildSupplierEmailBody({ ...EMAIL, supplier: supplier("evolution_fires") }, config), /inactive/);
    assert.throws(() => buildSupplierEmailBody({ ...EMAIL, supplier: { ...supplier("dynasty"), orderEmail: null } }, config), /no valid order_email/);
    assert.throws(() => buildSupplierEmailBody({ ...EMAIL, supplier: { ...supplier("dynasty"), orderEmail: "a@b.com, c@d.com" } }, config), /no valid order_email/);
  }
});

// --- sendSupplierEmail against a stubbed Resend ----------------------------

const ENV_KEYS = ["SUPPLIER_EMAIL_MODE", "SUPPLIER_EMAIL_FROM", "SUPPLIER_EMAIL_REPLY_TO", "SUPPLIER_EMAIL_BCC", "ORDER_NOTIFY_TO", "RESEND_API_KEY"];
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let calls: { url: string; init: RequestInit }[];
let respond: () => Response;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    SUPPLIER_EMAIL_FROM: "Very Good Fireplaces <orders@verygoodfireplaces.com>",
    SUPPLIER_EMAIL_REPLY_TO: "Brendan@verygoodfireplaces.com",
    SUPPLIER_EMAIL_BCC: "Brendan@verygoodfireplaces.com",
    ORDER_NOTIFY_TO: "brendan@example.com",
    RESEND_API_KEY: "re_test_key",
  });
  calls = [];
  respond = () => Response.json({ id: "msg_123" });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const sentBody = () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;

test("SUPPLIER_EMAIL_MODE defaults to test; only the exact value 'live' is live", () => {
  assert.equal(supplierEmailMode(), "test");
  for (const v of ["LIVE", " live "]) {
    process.env.SUPPLIER_EMAIL_MODE = v;
    assert.equal(supplierEmailMode(), "live");
  }
  for (const v of ["true", "production", "1", "test"]) {
    process.env.SUPPLIER_EMAIL_MODE = v;
    assert.equal(supplierEmailMode(), "test");
  }
});

test("sendSupplierEmail with the mode unset goes to ORDER_NOTIFY_TO only, with the idempotency key", async () => {
  const result = await sendSupplierEmail(EMAIL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "k");
  const body = sentBody();
  assert.deepEqual(body.to, ["brendan@example.com"]);
  assert.equal(body.bcc, undefined);
  assert.equal(JSON.stringify(body).includes("modernflames.com"), true); // only in the [TEST - would go to ...] subject
  assert.equal((body.to as string[]).some((a) => a.includes("modernflames")), false);
  assert.deepEqual(result, { mode: "test", to: ["brendan@example.com"], subject: body.subject, messageId: "msg_123" });
});

test("sendSupplierEmail in live mode sends to the supplier with Brendan on BCC", async () => {
  process.env.SUPPLIER_EMAIL_MODE = "live";
  const result = await sendSupplierEmail(EMAIL);
  assert.deepEqual(sentBody().to, ["orders@modernflames.com"]);
  assert.deepEqual(sentBody().bcc, ["Brendan@verygoodfireplaces.com"]);
  assert.equal(result.mode, "live");
});

test("sendSupplierEmail: missing config or a Resend 4xx is a definite failure; 5xx/network may have sent", async () => {
  delete process.env.SUPPLIER_EMAIL_FROM;
  await assert.rejects(sendSupplierEmail(EMAIL), SupplierEmailNotSentError);
  assert.equal(calls.length, 0);

  process.env.SUPPLIER_EMAIL_FROM = "Very Good Fireplaces <orders@verygoodfireplaces.com>";
  respond = () => new Response("bad address", { status: 422 });
  await assert.rejects(sendSupplierEmail(EMAIL), SupplierEmailNotSentError);

  respond = () => new Response("oops", { status: 500 });
  await assert.rejects(sendSupplierEmail(EMAIL), (err) => err instanceof Error && !(err instanceof SupplierEmailNotSentError));

  await assert.rejects(sendSupplierEmail({ ...EMAIL, supplier: supplier("touchstone") }), SupplierEmailNotSentError);
});

// --- Brendan's lines ---------------------------------------------------------

test("outcome lines for Brendan: live, test, first order, portal, inactive, failed", () => {
  assert.equal(
    outcomeLine({ kind: "sent", supplier: supplier("dynasty"), mode: "live", to: ["info@dynastyfireplace.com"], firstOrder: false }, "1322"),
    "Dynasty: supplier email sent to info@dynastyfireplace.com (you're on BCC; replies come to you).",
  );
  assert.match(
    outcomeLine({ kind: "sent", supplier: supplier("litedeer"), mode: "live", to: ["litedeerhomes@gmail.com"], firstOrder: true }, "1322"),
    /This is the first order to litedeerhomes@gmail.com/,
  );
  assert.match(
    outcomeLine({ kind: "sent", supplier: supplier("dynasty"), mode: "test", to: ["brendan@example.com"], firstOrder: false }, "1322"),
    /TEST MODE.*would go to info@dynastyfireplace.com.*has NOT received it/,
  );
  assert.equal(outcomeLine({ kind: "portal", supplier: supplier("touchstone") }, "1322"), "Touchstone: Place order #1322 in the Touchstone dealer portal.");
  assert.match(
    outcomeLine({ kind: "unmatched", vendor: "Evolution Fires", inactiveSupplier: supplier("evolution_fires") }, "1322"),
    /^Unmatched vendor Evolution Fires on order #1322 \(Evolution Fires is no longer an active supplier/,
  );
  assert.match(outcomeLine({ kind: "unmatched", vendor: "Faber", inactiveSupplier: null }, "1322"), /^Unmatched vendor Faber on order #1322\./);
  assert.match(outcomeLine({ kind: "failed", supplier: supplier("dynasty"), error: "HTTP 422", mayHaveSent: false }, "1322"), /FAILED/);
});
