import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { brandPolicies, platformConnections, platformEnum, shopifyConnection } from "@/db/schema";
import { PLATFORM_CONTENT_TYPES, POLICY_MODES, POLICY_MODE_LABELS, type PolicyMode } from "@/lib/policy";
import { updatePolicyMode } from "./actions";

export const dynamic = "force-dynamic";

const PLATFORM_LABELS: Record<(typeof platformEnum.enumValues)[number], string> = {
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
};

const EXPIRY_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function expiryNote(expiresAt: Date | null): string | null {
  if (!expiresAt) return null;
  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft < 0) return "expired";
  if (msLeft < EXPIRY_WARNING_WINDOW_MS) {
    const days = Math.max(1, Math.round(msLeft / (24 * 60 * 60 * 1000)));
    return `expires in ~${days} day${days === 1 ? "" : "s"}`;
  }
  return null;
}

export default async function ConnectionsPage() {
  const connections = await db.select().from(platformConnections);
  const connectionByPlatform = new Map(connections.map((c) => [c.platform, c]));

  const policies = await db.select().from(brandPolicies);
  const policyByPlatform = new Map(policies.map((p) => [p.platform, p]));

  const [shopify] = await db.select().from(shopifyConnection);

  return (
    <main>
      <h1>Connections &amp; Policy</h1>
      <p>
        <a href="/review">Review Queue</a>
        {" · "}
        <a href="/scheduled">Scheduled</a>
        {" · "}
        <a href="/assets">Asset Library</a>
      </p>

      <section>
        <h2>Connections</h2>
        <div className="items">
          <article className="item-card">
            <header>
              <span className="platform">Shopify</span>
              <span className={`status status-${shopify ? "connected" : "not_connected"}`}>
                {shopify ? "connected" : "not connected"}
              </span>
            </header>
            <div className="item-body">
              {shopify ? (
                <p>{shopify.shopDomain} — ingestion source, not a publish destination (no policy row).</p>
              ) : (
                <p>
                  <a href="/api/oauth/shopify/start">Connect Shopify</a>
                </p>
              )}
            </div>
          </article>

          {platformEnum.enumValues.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            const note = connection ? expiryNote(connection.expiresAt) : null;
            return (
              <article key={platform} className="item-card">
                <header>
                  <span className="platform">{PLATFORM_LABELS[platform]}</span>
                  <span className={`status status-${connection ? connection.status : "not_connected"}`}>
                    {connection ? connection.status : "not connected"}
                  </span>
                  {note && <span className="scheduled-time">{note}</span>}
                </header>
                <div className="item-body">
                  {connection ? (
                    <p>
                      {connection.displayName}
                      {connection.status !== "connected" && (
                        <>
                          {" — "}
                          <a href={`/api/oauth/${platform}/start`}>Reconnect</a>
                        </>
                      )}
                    </p>
                  ) : (
                    <p>
                      <a href={`/api/oauth/${platform}/start`}>Connect {PLATFORM_LABELS[platform]}</a>
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Publish Policy</h2>
        <p className="policy-caveat">
          Only <strong>Manual</strong> is functional today: every approved item still waits for an explicit
          approve in the Review Queue before it schedules. Setting a platform to Trusted or Autonomous below
          records the intent, but nothing in the publish pipeline reads it yet — it will not start
          auto-publishing anything. Treat this as staging a decision, not flipping a switch, until that
          enforcement is built.
        </p>
        <div className="items">
          {platformEnum.enumValues.map((platform) => {
            const contentType = PLATFORM_CONTENT_TYPES[platform];
            const currentMode: PolicyMode = policyByPlatform.get(platform)?.mode ?? "manual";
            return (
              <article key={platform} className="item-card">
                <header>
                  <span className="platform">{PLATFORM_LABELS[platform]}</span>
                  <span className={`status status-policy-${currentMode}`}>{currentMode}</span>
                </header>
                <div className="item-body">
                  <form action={updatePolicyMode} className="policy-form">
                    <input type="hidden" name="platform" value={platform} />
                    <input type="hidden" name="contentType" value={contentType} />
                    {POLICY_MODES.map((mode) => (
                      <label key={mode} className="policy-option">
                        <input type="radio" name="mode" value={mode} defaultChecked={mode === currentMode} />
                        <span>{POLICY_MODE_LABELS[mode]}</span>
                      </label>
                    ))}
                    <button type="submit">Save</button>
                  </form>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
