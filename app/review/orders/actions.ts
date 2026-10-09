"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import {
  assignItemSupplier,
  markConfirmed,
  markSupplierSent,
  markSupplierUnsent,
  setFreight,
  setTrackingNumber,
} from "@/lib/orders/service";

// Manual status buttons for the orders page. These only record what
// Brendan did — nothing here sends email to anyone.
//
// Hooks for later (not built yet):
//   - Manufacturer reply parsing → call markConfirmed / setTrackingNumber
//     from an inbound-email handler instead of these buttons.
//   - Pushing tracking to Shopify (fulfillmentCreate) after
//     setTrackingNumber; needs the write_fulfillments scope.
//   - Exceptions (freight quote needing approval, carrier can't reach the
//     customer, item out of stock, customer cancels) → openAlert() from
//     src/lib/alerts.ts with keys like order_freight_quote_<n>, and set
//     status needs_attention.

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

export async function toggleConfirmedAction(formData: FormData) {
  await markConfirmed(db, requireString(formData, "orderId"), formData.get("confirmed") === "true");
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
