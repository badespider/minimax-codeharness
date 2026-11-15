import type { ChatGptAuthorizationAttempt } from './siwc-authorization.js';

const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';

export interface ChatGptIdentity { readonly subject: string; readonly email?: string }
export interface ChatGptTokenSet {
  readonly clientId: string;
  readonly identity: ChatGptIdentity;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}
export type ChatGptAuthorizationResult =
  | { readonly state: 'connected'; readonly tokens: ChatGptTokenSet }
  | { readonly state: 'plan-disabled'; readonly clientId: string; readonly identity: ChatGptIdentity; readonly idToken: string; readonly scopes: readonly string[]; readonly refreshToken?: string };

export class ChatGptTokenError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status: number, retryable: boolean) {
    super(`ChatGPT token request failed (${code}).`);
    this.name = 'ChatGptTokenError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// The caller must use an issuer-pinned JWKS verifier, never a decoded-only JWT.
export type VerifyChatGptIdentity = (idToken: string, clientId: string, nonce: string) => Promise<ChatGptIdentity>;

async function tokenRequest(form: URLSearchParams, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new ChatGptTokenError('network_error', 0, true); }
  if (!response.ok) {
    let code = 'unknown_error';
    try {
      const body: unknown = await response.json();
      const error = (body && typeof body === 'object' && 'error' in body) ? body.error : undefined;
      if (typeof error === 'string' && ['invalid_grant', 'invalid_request', 'invalid_client', 'invalid_scope', 'unauthorized_client', 'access_denied', 'temporarily_unavailable', 'server_error', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error)) code = error;
    } catch { /* Never include response contents in the error. */ }
    throw new ChatGptTokenError(code, response.status, response.status === 429 || response.status >= 500 || code === 'temporarily_unavailable' || code === 'server_error');
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Invalid token response.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid token response.');
  return payload as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Incomplete token response.');
  return value;
}

function parseTokenResponse(payload: Record<string, unknown>, now: number, priorScopes?: readonly string[]) {
  const tokenType = requiredString(payload.token_type);
  if (tokenType.toLowerCase() !== 'bearer') throw new Error('Unsupported token type.');
  const accessToken = requiredString(payload.access_token);
  const refreshToken = requiredString(payload.refresh_token);
  const seconds = payload.expires_in;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid token expiry.');
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : priorScopes;
  if (!scopes?.includes(DIRECT_SCOPE)) throw new Error('ChatGPT plan usage permission was not granted.');
  return { accessToken, refreshToken, scopes, expiresAt: now + seconds * 1000 };
}

export async function exchangeChatGptAuthorization(options: {
  attempt: ChatGptAuthorizationAttempt;
  code: string;
  clientId: string;
  verifyIdentity: VerifyChatGptIdentity;
  expectedSubject?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ChatGptAuthorizationResult> {
  if (!options.code || !options.clientId || options.clientId === 'dynamic_agent_client') throw new Error('Invalid authorization result.');
  if (options.attempt.clientId && options.attempt.clientId !== options.clientId) throw new Error('Authorization client mismatch.');
  const payload = await tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code', client_id: options.clientId, code: options.code,
    code_verifier: options.attempt.verifier, redirect_uri: options.attempt.redirectUri, resource: RESOURCE,
  }), options.fetchImpl ?? fetch);
  const idToken = requiredString(payload.id_token);
  const identity = await options.verifyIdentity(idToken, options.clientId, options.attempt.nonce);
  if (!identity.subject || (options.expectedSubject && options.expectedSubject !== identity.subject)) {
    throw new Error('ChatGPT account identity mismatch.');
  }
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes(DIRECT_SCOPE)) return {
    state: 'plan-disabled', clientId: options.clientId, identity, idToken, scopes,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.trim() ? { refreshToken: payload.refresh_token } : {}),
  };
  const tokens = parseTokenResponse(payload, options.now ?? Date.now());
  return { state: 'connected', tokens: { ...tokens, idToken, identity, clientId: options.clientId } };
}

// Call only while holding a cross-process lock for this client ID. The caller
// must atomically persist this complete replacement before releasing the lock.
export async function refreshChatGptTokens(options: {
  previous: ChatGptTokenSet;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ChatGptTokenSet> {
  const previous = options.previous;
  if (!previous.clientId || previous.clientId === 'dynamic_agent_client') throw new Error('Invalid registered client.');
  const payload = await tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token', client_id: previous.clientId,
    refresh_token: previous.refreshToken, resource: RESOURCE,
  }), options.fetchImpl ?? fetch);
  const tokens = parseTokenResponse(payload, options.now ?? Date.now(), previous.scopes);
  // Keep the previously validated identity token for reauthorization hints.
  return { ...previous, ...tokens };
}
