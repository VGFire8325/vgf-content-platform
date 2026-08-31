import { classifyLinkedInError } from "./errors";

// LinkedIn Community Management API. Request/response shapes follow
// LinkedIn's public docs — this environment's own outbound proxy still
// blocks linkedin.com/api.linkedin.com (same restriction as Pinterest/
// Meta), but the OAuth callback has now been exercised for real from
// production, which is how the stale-version bug below was caught.
const API_BASE = "https://api.linkedin.com/rest";
const OAUTH_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const OAUTH_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

// LinkedIn versions its REST API by calendar month (YYYYMM), releases
// a new one monthly, and supports each for a minimum of ~12 months —
// this needs bumping periodically or calls start failing with a
// "Requested version ... is not active" error, not a code bug. That's
// exactly what took down the LinkedIn OAuth callback in production:
// "202506" had aged out. Bumped to "202606" here (mid-window, not the
// bleeding-edge release, so it doesn't flip straight to "nonexistent
// version" the month it's checked) — reconfirm this is still active
// the next time this bites, rather than assuming today's date means
// it's still fine.
const LINKEDIN_API_VERSION = "202606";

// w_organization_social/r_organization_social to create and read posts
// as the organization; rw_organization_admin to list which
// organizations this account administers (listAdministeredOrganizations
// below) so the OAuth callback can resolve the org URN to post as,
// mirroring how the Meta flow resolves which Page to post as.
export const LINKEDIN_SCOPES = "w_organization_social r_organization_social rw_organization_admin";

export function buildLinkedInAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", LINKEDIN_SCOPES);
  return url.toString();
}

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(body: URLSearchParams): Promise<LinkedInTokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyLinkedInError(response.status, json);
  }
  return json as LinkedInTokenResponse;
}

export function exchangeLinkedInCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
}

// Only returns a refresh_token in the token response if the app has
// been granted refresh-token access (part of what Community Management
// API approval includes) — the OAuth callback treats a missing
// refresh_token as "re-auth when the 60-day access token expires"
// rather than failing the connection outright.
export function refreshLinkedInToken(clientId: string, clientSecret: string, refreshToken: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
}

async function linkedInApiRequest<T>(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    throw classifyLinkedInError(response.status, json);
  }
  return response;
}

interface OrganizationAcl {
  organization: string; // URN, e.g. "urn:li:organization:12345"
}

async function getOrganizationName(accessToken: string, organizationUrn: string): Promise<string> {
  const id = organizationUrn.split(":").pop();
  const response = await linkedInApiRequest(accessToken, `/organizations/${id}`);
  const json = (await response.json()) as { localizedName?: string };
  return json.localizedName ?? organizationUrn;
}

export interface AdministeredOrganization {
  urn: string;
  name: string;
}

// One connecting account can administer multiple LinkedIn Pages —
// single-org assumption for V1 (same pattern as Meta's "first Page"),
// picked by the caller from this list.
export async function listAdministeredOrganizations(accessToken: string): Promise<AdministeredOrganization[]> {
  const response = await linkedInApiRequest(
    accessToken,
    "/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
  );
  const { elements } = (await response.json()) as { elements: OrganizationAcl[] };
  const organizations: AdministeredOrganization[] = [];
  for (const acl of elements) {
    const name = await getOrganizationName(accessToken, acl.organization);
    organizations.push({ urn: acl.organization, name });
  }
  return organizations;
}

// Images API: uploading a real photo to attach as the article's
// thumbnail is a separate two-step dance from creating the post itself
// — register the upload (get back a pre-signed URL + the urn:li:image
// id the post will reference), then PUT the raw bytes to that URL.
// That URL lives on LinkedIn's dms-uploads host, not api.linkedin.com,
// so it's a plain authenticated PUT, not routed through
// linkedInApiRequest (no LinkedIn-Version/Restli headers involved).
interface InitializeUploadResponse {
  value: { uploadUrl: string; image: string };
}

async function initializeImageUpload(accessToken: string, organizationUrn: string): Promise<InitializeUploadResponse["value"]> {
  const response = await linkedInApiRequest(accessToken, "/images?action=initializeUpload", {
    method: "POST",
    body: JSON.stringify({ initializeUploadRequest: { owner: organizationUrn } }),
  });
  const json = (await response.json()) as InitializeUploadResponse;
  return json.value;
}

// Returns the urn:li:image:{id} to reference as content.article.thumbnail
// on the post created right after this.
export async function uploadLinkedInImage(
  accessToken: string,
  organizationUrn: string,
  imageBytes: Buffer,
  contentType: string,
): Promise<string> {
  const { uploadUrl, image } = await initializeImageUpload(accessToken, organizationUrn);
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType },
    body: new Uint8Array(imageBytes),
  });
  if (!uploadResponse.ok) {
    throw new Error(`LinkedIn image upload failed: ${uploadResponse.status}`);
  }
  return image;
}

export interface CreateOrganizationPostInput {
  text: string;
  link: string;
  linkTitle: string;
  // Optional because a post can still go out as a plain link card
  // without one — unlike Pinterest/Instagram, a LinkedIn post is
  // complete without an image, so callers degrade to no thumbnail
  // rather than blocking the publish on a missing asset.
  thumbnail?: string;
  thumbnailAltText?: string;
}

export interface CreateOrganizationPostResult {
  id: string;
  url: string;
}

// The Posts API returns the created post's URN in the x-restli-id
// response header on a 201 — not in the JSON body, which is empty.
// This is LinkedIn's documented contract for this endpoint, not an
// oversight in how the response is read here.
export async function createOrganizationPost(
  accessToken: string,
  organizationUrn: string,
  input: CreateOrganizationPostInput,
): Promise<CreateOrganizationPostResult> {
  const response = await linkedInApiRequest(accessToken, "/posts", {
    method: "POST",
    body: JSON.stringify({
      author: organizationUrn,
      commentary: input.text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: input.link,
          title: input.linkTitle,
          // LinkedIn's Posts API does not scrape the URL for a
          // thumbnail the way the old share API did — omitting this
          // is exactly why the first live post went out as a bare
          // title+domain card with no image.
          ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
          ...(input.thumbnailAltText ? { thumbnailAltText: input.thumbnailAltText } : {}),
        },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  const id = response.headers.get("x-restli-id");
  if (!id) {
    throw new Error("LinkedIn post created but no x-restli-id header was returned");
  }
  return { id, url: `https://www.linkedin.com/feed/update/${id}/` };
}
