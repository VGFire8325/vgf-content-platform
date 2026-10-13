import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { ASSET_ROOMS, ASSET_SETTINGS } from "@/db/asset-vocab";
import { assetLibrary } from "@/db/schema";
import { deleteAsset, updateAssetTags, uploadAsset } from "./actions";

export const dynamic = "force-dynamic";

// "untagged" is a filter value, not a stored one: rows the tagging pass
// hasn't reached yet have setting = null.
const UNTAGGED = "untagged";

function filterFor(column: typeof assetLibrary.setting | typeof assetLibrary.room, value: string | undefined, allowed: readonly string[]): SQL | undefined {
  if (value === UNTAGGED) return isNull(column);
  return value && allowed.includes(value) ? eq(column, value) : undefined;
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ setting?: string; room?: string }> }) {
  const { setting, room } = await searchParams;
  const assets = await db
    .select()
    .from(assetLibrary)
    .where(and(filterFor(assetLibrary.setting, setting, ASSET_SETTINGS), filterFor(assetLibrary.room, room, ASSET_ROOMS)))
    .orderBy(desc(assetLibrary.uploadedAt));

  return (
    <main>
      <h1>Asset Library</h1>
      <p>
        <a href="/review">Back to Review Queue</a>
        {" · "}
        <a href="/scheduled">View Scheduled</a>
        {" · "}
        <a href="/connections">Connections &amp; Policy</a>
      </p>

      <section className="upload-section">
        <h2>Upload a new photo</h2>
        <form action={uploadAsset} className="upload-form">
          <label>
            <span>Image file</span>
            <input type="file" name="file" accept="image/*" required />
          </label>
          <label>
            <span>Tags (comma-separated — e.g. Installation, Wall-Mount, Living Room)</span>
            <input type="text" name="tags" placeholder="Installation, Wall-Mount, Living Room" />
          </label>
          <label>
            <span>Notes (optional)</span>
            <input type="text" name="notes" placeholder="e.g. Client install photo, Denver project" />
          </label>
          <button type="submit">Upload</button>
        </form>
      </section>

      <form method="get" className="asset-filters">
        <label>
          <span>Setting</span>
          <select name="setting" defaultValue={setting ?? ""}>
            <option value="">Any</option>
            {ASSET_SETTINGS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={UNTAGGED}>not tagged yet</option>
          </select>
        </label>
        <label>
          <span>Room</span>
          <select name="room" defaultValue={room ?? ""}>
            <option value="">Any</option>
            {ASSET_ROOMS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value={UNTAGGED}>not tagged yet</option>
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>

      <h2>{assets.length} asset{assets.length === 1 ? "" : "s"}</h2>
      {assets.length === 0 ? (
        <p>Nothing in the asset library yet.</p>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <article key={asset.id} className="asset-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={asset.fileUrl} alt="" className="asset-thumb" />
              <div className="asset-body">
                <span className={`source-badge source-${asset.source}`}>
                  {asset.source === "shopify_product" ? "Shopify" : "Manual upload"}
                </span>
                {asset.setting && (
                  <p className="asset-tagging">
                    {[asset.setting, asset.room, asset.quality ? `quality ${asset.quality}` : null, asset.featuredOk ? "featured ok" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {asset.notes && <p className="asset-notes">{asset.notes}</p>}
                <form action={updateAssetTags} className="tags-form">
                  <input type="hidden" name="id" value={asset.id} />
                  <input type="text" name="tags" defaultValue={asset.tags.join(", ")} />
                  <button type="submit">Save tags</button>
                </form>
                <form action={deleteAsset}>
                  <input type="hidden" name="id" value={asset.id} />
                  <button type="submit" className="delete">Delete</button>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
