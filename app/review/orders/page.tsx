import { desc, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { orderItems, orders, suppliers } from "@/db/schema";
import { buildDraft, buildMailtoUrl, buildPortalBlock, draftSubject } from "@/lib/orders/draft";
import { groupItemsBySupplier, isAwaitingStockConfirmation, isOverdueUnsent } from "@/lib/orders/status";
import type { Supplier } from "@/lib/orders/suppliers";
import {
  assignSupplierAction,
  markSentAction,
  saveFreightAction,
  saveManufacturerReplyAction,
  saveTrackingAction,
  toggleStockConfirmedAction,
  undoSentAction,
} from "./actions";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

const ORDER_LIMIT = 100;

function formatTime(date: Date | null): string {
  return date ? date.toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" }) + " MT" : "";
}

function SentControls({
  order,
  supplierId,
  sentAt,
  label = "Mark Sent",
}: {
  order: OrderRow;
  supplierId: string | null;
  sentAt: Date | null;
  label?: string;
}) {
  if (sentAt) {
    return (
      <form action={undoSentAction} className="inline-form">
        <input type="hidden" name="orderId" value={order.id} />
        <input type="hidden" name="supplierId" value={supplierId ?? ""} />
        <span className="sent-note">Sent {formatTime(sentAt)}</span> <button type="submit">Undo</button>
      </form>
    );
  }
  return (
    <form action={markSentAction} className="inline-form">
      <input type="hidden" name="orderId" value={order.id} />
      <input type="hidden" name="supplierId" value={supplierId ?? ""} />
      <button type="submit" className="approve">{label}</button>
    </form>
  );
}

function SupplierDraft({ order, supplier, items }: { order: OrderRow; supplier: Supplier; items: OrderItemRow[] }) {
  const sentAt = items.every((i) => i.sentAt) ? (items[0]?.sentAt ?? null) : null;
  const isPortal = supplier.method === "portal" || !supplier.orderEmail;
  const draft = buildDraft(order, items, supplier);
  const portalBlock = buildPortalBlock(order, items);

  return (
    <div className="draft-block">
      <h3>
        {supplier.name}{" "}
        <span className="draft-to">{isPortal ? "(order in the dealer portal)" : `to ${supplier.orderEmail}`}</span>
      </h3>
      {supplier.notes ? <div className="flag-warning">{supplier.notes}</div> : null}
      {isPortal ? (
        <>
          <textarea readOnly value={portalBlock} rows={portalBlock.split("\n").length + 1} />
          <div className="draft-actions">
            <CopyButton text={portalBlock} label="Copy order details" />
            <SentControls order={order} supplierId={supplier.id} sentAt={sentAt} />
          </div>
        </>
      ) : (
        <>
          <div className="draft-subject">Subject: {draft.subject}</div>
          <textarea readOnly value={draft.body} rows={draft.body.split("\n").length + 1} />
          <div className="draft-actions">
            <a href={buildMailtoUrl(supplier.orderEmail!, draft)} className="button-link">Open in email</a>
            <CopyButton text={draft.body} label="Copy email body" />
            <CopyButton text={draftSubject(order.orderNumber)} label="Copy subject" />
            <SentControls order={order} supplierId={supplier.id} sentAt={sentAt} />
          </div>
        </>
      )}
    </div>
  );
}

function UnmatchedItems({ order, items, supplierList }: { order: OrderRow; items: OrderItemRow[]; supplierList: Supplier[] }) {
  const sentAt = items.every((i) => i.sentAt) ? (items[0]?.sentAt ?? null) : null;
  return (
    <div className="draft-block">
      <h3>No supplier match</h3>
      <div className="flag-warning">
        These items' Shopify vendor doesn't match any supplier. Assign a supplier to get a draft, or handle them yourself and mark them sent.
      </div>
      {items.map((item) => (
        <form action={assignSupplierAction} key={item.id} className="inline-form">
          <input type="hidden" name="itemId" value={item.id} />
          <span>
            ({item.quantity}) {item.productName} {item.sku ?? ""}: vendor "{item.vendor ?? ""}"
          </span>{" "}
          <select name="supplierId" defaultValue="">
            <option value="" disabled>Choose supplier…</option>
            {supplierList.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>{" "}
          <button type="submit">Assign</button>
        </form>
      ))}
      <SentControls order={order} supplierId={null} sentAt={sentAt} label="Handled myself: mark sent" />
    </div>
  );
}

function OrderCard({ order, items, supplierList, now }: { order: OrderRow; items: OrderItemRow[]; supplierList: Supplier[]; now: Date }) {
  const groups = groupItemsBySupplier(items);
  const cancelled = order.cancelledAt !== null;
  return (
    <article className="item-card" id={`order-${order.orderNumber}`}>
      <header>
        <strong>#{order.orderNumber}</strong>
        <span className={`status status-${order.status}`}>{order.status.replaceAll("_", " ")}</span>
        <span className={`status ${order.charged ? "badge-charged" : "badge-uncharged"}`}>
          {order.charged ? "Card charged" : "Card not charged yet"}
        </span>
        {order.needsApproval ? <span className="status badge-approval">Needs your approval</span> : null}
        <span>{order.customerName}</span>
        <span className="scheduled-time">Placed {formatTime(order.createdAtShopify)}</span>
      </header>
      {cancelled ? (
        <div className="flag-error">
          Cancelled in Shopify {formatTime(order.cancelledAt)}.
          {order.sentAt ? " The New Order email had already gone out: let the manufacturer know." : ""}
        </div>
      ) : null}
      {isOverdueUnsent(order, now) ? <div className="flag-error">Placed more than 24 hours ago and the New Order email isn't marked sent.</div> : null}
      {isAwaitingStockConfirmation(order, now) ? (
        <div className="flag-warning">Sent more than 72 hours ago and stock isn't confirmed yet. The customer is waiting.</div>
      ) : null}

      <form action={saveFreightAction} className="inline-form">
        <input type="hidden" name="orderId" value={order.id} />
        <label>
          <input type="checkbox" name="freightSeparate" defaultChecked={order.freightSeparate} /> Freight billed separately (adds a freight line to the draft)
        </label>{" "}
        <input type="text" name="freightNote" placeholder="Freight note" defaultValue={order.freightNote ?? ""} />{" "}
        <button type="submit">Save &amp; update draft</button>
      </form>

      {groups.map((group) => {
        const supplier = group.supplierId ? supplierList.find((s) => s.id === group.supplierId) : undefined;
        return supplier ? (
          <SupplierDraft key={group.supplierId} order={order} supplier={supplier} items={group.items} />
        ) : (
          <UnmatchedItems key="unmatched" order={order} items={group.items} supplierList={supplierList} />
        );
      })}

      <form action={saveManufacturerReplyAction} className="reply-form">
        <input type="hidden" name="orderId" value={order.id} />
        <label>
          <span>Manufacturer&apos;s reply (lead time, freight quote, substitutions)</span>
          <textarea name="manufacturerReply" rows={3} defaultValue={order.manufacturerReply ?? ""} />
        </label>
        <label>
          <input type="checkbox" name="needsApproval" defaultChecked={order.needsApproval} /> Needs my approval (e.g. a freight quote)
        </label>{" "}
        <button type="submit">Save reply</button>
      </form>

      <div className="draft-actions">
        <form action={toggleStockConfirmedAction} className="inline-form">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="hidden" name="confirmed" value={order.stockConfirmedAt ? "false" : "true"} />
          {order.stockConfirmedAt ? <span className="sent-note">Stock confirmed {formatTime(order.stockConfirmedAt)}</span> : null}{" "}
          <button type="submit">{order.stockConfirmedAt ? "Undo stock confirmed" : "Mark stock confirmed"}</button>
        </form>
        <form action={saveTrackingAction} className="inline-form">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="text" name="trackingNumber" placeholder="Tracking / PRO number" defaultValue={order.trackingNumber ?? ""} />{" "}
          <button type="submit">Save tracking</button>
        </form>
      </div>
    </article>
  );
}

export default async function OrdersPage() {
  const orderRows = await db.select().from(orders).orderBy(desc(orders.createdAtShopify)).limit(ORDER_LIMIT);
  const itemRows =
    orderRows.length > 0 ? await db.select().from(orderItems).where(inArray(orderItems.orderId, orderRows.map((o) => o.id))) : [];
  const supplierList = await db.select().from(suppliers).orderBy(suppliers.name);
  const now = new Date();

  const open = orderRows.filter((o) => o.status !== "shipped" && o.status !== "cancelled");
  const shipped = orderRows.filter((o) => o.status === "shipped");
  const cancelled = orderRows.filter((o) => o.status === "cancelled");
  const itemsFor = (orderId: string) => itemRows.filter((i) => i.orderId === orderId);
  const card = (order: OrderRow) => <OrderCard key={order.id} order={order} items={itemsFor(order.id)} supplierList={supplierList} now={now} />;

  return (
    <main>
      <h1>Orders</h1>
      <p>
        <a href="/review">Review Queue</a>
        {" · "}
        <a href="/scheduled">View Scheduled</a>
      </p>
      <p className="stub-note">
        Drafts are never sent automatically. Open each one in your email (or copy it), send it yourself, then click Mark Sent. Charge the
        card in Shopify once the manufacturer confirms stock.
      </p>
      {open.length === 0 ? <p>No open orders.</p> : null}
      <div className="items">{open.map(card)}</div>
      {shipped.length > 0 ? (
        <details className="shipped-orders">
          <summary>Shipped ({shipped.length})</summary>
          <div className="items">{shipped.map(card)}</div>
        </details>
      ) : null}
      {cancelled.length > 0 ? (
        <details className="shipped-orders">
          <summary>Cancelled ({cancelled.length})</summary>
          <div className="items">{cancelled.map(card)}</div>
        </details>
      ) : null}
    </main>
  );
}
