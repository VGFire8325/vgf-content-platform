import { classifyMetaError, PlatformValidationError } from "./errors";

// Meta Graph API (Facebook Pages + Instagram). Request/response shapes
// follow Meta's public docs; not exercised against a live call in this
// environment (the outbound proxy blocks graph.facebook.com by policy)
// — see errors.ts for the HTTP-400-is-not-always-a-validation-error
// quirk this client has to account for.
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const OAUTH_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// pages_manage_posts/pages_read_engagement/pages_show_list for Facebook
// Page posting; instagram_basic/instagram_content_publish for the
// Instagram carousel container/publish flow below.
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

async function graphPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyMetaError(response.status, json);
  }
  return json as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const { id } = await graphPost<{ id: string }>(`/${pageId}/feed`, {
    message: input.message,
    link: input.link,
    access_token: pageAccessToken,
  });
  return { id, url: `https://www.facebook.com/${id}` };
}

// --- Instagram carousel publishing ---
//
// The Graph API's content-publishing flow is three steps, not one: (1)
// create a media *container* per image (async — Instagram fetches and
// processes the image server-side), (2) once every child container has
// finished processing, create a parent container of media_type=CAROUSEL
// referencing them, (3) publish that parent container. A single-image
// post is the same flow minus step 2. See
// https://developers.facebook.com/docs/instagram-platform/content-publishing

type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

async function createMediaContainer(
  pageAccessToken: string,
  igUserId: string,
  input: { imageUrl: string; isCarouselItem?: boolean; caption?: string },
): Promise<{ id: string }> {
  const body: Record<string, string> = { image_url: input.imageUrl, access_token: pageAccessToken };
  if (input.isCarouselItem) body.is_carousel_item = "true";
  if (input.caption) body.caption = input.caption;
  return graphPost<{ id: string }>(`/${igUserId}/media`, body);
}

async function createCarouselContainer(
  pageAccessToken: string,
  igUserId: string,
  input: { caption: string; childrenIds: string[] },
): Promise<{ id: string }> {
  return graphPost<{ id: string }>(`/${igUserId}/media`, {
    media_type: "CAROUSEL",
    caption: input.caption,
    children: input.childrenIds.join(","),
    access_token: pageAccessToken,
  });
}

async function getContainerStatus(pageAccessToken: string, containerId: string): Promise<ContainerStatus> {
  const { status_code } = await graphGet<{ status_code: ContainerStatus }>(`/${containerId}`, {
    fields: "status_code",
    access_token: pageAccessToken,
  });
  return status_code;
}

// Polls a container until Instagram finishes processing the image
// (typically a few seconds). Publishing before FINISHED reliably fails,
// so this is not optional — but it's a short, bounded wait, not a
// background job, since containers are per-image and process fast.
async function waitForContainerReady(
  pageAccessToken: string,
  containerId: string,
  { maxAttempts = 10, delayMs = 1500 }: { maxAttempts?: number; delayMs?: number } = {},
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getContainerStatus(pageAccessToken, containerId);
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new PlatformValidationError(`Instagram media container ${containerId} failed to process (status=${status})`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Instagram media container ${containerId} did not finish processing in time`); // retryable — likely transient
}

async function publishMediaContainer(pageAccessToken: string, igUserId: string, creationId: string): Promise<{ id: string }> {
  return graphPost<{ id: string }>(`/${igUserId}/media_publish`, { creation_id: creationId, access_token: pageAccessToken });
}

async function getMediaPermalink(pageAccessToken: string, mediaId: string): Promise<string> {
  const { permalink } = await graphGet<{ permalink: string }>(`/${mediaId}`, {
    fields: "permalink",
    access_token: pageAccessToken,
  });
  return permalink;
}

export interface CreateInstagramCarouselInput {
  caption: string;
  imageUrls: string[];
}

export interface CreateInstagramCarouselResult {
  id: string;
  url: string;
}

// Orchestrates the full three-step flow above for a multi-slide
// carousel. Children are created and confirmed ready sequentially
// (not in parallel) so a mid-carousel failure doesn't leave orphaned
// containers racing an already-thrown error.
export async function createInstagramCarousel(
  pageAccessToken: string,
  igUserId: string,
  input: CreateInstagramCarouselInput,
): Promise<CreateInstagramCarouselResult> {
  if (input.imageUrls.length < 2) {
    throw new PlatformValidationError("Instagram carousel needs at least 2 images");
  }

  const childrenIds: string[] = [];
  for (const imageUrl of input.imageUrls) {
    const container = await createMediaContainer(pageAccessToken, igUserId, { imageUrl, isCarouselItem: true });
    await waitForContainerReady(pageAccessToken, container.id);
    childrenIds.push(container.id);
  }

  const carousel = await createCarouselContainer(pageAccessToken, igUserId, { caption: input.caption, childrenIds });
  await waitForContainerReady(pageAccessToken, carousel.id);

  const published = await publishMediaContainer(pageAccessToken, igUserId, carousel.id);
  const url = await getMediaPermalink(pageAccessToken, published.id);
  return { id: published.id, url };
}
