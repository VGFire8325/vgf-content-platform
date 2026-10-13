import { requireEnv } from "@/lib/env";

// Two senders, deliberately separate code paths (no shared helper), both
// over Resend's HTTP API with plain fetch:
//
//   - sendNotificationEmail: internal alerts to Brendan (and only Brendan).
//     Recipient and sender come from env vars; there's deliberately no `to`
//     parameter, so nothing in this codebase can use it to email a
//     manufacturer or a customer.
//   - sendSupplierEmail: the order email to a supplier, from the Very Good
//     Fireplaces address. The recipient is taken only from the supplier row
//     passed in (suppliers.order_email), never from a parameter, and in test
//     mode (the default) it is replaced by ORDER_NOTIFY_TO.

export interface NotificationEmail {
  subject: string;
  text: string;
}

export type SendNotification = (email: NotificationEmail) => Promise<void>;

export const sendNotificationEmail: SendNotification = async ({ subject, text }) => {
  const { RESEND_API_KEY, ORDER_NOTIFY_TO, ORDER_NOTIFY_FROM } = requireEnv("RESEND_API_KEY", "ORDER_NOTIFY_TO", "ORDER_NOTIFY_FROM");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: ORDER_NOTIFY_FROM,
      to: ORDER_NOTIFY_TO.split(",").map((s) => s.trim()).filter(Boolean),
      subject,
      text,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend error (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
};

export type SupplierEmailMode = "test" | "live";

// Only the exact value "live" (case-insensitive) emails real suppliers.
export function supplierEmailMode(): SupplierEmailMode {
  return process.env.SUPPLIER_EMAIL_MODE?.trim().toLowerCase() === "live" ? "live" : "test";
}

function addressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The fields of a suppliers row this needs (see src/lib/orders/suppliers.ts).
export interface SupplierRecipient {
  id: string;
  name: string;
  orderEmail: string | null;
  method: "email" | "portal";
  active: boolean;
}

export interface SupplierEmail {
  supplier: SupplierRecipient;
  subject: string;
  text: string;
  // Sent as Resend's Idempotency-Key, so a retried send of the same order
  // email within 24 hours is delivered at most once.
  idempotencyKey: string;
}

export interface SupplierEmailResult {
  mode: SupplierEmailMode;
  to: string[];
  subject: string;
  messageId: string | null;
}

export type SendSupplierEmail = (email: SupplierEmail) => Promise<SupplierEmailResult>;

export interface SupplierEmailConfig {
  mode: SupplierEmailMode;
  from: string;
  replyTo: string;
  bcc: string[];
  notifyTo: string[]; // ORDER_NOTIFY_TO, the only recipient in test mode
}

export interface ResendEmailBody {
  from: string;
  to: string[];
  bcc?: string[];
  reply_to: string;
  subject: string;
  text: string;
}

const PLAIN_ADDRESS = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

// Pure: decides exactly who receives a supplier email. Throws rather than
// sending anywhere unexpected: a portal or inactive supplier, or one
// without a valid order_email, is never emailed. In test mode the only
// recipient is ORDER_NOTIFY_TO, with no BCC.
export function buildSupplierEmailBody(email: SupplierEmail, config: SupplierEmailConfig): ResendEmailBody {
  const { supplier } = email;
  if (supplier.method !== "email") throw new Error(`Supplier ${supplier.id} is a ${supplier.method} supplier; it is never emailed`);
  if (!supplier.active) throw new Error(`Supplier ${supplier.id} is inactive; it is never emailed`);
  const supplierAddress = supplier.orderEmail?.trim() ?? "";
  if (!PLAIN_ADDRESS.test(supplierAddress)) throw new Error(`Supplier ${supplier.id} has no valid order_email`);

  if (config.mode === "test") {
    if (config.notifyTo.length === 0) throw new Error("ORDER_NOTIFY_TO is empty; test-mode supplier emails have nowhere to go");
    return {
      from: config.from,
      to: config.notifyTo,
      reply_to: config.replyTo,
      subject: `[TEST - would go to ${supplierAddress}] ${email.subject}`,
      text: email.text,
    };
  }
  const bcc = config.bcc.filter((b) => b.toLowerCase() !== supplierAddress.toLowerCase());
  return {
    from: config.from,
    to: [supplierAddress],
    ...(bcc.length > 0 ? { bcc } : {}),
    reply_to: config.replyTo,
    subject: email.subject,
    text: email.text,
  };
}

export function supplierEmailConfig(): SupplierEmailConfig {
  const mode = supplierEmailMode();
  const { SUPPLIER_EMAIL_FROM, SUPPLIER_EMAIL_REPLY_TO } = requireEnv("SUPPLIER_EMAIL_FROM", "SUPPLIER_EMAIL_REPLY_TO");
  const notifyTo = mode === "test" ? addressList(requireEnv("ORDER_NOTIFY_TO").ORDER_NOTIFY_TO) : [];
  return { mode, from: SUPPLIER_EMAIL_FROM, replyTo: SUPPLIER_EMAIL_REPLY_TO, bcc: addressList(process.env.SUPPLIER_EMAIL_BCC), notifyTo };
}

// Thrown when the supplier email certainly did not go out: a config
// problem caught before calling Resend, or Resend rejecting the request
// (4xx other than 409/429). Anything else thrown (network failure,
// timeout, 5xx, 409, 429) means it may or may not have been delivered, so
// a retry must reuse the same idempotency key.
export class SupplierEmailNotSentError extends Error {}

export const sendSupplierEmail: SendSupplierEmail = async (email) => {
  let body: ResendEmailBody;
  let apiKey: string;
  let mode: SupplierEmailMode;
  try {
    const config = supplierEmailConfig();
    mode = config.mode;
    body = buildSupplierEmailBody(email, config);
    apiKey = requireEnv("RESEND_API_KEY").RESEND_API_KEY;
  } catch (err) {
    throw new SupplierEmailNotSentError(err instanceof Error ? err.message : String(err));
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": email.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = `Resend error (HTTP ${response.status}): ${detail.slice(0, 300)}`;
    const definite = response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429;
    throw definite ? new SupplierEmailNotSentError(message) : new Error(message);
  }
  const json = (await response.json().catch(() => ({}))) as { id?: string };
  return { mode, to: body.to, subject: body.subject, messageId: json.id ?? null };
};
