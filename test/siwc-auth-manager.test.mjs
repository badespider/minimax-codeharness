import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSiwcAuthManager } from '../packages/local-runtime-v2/src/service/model-system/siwc-auth-manager.ts';
import { ChatGptTokenError, exchangeChatGptAuthorization } from '../packages/local-runtime-v2/src/service/model-system/siwc-token.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture() {
  let snapshot = { revision: 'one', hostId: 'urn:uuid:test' };
  let tokens;
  let savedIdentity;
  let writes = 0;
  let tail = Promise.resolve();
  const callback = deferred();
  const remembered = [];
  const profiles = {
    async read() { return snapshot; },
    async rememberIssuedClient(clientId) { remembered.push(clientId); },
    async listIncompleteRegistrations() { return remembered.filter(id => id !== snapshot.selected?.clientId); },
    async listAccounts() { return [{ clientId: 'saved-client', subject: 'saved-subject', state: 'reauthorization-required', selected: snapshot.selected?.clientId === 'saved-client' }]; },
    async selectAccount(clientId) {
      if (clientId !== 'saved-client') return false;
      snapshot = { ...snapshot, revision: `${snapshot.revision}-selected`, selected: { clientId, subject: 'saved-subject', state: 'reauthorization-required' } };
      return true;
    },
    async signOutAndRevoke(revoke) {
      const confirmed = tokens ? await revoke(tokens.clientId, tokens.refreshToken) : true;
      tokens = undefined;
      snapshot = { revision: `${snapshot.revision}-signout`, hostId: snapshot.hostId };
      return confirmed;
    },
    async invalidateSession(revision, clientId, failedRefreshDigest) {
      if (snapshot.revision === revision && snapshot.selected?.clientId === clientId && tokens && createHash('sha256').update(tokens.refreshToken).digest('hex') === failedRefreshDigest) {
        tokens = undefined;
        snapshot = { ...snapshot, revision: `${revision}-invalid`, selected: { ...snapshot.selected, state: 'reauthorization-required' } };
      }
    },
    async commitLogin(revision, result, signal) {
      if (revision !== snapshot.revision || signal.aborted) return false;
      const identity = result.state === 'connected' ? result.tokens.identity : result.identity;
      const clientId = result.state === 'connected' ? result.tokens.clientId : result.clientId;
      if (result.state === 'connected') { tokens = result.tokens; writes++; }
      savedIdentity = { state: result.state, clientId, identity };
      snapshot = { ...snapshot, revision: `${revision}-next`, selected: { clientId, subject: identity.subject, state: result.state } };
      return true;
    },
  };
  const credentials = {
    async withClientLock(_clientId, action) {
      const previous = tail;
      let release;
      tail = new Promise(r => { release = r; });
      await previous;
      try { return await action({ async read() { return tokens; }, async write(value) { tokens = value; writes++; } }); }
      finally { release(); }
    },
  };
  const attempt = { url: 'https://auth.openai.com/api/accounts/authorize', redirectUri: 'http://127.0.0.1:1234/auth/callback', state: 'state', nonce: 'nonce', verifier: 'verifier' };
  const deps = {
    profiles, credentials,
    async verifyIdentity(idToken, clientId, nonce) { assert.equal(idToken, 'fake-id'); assert.equal(clientId, 'client-1'); assert.equal(nonce, 'nonce'); return { subject: 'subject-1' }; },
    async startCallback() { return { attempt, completion: callback.promise, cancel() { callback.reject(new Error('cancelled')); } }; },
    async exchange(options) {
      return exchangeChatGptAuthorization({ ...options, fetchImpl: async () => Response.json({ token_type: 'Bearer', access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: 'fake-id', scope: 'openid chatgpt.tokens.use.direct', expires_in: 3600 }) });
    },
  };
  return { deps, callback, remembered, get tokens() { return tokens; }, get writes() { return writes; }, get savedIdentity() { return savedIdentity; }, setSnapshot(value) { snapshot = value; }, setTokens(value) { tokens = value; } };
}

test('composes callback, verified issuer response, locked storage and activation', async () => {
  const f = fixture();
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  assert.equal(pending.state, 'pending');
  f.callback.resolve({ code: 'fake-code', clientId: 'client-1' });
  assert.deepEqual(await manager.waitForLogin(pending.loginId), { state: 'connected' });
  assert.deepEqual(f.remembered, ['client-1']);
  assert.equal(f.tokens.identity.subject, 'subject-1');
  assert.equal(f.writes, 1);
  assert.equal(f.savedIdentity.accessToken, undefined);
  assert.equal((await manager.getActiveSession()).accountKey, createHash('sha256').update(JSON.stringify(['client-1', 'subject-1'])).digest('hex'));
});

