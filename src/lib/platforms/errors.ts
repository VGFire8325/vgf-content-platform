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

export function classifyPinterestError(status: number, body: unknown): Error {
  const message = extractMessage(body) ?? `Pinterest API error (HTTP ${status})`;
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

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return undefined;
}
