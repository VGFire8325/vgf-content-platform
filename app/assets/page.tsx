import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { assetLibrary } from "@/db/schema";
import { deleteAsset, updateAssetTags, uploadAsset } from "./actions";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const assets = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));

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
