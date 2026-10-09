import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOrderStatus, groupItemsBySupplier, isOverdueUnsent, unsentAlertKey } from "./status";

const T = new Date("2026-11-27T12:00:00Z");
const none = { confirmedAt: null, trackingNumber: null };

test("status: unmatched or empty → needs_attention; otherwise draft_ready → sent → confirmed → shipped", () => {
  assert.equal(deriveOrderStatus([], none), "needs_attention");
  assert.equal(deriveOrderStatus([{ supplierId: null, sentAt: null }], none), "needs_attention");
  assert.equal(deriveOrderStatus([{ supplierId: null, sentAt: T }], none), "sent"); // handled manually
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: null }], none), "draft_ready");
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: T }, { supplierId: "b", sentAt: null }], none), "draft_ready");
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: T }], none), "sent");
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: T }], { confirmedAt: T, trackingNumber: null }), "confirmed");
  assert.equal(deriveOrderStatus([{ supplierId: "a", sentAt: T }], { confirmedAt: T, trackingNumber: "PRO 291" }), "shipped");
});

test("overdue only after 24 hours and only while unsent", () => {
  const paidAt = new Date(T.getTime() - 24 * 3_600_000);
  assert.equal(isOverdueUnsent({ paidAt, sentAt: null }, T), false); // exactly 24h
  assert.equal(isOverdueUnsent({ paidAt, sentAt: null }, new Date(T.getTime() + 1000)), true);
  assert.equal(isOverdueUnsent({ paidAt, sentAt: T }, new Date(T.getTime() + 3_600_000)), false);
});

test("alert key format", () => {
  assert.equal(unsentAlertKey("1322"), "order_unsent_1322");
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