test('composes the real loopback callback with a fake issuer and storage', async () => {
  const f = fixture();
  delete f.deps.startCallback;
  // The verifier receives the freshly generated nonce rather than the fixture nonce.
  f.deps.verifyIdentity = async (idToken, clientId, nonce) => {
    assert.equal(idToken, 'fake-id');
    assert.equal(clientId, 'client-1');
    assert.ok(nonce.length > 20);
    return { subject: 'subject-1' };
  };
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  const authorization = new URL(pending.authUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('client_id', 'client-1');
  callback.searchParams.set('code', 'fake-code');
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await manager.waitForLogin(pending.loginId)).state, 'connected');
  assert.equal(f.writes, 1);
});

test('records identity-only grant without an inference credential', async () => {
  const f = fixture();
  f.deps.exchange = async () => ({ state: 'plan-disabled', clientId: 'client-1', identity: { subject: 'subject-1' }, idToken: 'fake-id', scopes: ['openid'] });
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  f.callback.resolve({ code: 'fake-code', clientId: 'client-1' });
  assert.deepEqual(await manager.waitForLogin(pending.loginId), { state: 'plan-disabled' });
  assert.equal(f.writes, 0);
  assert.equal(await manager.getActiveSession(), undefined);
});

test('cancelling during issuer exchange prevents later token commits', async () => {
  const f = fixture();
  const entered = deferred(), outcome = deferred();
  f.deps.exchange = async () => { entered.resolve(); return outcome.promise; };
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  f.callback.resolve({ code: 'fake-code', clientId: 'client-1' });
  await entered.promise;
  const cancelling = manager.cancelLogin(pending.loginId);
  outcome.resolve({ state: 'connected', tokens: { clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'a', refreshToken: 'r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 100_000 } });
  await cancelling;
  assert.equal(f.writes, 0);
  assert.equal(f.savedIdentity, undefined);
});

test('shutdown cancels a pending login and rejects subsequent attempts', async () => {
  const f = fixture();
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  await manager.dispose();
  assert.equal((await manager.waitForLogin(pending.loginId)).state, 'disconnected');
  await assert.rejects(manager.startLogin(), /closed/);
  assert.equal(f.writes, 0);
});

test('refreshes once under the same lock for simultaneous requests', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'connected' } });
  f.setTokens({ clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'old', refreshToken: 'old-r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 1 });
  let refreshes = 0;
  f.deps.now = () => 100;
  f.deps.refresh = async ({ previous }) => { refreshes++; return { ...previous, accessToken: 'new', refreshToken: 'new-r', expiresAt: 1_000_000 }; };
  const manager = createSiwcAuthManager(f.deps);
  const result = await Promise.all([manager.getActiveSession(), manager.getActiveSession()]);
  assert.equal(refreshes, 1);
  assert.equal(f.writes, 1);
  assert.deepEqual(result.map(s => s.accessToken), ['new', 'new']);
});

test('refuses to activate if account selection changed during authorization', async () => {
  const f = fixture();
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin();
  f.setSnapshot({ revision: 'two', hostId: 'urn:uuid:test', selected: { clientId: 'other', subject: 'other', state: 'connected' } });
  f.callback.resolve({ code: 'fake-code', clientId: 'client-1' });
  assert.deepEqual(await manager.waitForLogin(pending.loginId), { state: 'failed' });
  assert.equal(f.savedIdentity, undefined);
  assert.equal(f.writes, 0);
});

test('invalidates a revoked refresh token but retains a transiently unavailable session', async () => {
  for (const [code, expected] of [['invalid_grant', 'failed'], ['server_error', 'connected']]) {
    const f = fixture();
    f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'connected' } });
    f.setTokens({ clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'old', refreshToken: 'old-r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 1 });
    f.deps.refresh = async () => { throw new ChatGptTokenError(code, 503, code === 'server_error'); };
    const manager = createSiwcAuthManager(f.deps);
    await assert.rejects(manager.getActiveSession());
    assert.equal((await manager.getStatus()).state, expected);
    assert.equal(Boolean(f.tokens), code === 'server_error');
  }
});

