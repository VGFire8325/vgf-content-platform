import { classifyMetaError } from "./errors";

// Meta Graph API (Facebook Pages + Instagram). Request/response shapes
// follow Meta's public docs; not exercised against a live call in this
// environment (the outbound proxy blocks graph.facebook.com by policy)
// — see errors.ts for the HTTP-400-is-not-always-a-validation-error
// quirk this client has to account for.
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const OAUTH_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// pages_manage_posts/pages_read_engagement/pages_show_list for Facebook
// Page posting; instagram_basic/instagram_content_publish so the same
// connection covers Instagram once its publish handler exists.
export const META_SCOPES =
  "pages_manage_posts,pages_read_engagement,pages_show_list,instagram_basic,instagram_content_publish";

export function buildMetaAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", META_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString());
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyMetaError(response.status, json);
  }
  return json as T;
}

interface MetaTokenResponse {
  access_token: string;
  expires_in?: number;
}

export function exchangeMetaCode(appId: string, appSecret: string, code: string, redirectUri: string) {
  return graphGet<MetaTokenResponse>("/oauth/access_token", {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
}

// Meta's "refresh" isn't a refresh_token grant — a long-lived User token
// is re-exchanged for another long-lived one before it expires. Page
// tokens derived from a long-lived User token are effectively
// non-expiring in practice; this only matters if the underlying
// connection was revoked, in which case it correctly fails and falls
// into the §5 "mark expired, require reconnect" path rather than
// silently retrying forever.
export function refreshMetaUserToken(appId: string, appSecret: string, currentLongLivedToken: string) {
  return graphGet<MetaTokenResponse>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentLongLivedToken,
  });
}

export interface ConnectedPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
}

// One call gets every Page the connecting user administers, each with
// its own (long-lived, once the User token is) Page access token and,
// if linked, its Instagram Business Account ID — this is how one Meta
// OAuth flow produces both the facebook and instagram connections.
export async function listConnectedPages(userAccessToken: string): Promise<ConnectedPage[]> {
  const { data } = await graphGet<{ data: ConnectedPage[] }>("/me/accounts", {
    fields: "id,name,access_token,instagram_business_account",
    access_token: userAccessToken,
  });
  return data;
}

export interface CreatePagePostInput {
  message: string;
  link: string;
}

export interface CreatePagePostResult {
  id: string;
  url: string;
}

// Facebook Page posts don't need a custom-rendered image — a message +
// link is enough; Facebook generates the link preview from the
// article's own OG tags, which matches the brief's "light touch,
// roughly weekly" scope for this platform without needing a compositor.
export async function createPagePost(pageAccessToken: string, pageId: string, input: CreatePagePostInput): Promise<CreatePagePostResult> {
  const url = new URL(`${GRAPH_BASE}/${pageId}/feed`);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: input.message, link: input.link, access_token: pageAccessToken }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyMetaError(response.status, json);
  }
  const id = (json as { id: string }).id;
  return { id, url: `https://www.facebook.com/${id}` };
}
