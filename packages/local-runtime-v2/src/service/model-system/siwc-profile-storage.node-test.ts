import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatGptLeaseError, WindowsChatGptProfileStore } from './siwc-profile-storage.ts';

test('atomic profile commits, cancellation, account switch, refresh and invalidation stay consistent', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-test-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, accessToken: 'fake-access-secret', refreshToken: 'fake-refresh-secret', idToken: 'fake-id-secret', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    const connected = { state: 'connected' as const, tokens };
    await store.rememberIssuedClient(tokens.clientId);
    assert.equal((await store.read()).revision, initial.revision);
    assert.deepEqual(await store.listIncompleteRegistrations(), [tokens.clientId]);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(store.commitLogin(initial.revision, connected, cancelled.signal));
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.commitLogin(initial.revision, connected, new AbortController().signal), true);
    assert.deepEqual(await store.listIncompleteRegistrations(), []);
    const active = await store.read();
    assert.equal(active.selected?.clientId, tokens.clientId);
    assert.equal((await readFile(join(directory, 'profile.dat'), 'utf8')).includes(tokens.refreshToken), false);
    await store.withClientLock(tokens.clientId, async (locked) => {
      assert.equal((await locked.read())?.refreshToken, 'fake-refresh-secret');
      await locked.write({ ...tokens, refreshToken: 'fake-rotated-secret' });
    });
    const oldDigest = createHash('sha256').update(tokens.refreshToken).digest('hex');
    const currentDigest = createHash('sha256').update('fake-rotated-secret').digest('hex');
    await store.invalidateSession(initial.revision, tokens.clientId, currentDigest);
    assert.equal((await store.read()).selected?.state, 'connected');
    await store.invalidateSession(active.revision, tokens.clientId, oldDigest);
    assert.equal((await store.read()).selected?.state, 'connected');
    await store.invalidateSession(active.revision, tokens.clientId, currentDigest);
    assert.equal((await store.read()).selected?.state, 'reauthorization-required');
    assert.equal(await store.withClientLock(tokens.clientId, (locked) => locked.read()), undefined);
    await store.signOut();
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.commitLogin(active.revision, connected, new AbortController().signal), false);
  } finally {
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('separate-process refresh and sign-out serialize through the same profile lock', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-process-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    await store.commitLogin(initial.revision, { state: 'connected', tokens }, new AbortController().signal);
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store = new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); await store.withClientLock('oaiapp_fake', async (locked) => { const tokens=await locked.read(); console.log('locked'); await new Promise(resolve => process.stdin.once('data', resolve)); await locked.write({...tokens,refreshToken:'fake-rotated'}); });`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); }));
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('close', resolve); });
    await ready;
    let signedOut = false;
    const signOut = store.signOut().then(() => { signedOut = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(signedOut, false);
    child.stdin!.end('release');
    assert.equal(await exited, 0);
    await signOut;
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.withClientLock(tokens.clientId, (locked) => locked.read()), undefined);
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('a crashed holder releases the OS lock and leaves the committed profile intact', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-crash-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const original = await store.read();
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store = new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); await store.withClientLock('oaiapp_fake', async () => { console.log('locked'); await new Promise(resolve => process.stdin.once('data', resolve)); });`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); }));
    const exited = new Promise((resolve) => child!.on('close', resolve));
    await ready;
    child.kill();
    await exited;
    const recovered = await Promise.race([
      store.read(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Profile lock was not released')), 5000); timer.unref(); }),
    ]);
    assert.deepEqual(recovered, original);
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('cancelling a login waiting on another process prevents its commit', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-cancel-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store = new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); await store.withClientLock('oaiapp_fake', async () => { console.log('locked'); await new Promise(resolve => process.stdin.once('data', resolve)); });`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); }));
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('close', resolve); });
    await ready;
    const controller = new AbortController();
    const commit = store.commitLogin(initial.revision, { state: 'connected', tokens }, controller.signal);
    const rejected = assert.rejects(commit);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await Promise.race([
      rejected,
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation blocked on profile lock')), 1000); timer.unref(); }),
    ]);
    child.stdin!.end('release');
    assert.equal(await exited, 0);
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.withClientLock(tokens.clientId, (locked) => locked.read()), undefined);
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('sign-out with no active account invalidates a pending login in another process', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-pending-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store = new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); const snapshot=await store.read(); console.log('ready'); await new Promise(resolve => process.stdin.once('data', resolve)); const tokens={clientId:'oaiapp_fake',identity:{subject:'fake'},accessToken:'fake',refreshToken:'fake',idToken:'fake',scopes:['chatgpt.tokens.use.direct'],expiresAt:100}; console.log(await store.commitLogin(snapshot.revision,{state:'connected',tokens},new AbortController().signal) ? 'committed' : 'rejected');`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { output += chunk; if (output.includes('ready')) resolve(); }));
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('close', resolve); });
    await ready;
    assert.equal(await store.signOutAndRevoke(async () => true), true);
    child.stdin!.end('continue');
    assert.equal(await exited, 0);
    assert.equal(output.includes('rejected'), true);
    assert.equal((await store.read()).selected, undefined);
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('sign-out waits for an in-flight refresh and clears its result', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-race-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    await store.commitLogin(initial.revision, { state: 'connected', tokens }, new AbortController().signal);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const refresh = store.withClientLock(tokens.clientId, async (locked) => {
      entered(); await held;
      await locked.write({ ...tokens, refreshToken: 'fake-new-refresh' });
    });
    await started;
    const signOut = store.signOut();
    release();
    await Promise.all([refresh, signOut]);
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.withClientLock(tokens.clientId, (locked) => locked.read()), undefined);
  } finally {
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('sign-out clears local tokens even if remote revocation fails', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-revoke-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    await store.commitLogin(initial.revision, { state: 'connected', tokens }, new AbortController().signal);
    assert.equal(await store.signOutAndRevoke(async (clientId, refreshToken) => {
      assert.equal(clientId, tokens.clientId); assert.equal(refreshToken, tokens.refreshToken);
      throw new Error('fake network failure');
    }), false);
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.withClientLock(tokens.clientId, (locked) => locked.read()), undefined);
    assert.equal(await store.signOutAndRevoke(async () => { throw new Error('should not be called'); }), true);
  } finally {
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('identity-only refresh tokens are retained only for revocation', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-identity-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const identity = { state: 'plan-disabled' as const, clientId: 'oaiapp_fake', identity: { subject: 'fake-subject' }, idToken: 'fake-id', scopes: ['openid'], refreshToken: 'fake-identity-refresh' };
    await store.commitLogin(initial.revision, identity, new AbortController().signal);
    assert.equal(await store.withClientLock(identity.clientId, (locked) => locked.read()), undefined);
    assert.equal(await store.signOutAndRevoke(async (_client, refresh) => refresh === 'fake-identity-refresh'), true);
    const next = await store.read();
    const { refreshToken: _omit, ...withoutRefresh } = identity;
    await store.commitLogin(next.revision, withoutRefresh, new AbortController().signal);
    assert.equal(await store.signOutAndRevoke(async () => true), false);
  } finally {
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('account picker and model selection keep registrations and secrets separate', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-accounts-'));
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const firstSnapshot = await store.read();
    const base = { identity: { subject: 'fake-subject', email: 'same@example.test' }, accessToken: 'fake-access-secret', refreshToken: 'fake-refresh-secret', idToken: 'fake-id-secret', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    const first = { ...base, clientId: 'oaiapp_fake_a' };
    const second = { ...base, clientId: 'oaiapp_fake_b' };
    assert.equal(await store.commitLogin(firstSnapshot.revision, { state: 'connected', tokens: first }, new AbortController().signal), true);
    const keyA = createHash('sha256').update(JSON.stringify([first.clientId, first.identity.subject])).digest('hex');
    assert.equal(await store.selectModel(keyA, 'openai-siwc-experimental/gpt-test'), true);
    assert.equal((await store.read()).selected?.modelKey, 'openai-siwc-experimental/gpt-test');
    const selectedA = await store.read();
    assert.equal(await store.commitLogin(selectedA.revision, { state: 'connected', tokens: second }, new AbortController().signal), true);
    assert.equal(await store.selectModel(keyA, 'openai-siwc-experimental/gpt-other'), false);
    const accounts = await store.listAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].email, accounts[1].email);
    assert.deepEqual(accounts.map((account) => account.selected), [false, true]);
    assert.equal(JSON.stringify(accounts).includes('fake-refresh-secret'), false);
    assert.equal(JSON.stringify(accounts).includes('fake-access-secret'), false);
    assert.equal(JSON.stringify(accounts).includes('fake-id-secret'), false);
    assert.equal(await store.selectAccount(first.clientId), true);
    assert.equal((await store.read()).selected?.modelKey, 'openai-siwc-experimental/gpt-test');
    await store.signOut();
    assert.equal((await store.read()).selected, undefined);
    assert.equal(await store.selectAccount(first.clientId), true);
    assert.equal((await store.read()).selected?.state, 'reauthorization-required');
  } finally {
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('model selection cannot commit after a different process switches accounts', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-model-race-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const base = { identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 100 };
    const first = { ...base, clientId: 'oaiapp_fake_a' };
    const second = { ...base, clientId: 'oaiapp_fake_b' };
    await store.commitLogin(initial.revision, { state: 'connected', tokens: first }, new AbortController().signal);
    await store.commitLogin((await store.read()).revision, { state: 'connected', tokens: second }, new AbortController().signal);
    await store.selectAccount(first.clientId);
    const key = createHash('sha256').update(JSON.stringify([first.clientId, first.identity.subject])).digest('hex');
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store = new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); console.log('ready'); await new Promise(resolve => process.stdin.once('data', resolve)); console.log(await store.selectModel(process.env.SIWC_FAKE_ACCOUNT_KEY,'openai-siwc-experimental/gpt-test') ? 'committed' : 'rejected');`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory, SIWC_FAKE_ACCOUNT_KEY: key }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { output += chunk; if (output.includes('ready')) resolve(); }));
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('close', resolve); });
    await ready;
    assert.equal(await store.selectAccount(second.clientId), true);
    child.stdin!.end('continue');
    assert.equal(await exited, 0);
    assert.equal(output.includes('rejected'), true);
    const selected = (await store.read()).selected;
    assert.equal(selected?.clientId, second.clientId);
    assert.equal(selected?.modelKey, undefined);
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('an active request lease blocks cross-process account switching until cancellation', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-lease-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const base = { identity: { subject: 'fake-subject' }, accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3_600_000 };
    const first = { ...base, clientId: 'oaiapp_fake_a' };
    const second = { ...base, clientId: 'oaiapp_fake_b' };
    await store.commitLogin(initial.revision, { state: 'connected', tokens: first }, new AbortController().signal);
    await store.commitLogin((await store.read()).revision, { state: 'connected', tokens: second }, new AbortController().signal);
    await store.selectAccount(first.clientId);
    const key = createHash('sha256').update(JSON.stringify([first.clientId, first.identity.subject])).digest('hex');
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store=new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); const controller=new AbortController(); process.stdin.once('data',()=>controller.abort()); await store.withActiveTokenLease(process.env.SIWC_FAKE_ACCOUNT_KEY, async (_token,signal)=>{ console.log('leased'); await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})); },{signal:controller.signal}).catch(()=>console.log('cancelled'));`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory, SIWC_FAKE_ACCOUNT_KEY: key }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { output += chunk; if (output.includes('leased')) resolve(); }));
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('close', resolve); });
    await ready;
    let switched = false;
    const switchAccount = store.selectAccount(second.clientId).then((value) => { switched = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(switched, false);
    child.stdin!.end('cancel');
    assert.equal(await exited, 0);
    assert.equal(output.includes('cancelled'), true);
    assert.equal(await switchAccount, true);
    await assert.rejects(store.withActiveTokenLease(key, async () => undefined), (error: unknown) => error instanceof ChatGptLeaseError && error.code === 'ACCOUNT_CHANGED');
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});

