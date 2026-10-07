// Error classification for the retry/auth-renewal policy in
// docs/PHASE_0_PLAN.md §5. Pinterest's v5 API returns the auth-relevant
// HTTP status (401/403) directly. Meta's Graph API does not: most
// errors — including invalid/expired tokens — come back as HTTP 400
// with an `error.type`/`error.code` in the body, so status code alone
// is not a reliable signal there. This has not been verified against a
// live call in this environment (the outbound proxy blocks
// api.pinterest.com and graph.facebook.com by policy); the shapes below
// follow each platform's stable, documented error contract, and the
// classification is unit-tested against realistic fixtures instead.

export class PlatformAuthError extends Error {}
export class PlatformValidationError extends Error {}

// `context` (method + path, e.g. "POST /boards") is optional and purely
// cosmetic — added so a stored job/publish-target error actually says
// which call failed instead of just Pinterest's generic message (the
// real gap hit diagnosing the first live pin attempt on Standard
// access: "You are not permitted to access that resource" alone didn't
// say whether that was listing boards, creating one, or creating the
// pin). Omit it and behavior is identical to before.
export function classifyPinterestError(status: number, body: unknown, context?: string): Error {
  const base = extractMessage(body) ?? `Pinterest API error (HTTP ${status})`;
  // Pinterest's own numeric error code (e.g. 29 = "not permitted") is
  // only surfaced alongside `context` — bare classifyPinterestError
  // calls (unit tests, any caller not passing context) keep the exact
  // message text they always have.
  const code = context ? extractCode(body) : undefined;
  const withCode = code !== undefined ? `${base} [pinterest code ${code}]` : base;
  const message = context ? `${context}: ${withCode}` : base;
  if (status === 401 || status === 403) {
    return new PlatformAuthError(message);
  }
  if (status === 400 || status === 422) {
    return new PlatformValidationError(message);
  }
  return new Error(message); // 5xx/429/network — retryable per §5
}

// Meta Graph API OAuth error codes worth treating as "needs reconnect"
// rather than "bad request." 190 = invalid/expired access token; 102 =
// session key issue; 200s = permission-related.
const META_OAUTH_ERROR_CODES = new Set([190, 102]);

export function classifyMetaError(status: number, body: unknown): Error {
  const error = (body as { error?: { message?: string; type?: string; code?: number } } | null)?.error;
  const message = error?.message ?? `Meta Graph API error (HTTP ${status})`;

  if (status === 401 || status === 403) {
    return new PlatformAuthError(message);
  }
  if (error?.type === "OAuthException" || (error?.code !== undefined && META_OAUTH_ERROR_CODES.has(error.code))) {
    return new PlatformAuthError(message);
  }
  if (status === 400 || status === 422) {
    return new PlatformValidationError(message);
  }
  return new Error(message); // 5xx/429/network — retryable per §5
}

// LinkedIn's REST API returns the auth-relevant HTTP status (401/403)
// directly, same as Pinterest — no Meta-style buried-in-400 quirk here.
// Not verified against a live call in this environment (outbound
// proxy blocks linkedin.com by policy); shape follows LinkedIn's
// documented error contract.
export function classifyLinkedInError(status: number, body: unknown): Error {
  const message = extractMessage(body) ?? `LinkedIn API error (HTTP ${status})`;
  if (status === 401 || status === 403) {
    return new PlatformAuthError(message);
  }
  if (status === 400 || status === 422) {
    return new PlatformValidationError(message);
  }
  return new Error(message); // 5xx/429/network — retryable per §5
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return undefined;
}

function extractCode(body: unknown): number | undefined {
  if (body && typeof body === "object" && "code" in body && typeof (body as { code: unknown }).code === "number") {
    return (body as { code: number }).code;
  }
  return undefined;
}
