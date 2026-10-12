import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveOrderStatus,
  groupItemsBySupplier,
  isAwaitingStockConfirmation,
  isOverdueUnsent,
  STOCK_CONFIRMATION_ALERT_AFTER_MS,
  stockConfirmationAlertKey,
  UNSENT_ALERT_AFTER_MS,
  unsentAlertKey,
} from "./status";

const T = new Date("2026-11-27T12:00:00Z");
const HOUR = 3_600_000;
const base = { cancelledAt: null, stockConfirmedAt: null, charged: false, trackingNumber: null };
const sent = [{ supplierId: "a", sentAt: T }];

test("thresholds are 24 and 72 hours", () => {
  assert.equal(UNSENT_ALERT_AFTER_MS, 24 * HOUR);
  assert.equal(STOCK_CONFIRMATION_ALERT_AFTER_MS, 72 * HOUR);
});

test("status: needs_attention for empty/unmatched, draft_ready until every draft is sent", () => {
  assert.equal(deriveOrderStatus([], base), "needs_attention");
  assert.equal(deriveOrderStatus([{ supplierId: null, sentAt: null }], base), "needs_attention");
  assert.equal(deriveOrderStatus([{ supplierId: null, sentAt: T }], base), "sent"); // handled manually
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: null }], base), "draft_ready");
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: T }, { supplierId: "b", sentAt: null }], base), "draft_ready");
});

test("status: normal flow sent → stock_confirmed → charged → shipped", () => {
  assert.equal(deriveOrderStatus(sent, base), "sent");
  assert.equal(deriveOrderStatus(sent, { ...base, stockConfirmedAt: T }), "stock_confirmed");
  assert.equal(deriveOrderStatus(sent, { ...base, stockConfirmedAt: T, charged: true }), "charged");
  assert.equal(deriveOrderStatus(sent, { ...base, stockConfirmedAt: T, charged: true, trackingNumber: "PRO 291" }), "shipped");
});

test("status: a charged card doesn't hide an unsent draft; cancelled wins over everything", () => {
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: null }], { ...base, charged: true }), "draft_ready");
  assert.equal(deriveOrderStatus(sent, { ...base, charged: true, trackingNumber: "X", cancelledAt: T }), "cancelled");
  assert.equal(deriveOrderStatus([], { ...base, cancelledAt: T }), "cancelled");
});

test("unsent alert: clock starts at Shopify creation, stops when sent or cancelled", () => {
  const order = { createdAtShopify: new Date(T.getTime() - 24 * HOUR), sentAt: null, cancelledAt: null };
  assert.equal(isOverdueUnsent(order, T), false); // exactly 24h
  assert.equal(isOverdueUnsent(order, new Date(T.getTime() + 1000)), true);
  assert.equal(isOverdueUnsent({ ...order, sentAt: T }, new Date(T.getTime() + HOUR)), false);
  assert.equal(isOverdueUnsent({ ...order, cancelledAt: T }, new Date(T.getTime() + HOUR)), false);
});

test("stock-confirmation alert: 72h after sending, stops when confirmed or cancelled", () => {
  const order = { sentAt: T, stockConfirmedAt: null, cancelledAt: null };
  assert.equal(isAwaitingStockConfirmation(order, new Date(T.getTime() + 72 * HOUR)), false);
  assert.equal(isAwaitingStockConfirmation(order, new Date(T.getTime() + 73 * HOUR)), true);
  assert.equal(isAwaitingStockConfirmation({ ...order, stockConfirmedAt: T }, new Date(T.getTime() + 73 * HOUR)), false);
  assert.equal(isAwaitingStockConfirmation({ ...order, cancelledAt: T }, new Date(T.getTime() + 73 * HOUR)), false);
  assert.equal(isAwaitingStockConfirmation({ ...order, sentAt: null }, new Date(T.getTime() + 999 * HOUR)), false);
});

test("alert key formats", () => {
  assert.equal(unsentAlertKey("1322"), "order_unsent_1322");
  assert.equal(stockConfirmationAlertKey("1322"), "order_unconfirmed_1322");
});

test("items group by supplier in first-seen order, unmatched as their own group", () => {
  const groups = groupItemsBySupplier([
    { id: 1, supplierId: "b" },
    { id: 2, supplierId: null },
    { id: 3, supplierId: "b" },
    { id: 4, supplierId: "a" },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.supplierId, g.items.map((i) => i.id)]),
    [["b", [1, 3]], [null, [2]], ["a", [4]]],
  );
});
