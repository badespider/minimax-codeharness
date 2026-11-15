import { createHash, randomBytes } from 'node:crypto';

// The browser callback is bound to one authorization attempt. This module does
// not store credentials, exchange codes, or enable the provider by itself.
const AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const NEW_CLIENT = 'dynamic_agent_client';

export interface ChatGptAuthorizationAttempt {
  readonly url: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly clientId?: string;
}

export function createChatGptAuthorizationAttempt(options: {
  port: number;
  hostId: string;
  clientId?: string;
  idTokenHint?: string;
  loginHint?: string;
  promptConsent?: boolean;
}): ChatGptAuthorizationAttempt {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('A listening loopback port is required.');
  }
  if (!options.hostId.trim()) throw new Error('A stable host ID is required.');
  if (options.clientId === NEW_CLIENT || options.clientId === '') throw new Error('Invalid client ID.');
  if (!options.clientId && (options.idTokenHint || options.loginHint)) {
    throw new Error('Account hints require a registered client.');
  }
  if (!options.clientId && options.promptConsent) throw new Error('Reconsent requires a registered client.');
  const redirectUri = `http://127.0.0.1:${options.port}/auth/callback`;
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(AUTHORIZATION_ENDPOINT);
  const params: Record<string, string> = {
    client_id: options.clientId ?? NEW_CLIENT,
    ext_agent_host_id: options.hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  };
  if (!options.clientId) params.agent_name_hint = 'MiniMax Code';
  if (options.idTokenHint) params.id_token_hint = options.idTokenHint;
  if (options.loginHint) params.login_hint = options.loginHint;
  if (options.promptConsent) params.prompt = 'consent';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), redirectUri, state, nonce, verifier, clientId: options.clientId };
}

export function parseChatGptAuthorizationCallback(
  attempt: ChatGptAuthorizationAttempt,
  callbackUrl: string,
): { code: string; clientId: string } {
  const url = new URL(callbackUrl);
  const expected = new URL(attempt.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash) {
    throw new Error('Unexpected authorization callback.');
  }
  for (const name of ['state', 'code', 'client_id', 'error']) {
    if (url.searchParams.getAll(name).length > 1) throw new Error('Ambiguous authorization callback.');
  }
  if (url.searchParams.get('state') !== attempt.state) throw new Error('Authorization state mismatch.');
  if (url.searchParams.has('error')) throw new Error('Authorization was not completed.');
  const code = url.searchParams.get('code');
  const returnedClientId = url.searchParams.get('client_id');
  if (attempt.clientId && returnedClientId && returnedClientId !== attempt.clientId) {
    throw new Error('Authorization client mismatch.');
  }
  const clientId = attempt.clientId ?? returnedClientId;
  if (!code || !clientId || clientId === NEW_CLIENT) throw new Error('Incomplete authorization callback.');
  return { code, clientId };
}
