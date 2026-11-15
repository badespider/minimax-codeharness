import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSiwcAuthManager } from '../packages/local-runtime-v2/src/service/model-system/siwc-auth-manager.ts';
import { WindowsChatGptProfileStore } from '../packages/local-runtime-v2/src/service/model-system/siwc-profile-storage.ts';
import { exchangeChatGptAuthorization } from '../packages/local-runtime-v2/src/service/model-system/siwc-token.ts';

test('completed loopback login exits even when another connection stalls', { timeout: 10_000 }, async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { connect } from 'node:net';
    import { startChatGptCallback } from './packages/local-runtime-v2/src/service/model-system/siwc-callback.ts';
    const login = await startChatGptCallback({ hostId: 'test-host' });
    const port = Number(new URL(login.attempt.redirectUri).port);
    const stalled = connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => { stalled.once('connect', resolve); stalled.once('error', reject); });
    stalled.write('GET /incomplete HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n');
    stalled.unref();
    const url = new URL(login.attempt.redirectUri);
    url.searchParams.set('state', login.attempt.state);
    url.searchParams.set('code', 'fake-code');
    url.searchParams.set('client_id', 'fake-client');
    const [response, result] = await Promise.all([fetch(url), login.completion]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Authorization received/);
    assert.equal(result.code, 'fake-code');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    assert.equal(signal, null, `Sign-in child did not exit promptly: ${diagnostic}`);
    assert.equal(code, 0, diagnostic);
  } finally { clearTimeout(timer); }
});

test('real Windows protected store and loopback login work with a fake issuer and serialized refresh', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-auth-int-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    let refreshCount = 0;
    const manager = createSiwcAuthManager({
      profiles: store, credentials: store,
      async verifyIdentity(id, clientId, nonce) {
        assert.equal(id, 'fake-id'); assert.equal(clientId, 'oaiapp_fake'); assert.ok(nonce.length > 20);
        return { subject: 'fake-subject' };
      },
      exchange: options => exchangeChatGptAuthorization({ ...options, fetchImpl: async () => Response.json({ token_type: 'Bearer', access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: 'fake-id', scope: 'openid chatgpt.tokens.use.direct', expires_in: 3600 }) }),
      async refresh({ previous }) { refreshCount++; return { ...previous, accessToken: 'new-fake-access', refreshToken: 'new-fake-refresh', expiresAt: Date.now() + 3_600_000 }; },
      async revoke(clientId, token) { assert.equal(clientId, 'oaiapp_fake'); assert.equal(token, 'new-fake-refresh'); return false; },
    });
    const pending = await manager.startLogin();
    const authorization = new URL(pending.authUrl);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('client_id', 'oaiapp_fake');
    callback.searchParams.set('code', 'fake-code');
    assert.equal((await fetch(callback)).status, 200);
    assert.equal((await manager.waitForLogin(pending.loginId)).state, 'connected');
    const encrypted = await readFile(join(directory, 'profile.dat'), 'utf8');
    assert.ok(!encrypted.includes('fake-refresh'));
    await store.withClientLock('oaiapp_fake', async locked => {
      const tokens = await locked.read();
      await locked.write({ ...tokens, expiresAt: 1 });
    });
    const sessions = await Promise.all([manager.getActiveSession(), manager.getActiveSession()]);
    assert.equal(refreshCount, 1);
    assert.deepEqual(sessions.map(session => session.accessToken), ['new-fake-access', 'new-fake-access']);
    assert.deepEqual(await manager.signOut(), { remoteRevocationConfirmed: false });
    assert.equal(await manager.getActiveSession(), undefined);
    assert.deepEqual(await manager.listAccounts(), [{ clientId: 'oaiapp_fake', subject: 'fake-subject', state: 'reauthorization-required', selected: false }]);
    assert.equal(await manager.selectAccount('oaiapp_fake'), true);
    assert.equal((await manager.listAccounts())[0].selected, true);
    await manager.dispose();
  } finally {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});