test('an old refresh failure cannot invalidate a concurrently rotated token', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'connected' } });
  const previous = { clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'old', refreshToken: 'old-r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 1 };
  f.setTokens(previous);
  f.deps.refresh = async () => { throw new ChatGptTokenError('invalid_grant', 400, false); };
  const invalidate = f.deps.profiles.invalidateSession;
  f.deps.profiles.invalidateSession = async (...args) => {
    f.setTokens({ ...previous, accessToken: 'new', refreshToken: 'new-r', expiresAt: Date.now() + 100_000 });
    return invalidate(...args);
  };
  const manager = createSiwcAuthManager(f.deps);
  await assert.rejects(manager.getActiveSession());
  assert.equal(f.tokens.refreshToken, 'new-r');
  assert.equal((await manager.getStatus()).state, 'connected');
});

test('a failed new-account attempt preserves the selected account status', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'connected' } });
  f.setTokens({ clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'old', refreshToken: 'old-r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 120_000 });
  let options;
  const originalCallback = f.deps.startCallback;
  f.deps.startCallback = async value => { options = value; return originalCallback(value); };
  f.deps.exchange = async () => { throw new Error('invalid identity'); };
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin({ newAccount: true });
  assert.equal(options.clientId, undefined);
  f.callback.resolve({ code: 'fake-code', clientId: 'other' });
  assert.equal((await manager.waitForLogin(pending.loginId)).state, 'failed');
  assert.equal((await manager.waitForLogin(pending.loginId)).state, 'failed');
  assert.equal((await manager.getStatus()).state, 'connected');
});

test('pending registration retry reuses only a recorded client ID', async () => {
  const f = fixture();
  f.remembered.push('pending-client');
  let options;
  const original = f.deps.startCallback;
  f.deps.startCallback = async value => { options = value; return original(value); };
  const manager = createSiwcAuthManager(f.deps);
  await assert.rejects(manager.startLogin({ pendingClientId: 'unknown' }), /unavailable/);
  const pending = await manager.startLogin({ pendingClientId: 'pending-client' });
  assert.equal(options.clientId, 'pending-client');
  await manager.cancelLogin(pending.loginId);
});

test('saved account selection cancels pending login and reuses the issued client', async () => {
  const f = fixture();
  const manager = createSiwcAuthManager(f.deps);
  const first = await manager.startLogin({ newAccount: true });
  assert.equal(await manager.selectAccount('missing'), false);
  assert.equal((await manager.waitForLogin(first.loginId)).state, 'disconnected');
  assert.equal(await manager.selectAccount('saved-client'), true);
  assert.equal((await manager.listAccounts())[0].selected, true);
  let options;
  const original = f.deps.startCallback;
  // A fresh callback promise is required after cancellation.
  const next = deferred();
  f.deps.startCallback = async value => { options = value; const pending = await original(value); return { ...pending, completion: next.promise, cancel() { next.reject(new Error('cancelled')); } }; };
  const resumed = await manager.startLogin();
  assert.equal(options.clientId, 'saved-client');
  await manager.cancelLogin(resumed.loginId);
});

test('reconsent is requested only for the explicit enable-plan action', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'plan-disabled' } });
  let options;
  const original = f.deps.startCallback;
  f.deps.startCallback = async value => { options = value; return original(value); };
  const manager = createSiwcAuthManager(f.deps);
  const pending = await manager.startLogin({ enablePlanUsage: true });
  assert.equal(options.clientId, 'client-1');
  assert.equal(options.promptConsent, true);
  await manager.cancelLogin(pending.loginId);
});

test('signout cancels pending login and clears locally even if remote revocation fails', async () => {
  const f = fixture();
  f.setSnapshot({ revision: 'one', hostId: 'urn:uuid:test', selected: { clientId: 'client-1', subject: 'subject-1', state: 'connected' } });
  f.setTokens({ clientId: 'client-1', identity: { subject: 'subject-1' }, accessToken: 'old', refreshToken: 'old-r', idToken: 'i', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 120_000 });
  f.deps.revoke = async (clientId, refreshToken) => { assert.equal(clientId, 'client-1'); assert.equal(refreshToken, 'old-r'); return false; };
  const manager = createSiwcAuthManager(f.deps);
  await manager.startLogin();
  assert.deepEqual(await manager.signOut(), { remoteRevocationConfirmed: false });
  assert.equal((await manager.getStatus()).state, 'disconnected');
  assert.equal(f.tokens, undefined);
});
