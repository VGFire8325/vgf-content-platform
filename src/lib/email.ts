import { requireEnv } from "@/lib/env";

// Notification email to Brendan (and only Brendan) via Resend's HTTP API —
// plain fetch, no SDK dependency. Recipient and sender come from env vars;
// there's deliberately no `to` parameter, so nothing in this codebase can
// use it to email a manufacturer or a customer.

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
