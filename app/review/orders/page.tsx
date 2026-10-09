import { desc, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { orderItems, orders, suppliers } from "@/db/schema";
import { buildDraft, buildMailtoUrl, buildPortalBlock, draftSubject } from "@/lib/orders/draft";
import { groupItemsBySupplier, isOverdueUnsent } from "@/lib/orders/status";
import type { Supplier } from "@/lib/orders/suppliers";
import {
  assignSupplierAction,
  markSentAction,
  saveFreightAction,
  saveTrackingAction,
  toggleConfirmedAction,
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
  const overdue = isOverdueUnsent(order, now);
  return (
    <article className="item-card" id={`order-${order.orderNumber}`}>
      <header>
        <strong>#{order.orderNumber}</strong>
        <span className={`status status-${order.status}`}>{order.status.replace("_", " ")}</span>
        <span>{order.customerName}</span>
        <span className="scheduled-time">Paid {formatTime(order.paidAt)}</span>
      </header>
      {overdue ? <div className="flag-error">Paid more than 24 hours ago and not marked sent.</div> : null}

      <form action={saveFreightAction} className="inline-form">
        <input type="hidden" name="orderId" value={order.id} />
        <label>
          <input type="checkbox" name="freightSeparate" defaultChecked={order.freightSeparate} /> Freight billed separately (adds a freight line to the draft)
        </label>{" "}
        <input type="text" name="freightNote" placeholder="Freight note (e.g. quoted $395, approved)" defaultValue={order.freightNote ?? ""} />{" "}
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

      <div className="draft-actions">
        <form action={toggleConfirmedAction} className="inline-form">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="hidden" name="confirmed" value={order.confirmedAt ? "false" : "true"} />
          {order.confirmedAt ? <span className="sent-note">Confirmed {formatTime(order.confirmedAt)}</span> : null}{" "}
          <button type="submit">{order.confirmedAt ? "Undo confirmed" : "Mark Confirmed"}</button>
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
  const orderRows = await db.select().from(orders).orderBy(desc(orders.paidAt)).limit(ORDER_LIMIT);
  const itemRows =
    orderRows.length > 0 ? await db.select().from(orderItems).where(inArray(orderItems.orderId, orderRows.map((o) => o.id))) : [];
  const supplierList = await db.select().from(suppliers).orderBy(suppliers.name);
  const now = new Date();

  const open = orderRows.filter((o) => o.status !== "shipped");
  const done = orderRows.filter((o) => o.status === "shipped");
  const itemsFor = (orderId: string) => itemRows.filter((i) => i.orderId === orderId);

  return (
    <main>
      <h1>Orders</h1>
      <p>
        <a href="/review">Review Queue</a>
        {" · "}
        <a href="/scheduled">View Scheduled</a>
      </p>
      <p className="stub-note">
        Drafts are never sent automatically. Open each one in your email (or copy it), send it yourself, then click Mark Sent.
      </p>
      {open.length === 0 ? <p>No open orders.</p> : null}
      <div className="items">
        {open.map((order) => (
          <OrderCard key={order.id} order={order} items={itemsFor(order.id)} supplierList={supplierList} now={now} />
        ))}
      </div>
      {done.length > 0 ? (
        <details className="shipped-orders">
          <summary>Shipped ({done.length})</summary>
          <div className="items">
            {done.map((order) => (
              <OrderCard key={order.id} order={order} items={itemsFor(order.id)} supplierList={supplierList} now={now} />
            ))}
          </div>
        </details>
      ) : null}
    </main>
  );
}
