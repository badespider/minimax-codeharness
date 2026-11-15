import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrCreateChatGptHostId } from './siwc-host-id.js';
import { withChatGptProfileLock } from './siwc-lock.js';
import { protectChatGptData, restrictChatGptFile, unprotectChatGptData } from './siwc-storage.js';
import type { ChatGptLockedStore } from './siwc-storage.js';
import type { ChatGptAuthorizationResult, ChatGptIdentity, ChatGptTokenSet } from './siwc-token.js';

type AccountState = 'connected' | 'plan-disabled' | 'reauthorization-required';
interface Account { clientId: string; identity: ChatGptIdentity; state: AccountState; tokens?: ChatGptTokenSet; idToken?: string; identityRefreshToken?: string; scopes: readonly string[]; modelKey?: string }
interface ProfileRecord { revision: string; hostId: string; selectedClientId?: string; accounts: Account[]; issuedClients: string[] }
export interface ChatGptProfileSnapshot {
  readonly revision: string;
  readonly hostId: string;
  readonly selected?: { readonly clientId: string; readonly subject: string; readonly state: AccountState; readonly modelKey?: string };
}

export class ChatGptLeaseError extends Error {
  readonly code: 'ACCOUNT_CHANGED' | 'REFRESH_REQUIRED';
  constructor(code: 'ACCOUNT_CHANGED' | 'REFRESH_REQUIRED') {
    super(code === 'ACCOUNT_CHANGED' ? 'ChatGPT account changed.' : 'ChatGPT session must be refreshed.');
    this.code = code;
    this.name = 'ChatGptLeaseError';
  }
}

