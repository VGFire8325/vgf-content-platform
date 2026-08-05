import { classifyPinterestError } from "./errors";

// Pinterest API v5. Request/response shapes follow Pinterest's public
// docs; not exercised against a live call in this environment (the
// outbound proxy blocks api.pinterest.com by policy) — see errors.ts.
const API_BASE = "https://api.pinterest.com/v5";
const OAUTH_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
const OAUTH_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";

// pins:write / boards:read+write to create pins and resolve suggested
// board names to real board IDs; *_secret scopes so secret boards
// aren't silently excluded from the board search.
export const PINTEREST_SCOPES = "boards:read,boards:write,boards:read_secret,pins:read,pins:write,pins:read_secret";

export function buildPinterestAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

interface PinterestTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(clientId: string, clientSecret: string, body: URLSearchParams): Promise<PinterestTokenResponse> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw classifyPinterestError(response.status, json);
  }
  return json as PinterestTokenResponse;
}

export function exchangePinterestCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  return tokenRequest(
    clientId,
    clientSecret,
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  );
}

export function refreshPinterestToken(clientId: string, clientSecret: string, refreshToken: string) {
  return tokenRequest(
    clientId,
    clientSecret,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

async function pinterestApiRequest<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyPinterestError(response.status, json);
  }
  return json as T;
}

interface PinterestBoard {
  id: string;
  name: string;
}

// Resolves a generation-suggested board name (free text from the
// generation prompt, e.g. "Electric Fireplace Ideas") to a real board
// ID, creating the board on first use. Case-insensitive exact match —
// deliberately not fuzzy, so a near-miss creates a new board rather
// than silently posting to the wrong one.
export async function findOrCreateBoard(accessToken: string, boardName: string): Promise<string> {
  const { items } = await pinterestApiRequest<{ items: PinterestBoard[] }>(accessToken, "/boards?page_size=100");
  const existing = items.find((b) => b.name.toLowerCase() === boardName.toLowerCase());
  if (existing) {
    return existing.id;
  }
  const created = await pinterestApiRequest<PinterestBoard>(accessToken, "/boards", {
    method: "POST",
    body: JSON.stringify({ name: boardName }),
  });
  return created.id;
}

export interface CreatePinInput {
  title: string;
  description: string;
  link: string;
  boardId: string;
  imageUrl: string;
}

export interface CreatePinResult {
  id: string;
  url: string;
}

export async function createPin(accessToken: string, input: CreatePinInput): Promise<CreatePinResult> {
  const result = await pinterestApiRequest<{ id: string }>(accessToken, "/pins", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      link: input.link,
      board_id: input.boardId,
      media_source: { source_type: "image_url", url: input.imageUrl },
    }),
  });
  return { id: result.id, url: `https://www.pinterest.com/pin/${result.id}/` };
}
