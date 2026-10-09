import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, buildMailtoUrl, buildPortalBlock, type DraftOrder } from "./draft";
import { SUPPLIER_SEED } from "./suppliers";

const supplier = (id: string) => SUPPLIER_SEED.find((s) => s.id === id)!;

const ORDER: DraftOrder = {
  orderNumber: "1320",
  customerName: "Brenda Peek",
  shipCompany: null,
  shipAddress1: "756 Pegasus Lane",
  shipAddress2: null,
  shipCity: "League City",
  shipProvince: "TX",
  shipZip: "77573",
  shipCountry: "United States",
  phone: "+1 702-204-3839",
  freightSeparate: true,
};

test("draft matches Brendan's sent New Order [#1320] email exactly", () => {
  const draft = buildDraft(ORDER, [{ quantity: 1, productName: "Landscape Pro Multi 120''", sku: "LPM-12016" }], supplier("modern_flames"));
  assert.equal(draft.subject, "New Order [#1320]");
  assert.equal(
    draft.body,
    [
      "Hello,",
      "",
      "Please process an order for:",
      "",
      "(1) Landscape Pro Multi 120'' LPM-12016",
      "(1) Freight for shipping to zip code 77573",
      "",
      "Shipping to:",
      "",
      "Brenda Peek",
      "756 Pegasus Lane",
      "League City TX 77573",
      "United States",
      "+1 702-204-3839",
      "",
      "--",
      "Have a wonderful day!",
      "",
      "(307) 200-9396",
      "www.VeryGoodFireplaces.com",
    ].join("\n"),
  );
});

test("no freight line unless the freight box is ticked; one line per item", () => {
  const draft = buildDraft(
    { ...ORDER, freightSeparate: false },
    [
      { quantity: 2, productName: "Amantii 50\" Panorama BI Extra Slim", sku: "BI-50-XTRASLIM" },
      { quantity: 1, productName: "Remii Heater", sku: null },
    ],
    supplier("amantii_remii"),
  );
  assert.doesNotMatch(draft.body, /Freight/);
  assert.match(draft.body, /Please process an order for:\n\n\(2\) Amantii 50" Panorama BI Extra Slim BI-50-XTRASLIM\n\(1\) Remii Heater\n\nShipping to:/);
});

test("Sustainable Hearth draft greets Holly and asks for shipping on the invoice", () => {
  const draft = buildDraft(
    { ...ORDER, freightSeparate: false, shipCompany: "The Lagasse Group", shipAddress2: "27B/C" },
    [{ quantity: 1, productName: "Signal Series 80'' Fireplace", sku: "SH-FP-SIG-80" }],
    supplier("sustainable_hearth"),
  );
  assert.equal(
    draft.body.split("\n--\n")[0],
    [
      "Hi Holly,",
      "",
      "Please process an order for:",
      "",
      "(1) Signal Series 80'' Fireplace SH-FP-SIG-80",
      "",
      "Please ship to the address below. Include shipping on the invoice.",
      "",
      "Shipping to:",
      "",
      "Brenda Peek",
      "The Lagasse Group",
      "756 Pegasus Lane",
      "27B/C",
      "League City TX 77573",
      "United States",
      "+1 702-204-3839",
      "",
    ].join("\n"),
  );
});

test("portal block has the order details without greeting or signature", () => {
  const block = buildPortalBlock({ ...ORDER, freightSeparate: false }, [{ quantity: 1, productName: "Sideline Elite 100", sku: "80044" }]);
  assert.equal(
    block,
    ["PO / Order: #1320", "", "Items:", "(1) Sideline Elite 100 80044", "", "Ship to:", "Brenda Peek", "756 Pegasus Lane", "League City TX 77573", "United States", "+1 702-204-3839"].join("\n"),
  );
});

test("mailto URL encodes subject and CRLF body and keeps the address readable", () => {
  const url = buildMailtoUrl("orders@modernflames.com", { subject: "New Order [#1320]", body: "Hello,\n\nLine & more" });
  assert.equal(url, "mailto:orders@modernflames.com?subject=New%20Order%20%5B%231320%5D&body=Hello%2C%0D%0A%0D%0ALine%20%26%20more");
});

test("nothing in a draft or portal block says the order is paid", () => {
  const items = [{ quantity: 1, productName: "Landscape Pro Multi 120''", sku: "LPM-12016" }];
  for (const s of SUPPLIER_SEED) {
    const draft = buildDraft(ORDER, items, s);
    assert.doesNotMatch(`${draft.subject}\n${draft.body}`, /\bpaid\b/i, s.id);
  }
  assert.doesNotMatch(buildPortalBlock(ORDER, items), /\bpaid\b/i);
});