test('a crashed request lease releases the lock and an expired token cannot start a request', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-profile-lease-crash-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new WindowsChatGptProfileStore(directory);
    const initial = await store.read();
    const tokens = { clientId: 'oaiapp_fake', identity: { subject: 'fake' }, accessToken: 'fake', refreshToken: 'fake', idToken: 'fake', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3_600_000 };
    await store.commitLogin(initial.revision, { state: 'connected', tokens }, new AbortController().signal);
    const key = createHash('sha256').update(JSON.stringify([tokens.clientId, tokens.identity.subject])).digest('hex');
    const moduleUrl = new URL('./siwc-profile-storage.ts', import.meta.url).href;
    const script = `import { WindowsChatGptProfileStore } from ${JSON.stringify(moduleUrl)}; const store=new WindowsChatGptProfileStore(process.env.SIWC_FAKE_TEST_DIR); await store.withActiveTokenLease(process.env.SIWC_FAKE_ACCOUNT_KEY, async ()=>{ console.log('leased'); await new Promise(resolve=>process.stdin.once('data',resolve)); });`;
    child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { env: { ...process.env, SIWC_FAKE_TEST_DIR: directory, SIWC_FAKE_ACCOUNT_KEY: key }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const ready = new Promise<void>((resolve) => child!.stdout!.on('data', (chunk) => { if (String(chunk).includes('leased')) resolve(); }));
    const exited = new Promise((resolve) => child!.on('close', resolve));
    await ready;
    child.kill(); await exited;
    await assert.rejects(store.withActiveTokenLease(key, async () => undefined, { now: () => tokens.expiresAt }), (error: unknown) => error instanceof ChatGptLeaseError && error.code === 'REFRESH_REQUIRED');
    assert.equal(await store.withActiveTokenLease(key, async (token) => token), 'fake');
  } finally {
    child?.kill();
    for (const filename of await readdir(directory)) await unlink(join(directory, filename));
    await rmdir(directory);
  }
});
