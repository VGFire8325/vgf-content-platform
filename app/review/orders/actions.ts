"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import {
  assignItemSupplier,
  markStockConfirmed,
  markSupplierSent,
  markSupplierUnsent,
  setFreight,
  setManufacturerReply,
  setTrackingNumber,
} from "@/lib/orders/service";

// Manual status buttons for the orders page. These only record what
// Brendan did — nothing here sends email to anyone.
//
// Hooks for later (not built yet):
//   - Manufacturer reply parsing → call markStockConfirmed /
//     setManufacturerReply / setTrackingNumber from an inbound-email
//     handler instead of these buttons.
//   - Pushing tracking to Shopify (fulfillmentCreate) after
//     setTrackingNumber; needs the write_fulfillments scope.
//   - Exceptions (carrier can't reach the customer, item out of stock) →
//     openAlert() from src/lib/alerts.ts with keys like
//     order_out_of_stock_<n>. Freight approval is the needs_approval
//     flag below; customer cancellation arrives via the orders/cancelled
//     webhook.

const ORDERS_PATH = "/review/orders";

function requireString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required field '${key}'`);
  }
  return value;
}

// "" in the form means the unmatched-vendor group (supplier_id null).
function supplierIdOrNull(formData: FormData): string | null {
  const value = formData.get("supplierId");
  return typeof value === "string" && value ? value : null;
}

export async function markSentAction(formData: FormData) {
  await markSupplierSent(db, requireString(formData, "orderId"), supplierIdOrNull(formData));
  revalidatePath(ORDERS_PATH);
}

export async function undoSentAction(formData: FormData) {
  await markSupplierUnsent(db, requireString(formData, "orderId"), supplierIdOrNull(formData));
  revalidatePath(ORDERS_PATH);
}

export async function toggleStockConfirmedAction(formData: FormData) {
  await markStockConfirmed(db, requireString(formData, "orderId"), formData.get("confirmed") === "true");
  revalidatePath(ORDERS_PATH);
}

export async function saveManufacturerReplyAction(formData: FormData) {
  const reply = formData.get("manufacturerReply");
  await setManufacturerReply(
    db,
    requireString(formData, "orderId"),
    typeof reply === "string" ? reply : null,
    formData.get("needsApproval") === "on",
  );
  revalidatePath(ORDERS_PATH);
}

export async function saveTrackingAction(formData: FormData) {
  const tracking = formData.get("trackingNumber");
  await setTrackingNumber(db, requireString(formData, "orderId"), typeof tracking === "string" ? tracking : "");
  revalidatePath(ORDERS_PATH);
}

// Saving the freight checkbox is what "regenerates" the draft: drafts are
// built from the order row on every page render, never stored.
export async function saveFreightAction(formData: FormData) {
  const note = formData.get("freightNote");
  await setFreight(db, requireString(formData, "orderId"), formData.get("freightSeparate") === "on", typeof note === "string" ? note : null);
  revalidatePath(ORDERS_PATH);
}

export async function assignSupplierAction(formData: FormData) {
  await assignItemSupplier(db, requireString(formData, "itemId"), requireString(formData, "supplierId"));
  revalidatePath(ORDERS_PATH);
}
