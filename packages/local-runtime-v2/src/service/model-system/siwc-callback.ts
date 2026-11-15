import { createServer } from 'node:http';
import { createChatGptAuthorizationAttempt, parseChatGptAuthorizationCallback } from './siwc-authorization.js';
import type { ChatGptAuthorizationAttempt } from './siwc-authorization.js';

export interface ChatGptPendingLogin {
  readonly attempt: ChatGptAuthorizationAttempt;
  readonly completion: Promise<{ code: string; clientId: string }>;
  cancel(): void;
}

// The server listens before its URL is returned. It accepts at most one valid
// callback and does not include callback parameters in responses or logs.
export async function startChatGptCallback(options: {
  hostId: string;
  clientId?: string;
  idTokenHint?: string;
  loginHint?: string;
  promptConsent?: boolean;
  timeoutMs?: number;
}): Promise<ChatGptPendingLogin> {
  let attempt: ChatGptAuthorizationAttempt;
  let settled = false;
  let resolveCompletion: (value: { code: string; clientId: string }) => void;
  let rejectCompletion: (error: Error) => void;
  const completion = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (settled || request.method !== 'GET' || !request.url) { response.writeHead(400).end('Invalid request.'); return; }
    let url: URL;
    try { url = new URL(request.url, attempt.redirectUri); }
    catch { response.writeHead(400).end('Invalid request.'); return; }
    const states = url.searchParams.getAll('state');
    const acceptedState = url.origin === new URL(attempt.redirectUri).origin && url.pathname === '/auth/callback' && states.length === 1 && states[0] === attempt.state;
    if (acceptedState && url.searchParams.has('error') && url.searchParams.getAll('error').length === 1) {
      response.writeHead(400).end('Authorization was not completed. You may close this window.');
      finish(new Error('ChatGPT authorization was not completed.'));
      return;
    }
    try {
      const result = parseChatGptAuthorizationCallback(attempt, url.toString());
      response.writeHead(200).end('Authorization received. You may return to MiniMax Code.');
      finish(undefined, result);
    } catch { response.writeHead(400).end('Invalid authorization response.'); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 20;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Loopback listener is unavailable.'); }
  try { attempt = createChatGptAuthorizationAttempt({ ...options, port: address.port }); }
  catch (error) { server.close(); throw error; }
  const timeout = setTimeout(() => finish(new Error('ChatGPT authorization timed out.')), options.timeoutMs ?? 600_000);
  timeout.unref();
  function finish(error?: Error, result?: { code: string; clientId: string }) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    server.close();
    if (error) rejectCompletion(error);
    else if (result) resolveCompletion(result);
  }
  server.on('error', () => finish(new Error('ChatGPT loopback listener failed.')));
  return { attempt, completion, cancel: () => finish(new Error('ChatGPT authorization was cancelled.')) };
}
