import { classifyPinterestError } from "./errors";

// Pinterest rejects board names of 50+ characters with error code 96
// ("Name should be less than 50 characters") — 49 is the safe max.
const BOARD_NAME_MAX = 49;
// Fallback length used on a code-96 retry (see findOrCreateBoard) — well
// under BOARD_NAME_MAX so a second rejection would mean something else
// is wrong, not just length.
const BOARD_NAME_FALLBACK_MAX = 40;

// Trim, collapse internal whitespace, cut at the last word boundary at
// or before the max length (never mid-word), then drop any trailing
// punctuation a word-boundary cut can leave behind (e.g. "Builders &").
export function sanitizeBoardName(name: string, maxLength: number = BOARD_NAME_MAX): string {
  const collapsed = name.trim().replace(/\s+/g, " ");
  if (collapsed.length <= maxLength) {
    return stripTrailingPunctuation(collapsed);
  }
  const truncated = collapsed.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return stripTrailingPunctuation(cut);
}

function stripTrailingPunctuation(name: string): string {
  return name.replace(/[\s&,.;:-]+$/, "");
}

// Pinterest API v5. Request/response shapes follow Pinterest's public
// docs; not exercised against a live call in this environment (the
// outbound proxy blocks api.pinterest.com by policy) — see errors.ts.
const PRODUCTION_API_BASE = "https://api.pinterest.com/v5";
// Trial-access apps (the default until Pinterest approves Standard/
// production access) get a hard 403 from every pin-creation call
// against PRODUCTION_API_BASE — confirmed against a real publish
// attempt, not from docs. This lets pin/board calls target Pinterest's
// sandbox host instead, same OAuth token, so the app can produce a real
// demo pin for the access-request review while still on Trial access.
// PINTEREST_USE_SANDBOX is a manual, temporary toggle (unset/"false" by
// default) — leaving it on after Standard access is granted would
// silently keep routing real publishes to the sandbox instead of
// production.
const SANDBOX_API_BASE = "https://api-sandbox.pinterest.com/v5";
const OAUTH_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
const OAUTH_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";

function apiBase(): string {
  return process.env.PINTEREST_USE_SANDBOX === "true" ? SANDBOX_API_BASE : PRODUCTION_API_BASE;
}

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
    throw classifyPinterestError(response.status, json, "POST /oauth/token");
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
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw classifyPinterestError(response.status, json, `${init?.method ?? "GET"} ${path}`);
  }
  return json as T;
}

interface PinterestBoard {
  id: string;
  name: string;
  description?: string;
  privacy?: string; // "PUBLIC" | "SECRET" (Pinterest v5 board privacy)
}

// Resolves a generation-suggested board name (free text from the
// generation prompt, e.g. "Electric Fireplace Ideas") to a real board
// ID, creating the board on first use. Case-insensitive exact match —
// deliberately not fuzzy, so a near-miss creates a new board rather
// than silently posting to the wrong one. `privacy` only applies to
// creation (Pinterest defaults a new board to PUBLIC if omitted); an
// already-existing board's privacy is never changed here.
export async function findOrCreateBoard(
  accessToken: string,
  boardName: string,
  privacy?: "PUBLIC" | "SECRET",
): Promise<string> {
  const sanitized = sanitizeBoardName(boardName, BOARD_NAME_MAX);
  const { items } = await pinterestApiRequest<{ items: PinterestBoard[] }>(accessToken, "/boards?page_size=100");
  const existing = items.find((b) => sanitizeBoardName(b.name, BOARD_NAME_MAX).toLowerCase() === sanitized.toLowerCase());
  if (existing) {
    return existing.id;
  }
  try {
    const created = await pinterestApiRequest<PinterestBoard>(accessToken, "/boards", {
      method: "POST",
      body: JSON.stringify({ name: sanitized, ...(privacy ? { privacy } : {}) }),
    });
    return created.id;
  } catch (err) {
    // Code 96 ("Name should be less than 50 characters") shouldn't
    // happen after sanitizing above, but if it does (e.g. Pinterest
    // counting length differently for some characters), retry once with
    // a harder truncation instead of failing outright on the first hit —
    // only a second rejection is treated as genuinely terminal.
    const code = (err as { pinterestCode?: number }).pinterestCode;
    if (code !== 96) throw err;
    const fallbackName = sanitizeBoardName(sanitized, BOARD_NAME_FALLBACK_MAX);
    const created = await pinterestApiRequest<PinterestBoard>(accessToken, "/boards", {
      method: "POST",
      body: JSON.stringify({ name: fallbackName, ...(privacy ? { privacy } : {}) }),
    });
    return created.id;
  }
}

export interface CreatePinInput {
  title: string;
  description: string;
  altText: string;
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
      alt_text: input.altText,
      link: input.link,
      board_id: input.boardId,
      media_source: { source_type: "image_url", url: input.imageUrl },
    }),
  });
  return { id: result.id, url: `https://www.pinterest.com/pin/${result.id}/` };
}