// One encrypted, atomically replaced record and one global lock make profile
// selection, credential updates, sign-out, and refresh mutually exclusive.
// SQLite's OS-backed lock is released when its holder exits or crashes.
export class WindowsChatGptProfileStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  private async withState<T>(action: (state: ProfileRecord, save: (signal?: AbortSignal) => Promise<void>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (process.platform !== 'win32') throw new Error('Windows credential protection is unavailable on this platform.');
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const hostId = await getOrCreateChatGptHostId(this.directory);
    const lockPath = join(this.directory, 'profile-lock.sqlite');
    const path = join(this.directory, 'profile.dat');
    return withChatGptProfileLock(lockPath, async () => {
      let state: ProfileRecord;
      try {
        const raw = await readFile(path, 'utf8');
        state = JSON.parse(await unprotectChatGptData(raw)) as ProfileRecord;
        if (!state || typeof state.revision !== 'string' || state.hostId !== hostId || !Array.isArray(state.accounts) || !Array.isArray(state.issuedClients)) throw new Error('Invalid ChatGPT profile record.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { revision: randomUUID(), hostId, accounts: [], issuedClients: [] };
      }
      const save = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const sealed = await protectChatGptData(JSON.stringify(state));
        if (!sealed) throw new Error('Windows credential protection returned no data.');
        const tempPath = join(this.directory, `.profile-${randomBytes(16).toString('hex')}.tmp`);
        try {
          const file = await open(tempPath, 'wx', 0o600);
          try { await file.writeFile(sealed, 'utf8'); await file.sync(); } finally { await file.close(); }
          await restrictChatGptFile(tempPath);
          // The rename is the commit point. Cancellation after it starts cannot
          // undo a commit already accepted by the OS.
          signal?.throwIfAborted();
          await rename(tempPath, path);
        } finally { await unlink(tempPath).catch(() => {}); }
      };
      // Persist initial revision before exposing it to any caller.
      try { await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await save(); else throw error; }
      return await action(state, save);
    }, signal);
  }

  read(): Promise<ChatGptProfileSnapshot> {
    return this.withState(async (state) => {
      const account = state.accounts.find((item) => item.clientId === state.selectedClientId);
      return { revision: state.revision, hostId: state.hostId, ...(account ? { selected: { clientId: account.clientId, subject: account.identity.subject, state: account.state, ...(account.modelKey ? { modelKey: account.modelKey } : {}) } } : {}) };
    });
  }

  rememberIssuedClient(clientId: string): Promise<void> {
    return this.withState(async (state, save) => {
      if (!clientId || clientId === 'dynamic_agent_client') throw new Error('Invalid issued client ID.');
      if (!state.issuedClients.includes(clientId)) { state.issuedClients.push(clientId); await save(); }
    });
  }

  // These IDs came from callbacks but are not verified accounts. The caller
  // may offer reauthorization; they must never be treated as active sessions.
  listIncompleteRegistrations(): Promise<string[]> {
    return this.withState(async (state) => state.issuedClients.filter((id) => !state.accounts.some((account) => account.clientId === id)));
  }

  listAccounts(): Promise<readonly { clientId: string; subject: string; email?: string; state: AccountState; selected: boolean }[]> {
    return this.withState(async (state) => state.accounts.map((account) => ({
      clientId: account.clientId, subject: account.identity.subject,
      ...(account.identity.email ? { email: account.identity.email } : {}),
      state: account.state, selected: account.clientId === state.selectedClientId,
    })));
  }

  commitLogin(expectedRevision: string, result: ChatGptAuthorizationResult, signal: AbortSignal): Promise<boolean> {
    return this.withState(async (state, save) => {
      signal.throwIfAborted();
      if (state.revision !== expectedRevision) return false;
      const clientId = result.state === 'connected' ? result.tokens.clientId : result.clientId;
      const identity = result.state === 'connected' ? result.tokens.identity : result.identity;
      if (!clientId || clientId === 'dynamic_agent_client' || !identity.subject) throw new Error('Invalid verified ChatGPT account.');
      if (result.state === 'connected' && (!result.tokens.scopes.includes('chatgpt.tokens.use.direct') || !result.tokens.accessToken || !result.tokens.refreshToken || !result.tokens.idToken || !Number.isFinite(result.tokens.expiresAt))) throw new Error('Invalid ChatGPT plan credentials.');
      if (result.state === 'plan-disabled' && !result.idToken) throw new Error('Missing verified ChatGPT identity.');
      const prior = state.accounts.find((item) => item.clientId === clientId);
      if (prior && prior.identity.subject !== identity.subject) throw new Error('ChatGPT account identity mismatch.');
      const account: Account = result.state === 'connected'
        ? { clientId, identity, state: 'connected', tokens: result.tokens, scopes: result.tokens.scopes, ...(prior?.modelKey ? { modelKey: prior.modelKey } : {}) }
        : { clientId, identity, state: 'plan-disabled', idToken: result.idToken, scopes: result.scopes, ...(result.refreshToken ? { identityRefreshToken: result.refreshToken } : {}), ...(prior?.modelKey ? { modelKey: prior.modelKey } : {}) };
      state.accounts = [...state.accounts.filter((item) => item.clientId !== clientId), account];
      if (!state.issuedClients.includes(clientId)) state.issuedClients.push(clientId);
      state.selectedClientId = clientId;
      state.revision = randomUUID();
      await save(signal);
      return true;
    }, signal);
  }

  invalidateSession(expectedRevision: string, clientId: string, failedRefreshDigest: string): Promise<void> {
    return this.withState(async (state, save) => {
      if (state.revision !== expectedRevision || state.selectedClientId !== clientId) return;
      const account = state.accounts.find((item) => item.clientId === clientId);
      if (!account?.tokens || !/^[a-f0-9]{64}$/.test(failedRefreshDigest)) return;
      const currentDigest = createHash('sha256').update(account.tokens.refreshToken).digest('hex');
      if (currentDigest !== failedRefreshDigest) return;
      account.idToken = account.tokens?.idToken ?? account.idToken;
      delete account.tokens;
      account.state = 'reauthorization-required';
      state.revision = randomUUID();
      await save();
    });
  }

  withClientLock<T>(clientId: string, action: (store: ChatGptLockedStore) => Promise<T>): Promise<T> {
    return this.withState(async (state, save) => action({
      read: async () => state.accounts.find((item) => item.clientId === clientId)?.tokens,
      write: async (tokens: ChatGptTokenSet) => {
        const account = state.accounts.find((item) => item.clientId === clientId);
        if (!account || account.state !== 'connected' || tokens.clientId !== clientId || tokens.identity.subject !== account.identity.subject || !tokens.scopes.includes('chatgpt.tokens.use.direct') || !tokens.accessToken || !tokens.refreshToken || !tokens.idToken || !Number.isFinite(tokens.expiresAt)) throw new Error('Invalid ChatGPT credential replacement.');
        account.tokens = tokens;
        account.scopes = tokens.scopes;
        await save();
      },
    }));
  }

  signOut(): Promise<void> {
    return this.withState(async (state, save) => {
      const account = state.accounts.find((item) => item.clientId === state.selectedClientId);
      if (account) { delete account.tokens; delete account.idToken; delete account.identityRefreshToken; account.state = 'reauthorization-required'; }
      delete state.selectedClientId;
      state.revision = randomUUID();
      await save();
    });
  }

  // This operation holds the same global lock during the bounded revocation
  // attempt, then clears the local session even if revocation cannot be
  // confirmed. False means callers must tell the user to check ChatGPT.
  signOutAndRevoke(revoke: (clientId: string, refreshToken: string) => Promise<boolean>): Promise<boolean> {
    return this.withState(async (state, save) => {
      const account = state.accounts.find((item) => item.clientId === state.selectedClientId);
      if (!account) {
        // Invalidate pending login snapshots in other processes even when there
        // is no active account at the moment sign-out is requested.
        state.revision = randomUUID();
        await save();
        return true;
      }
      let confirmed = true;
      const refreshToken = account.tokens?.refreshToken ?? account.identityRefreshToken;
      if (refreshToken) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          confirmed = await Promise.race([
            revoke(account.clientId, refreshToken).catch(() => false),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 15_000); }),
          ]);
        } catch { confirmed = false; }
        finally { if (timer) clearTimeout(timer); }
      } else confirmed = false;
      delete account.tokens;
      delete account.idToken;
      delete account.identityRefreshToken;
      account.state = 'reauthorization-required';
      delete state.selectedClientId;
      state.revision = randomUUID();
      await save();
      return confirmed;
    });
  }

  selectAccount(clientId: string): Promise<boolean> {
    return this.withState(async (state, save) => {
      if (!state.accounts.some((item) => item.clientId === clientId)) return false;
      state.selectedClientId = clientId;
      state.revision = randomUUID();
      await save();
      return true;
    });
  }

  // The catalog must validate the model for this account before calling this.
  // This method performs no external I/O while the profile lock is held.
  selectModel(expectedAccountKey: string, modelKey: string): Promise<boolean> {
    if (!/^openai-siwc-experimental\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(modelKey)) throw new Error('Invalid ChatGPT model key.');
    return this.withState(async (state, save) => {
      const account = state.accounts.find((item) => item.clientId === state.selectedClientId);
      if (!account || account.state !== 'connected' || !account.tokens) return false;
      const actual = createHash('sha256').update(JSON.stringify([account.clientId, account.identity.subject])).digest('hex');
      if (actual !== expectedAccountKey) return false;
      account.modelKey = modelKey;
      state.revision = randomUUID();
      await save();
      return true;
    });
  }

  // Refresh before entering this method; refreshing via another store method
  // from inside action would deadlock. The callback must consume its complete
  // stream and honor the provided signal before it resolves. We deliberately
  // retain the lock until it settles, even after abort, so a switch cannot
  // race a callback that ignores cancellation.
  withActiveTokenLease<T>(
    expectedAccountKey: string,
    action: (accessToken: string, signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid ChatGPT request timeout.');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return this.withState(async (state) => {
      signal.throwIfAborted();
      const account = state.accounts.find((item) => item.clientId === state.selectedClientId);
      const tokens = account?.tokens;
      const actual = account && createHash('sha256').update(JSON.stringify([account.clientId, account.identity.subject])).digest('hex');
      if (!account || account.state !== 'connected' || !tokens || actual !== expectedAccountKey || tokens.clientId !== account.clientId || tokens.identity.subject !== account.identity.subject || !tokens.scopes.includes('chatgpt.tokens.use.direct') || !tokens.accessToken || !Number.isFinite(tokens.expiresAt)) {
        throw new ChatGptLeaseError('ACCOUNT_CHANGED');
      }
      if (tokens.expiresAt <= (options.now ?? Date.now)() + 60_000) throw new ChatGptLeaseError('REFRESH_REQUIRED');
      const value = await action(tokens.accessToken, signal);
      signal.throwIfAborted();
      return value;
    }, signal);
  }
}
