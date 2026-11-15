import { createHash, randomUUID } from 'node:crypto';
import { startChatGptCallback, type ChatGptPendingLogin } from './siwc-callback.js';
import { ChatGptTokenError, exchangeChatGptAuthorization, refreshChatGptTokens, type ChatGptAuthorizationResult, type VerifyChatGptIdentity } from './siwc-token.js';
import type { ChatGptLockedStore } from './siwc-storage.js';
import type { SiwcActiveSession, SiwcManagerAuthPort, SiwcStatus } from './siwc-manager.js';
import { revokeChatGptSession } from './siwc-revoke.js';

export interface SiwcProfileSnapshot {
  readonly revision: string;
  readonly hostId: string;
  readonly selected?: { readonly clientId: string; readonly subject: string; readonly state: 'connected' | 'plan-disabled' | 'reauthorization-required' };
}

export interface SiwcAccountView {
  readonly clientId: string;
  readonly subject: string;
  readonly email?: string;
  readonly state: 'connected' | 'plan-disabled' | 'reauthorization-required';
  readonly selected: boolean;
}

/** Implement with protected, cross-process-safe storage; activation must CAS the revision. */
export interface SiwcProfilePort {
  read(): Promise<SiwcProfileSnapshot>;
  /** Keep as an unverified/incomplete registration, never an active account. */
  rememberIssuedClient(clientId: string): Promise<void>;
  listIncompleteRegistrations(): Promise<readonly string[]>;
  listAccounts(): Promise<readonly SiwcAccountView[]>;
  selectAccount(clientId: string): Promise<boolean>;
  /** Atomically checks revision and commits encrypted credentials and profile together;
   * abort before the commit point must leave both untouched. Holds the same cross-process
   * credential lock used by refresh. Identity-only ID tokens require protected storage. */
  commitLogin(expectedRevision: string, result: ChatGptAuthorizationResult, signal: AbortSignal): Promise<boolean>;
  /** Atomically erase unusable credentials and mark reauthorization if still selected. */
  invalidateSession(expectedRevision: string, clientId: string, failedRefreshDigest: string): Promise<void>;
  /** Under the global lock, attempt remote revoke then erase local tokens regardless. */
  signOutAndRevoke(revoke: (clientId: string, refreshToken: string) => Promise<boolean>): Promise<boolean>;
}

export interface SiwcCredentialStore {
  withClientLock<T>(clientId: string, action: (store: ChatGptLockedStore) => Promise<T>): Promise<T>;
}

interface PendingAttempt {
  readonly id: string;
  readonly callback: ChatGptPendingLogin;
  cancelled: boolean;
  readonly abort: AbortController;
  completion: Promise<SiwcStatus>;
}

export interface SiwcAuthManagerOptions {
  readonly profiles: SiwcProfilePort;
  readonly credentials: SiwcCredentialStore;
  readonly verifyIdentity: VerifyChatGptIdentity;
  readonly startCallback?: typeof startChatGptCallback;
  readonly exchange?: typeof exchangeChatGptAuthorization;
  readonly refresh?: typeof refreshChatGptTokens;
  readonly revoke?: (clientId: string, refreshToken: string) => Promise<boolean>;
  readonly now?: () => number;
}

/** Disabled until a production profile port and the official verifier are composed. */
export function createSiwcAuthManager(options: SiwcAuthManagerOptions): SiwcManagerAuthPort & {
  dispose(): Promise<void>;
  signOut(): Promise<{ remoteRevocationConfirmed: boolean }>;
  listIncompleteRegistrations(): Promise<readonly string[]>;
  listAccounts(): Promise<readonly SiwcAccountView[]>;
  selectAccount(clientId: string): Promise<boolean>;
} {
  let pending: PendingAttempt | undefined;
  let starting = false;
  let startingDone: Promise<void> | undefined;
  let finishStarting: (() => void) | undefined;
  let lastFailure = false;
  let disposed = false;
  let signingOut = false;
  let completed: { readonly loginId: string; readonly status: SiwcStatus } | undefined;

  async function status(): Promise<SiwcStatus> {
    if (pending) return { state: 'pending', loginId: pending.id, authUrl: pending.callback.attempt.url };
    const profile = await options.profiles.read();
    if (!profile.selected) return { state: lastFailure ? 'failed' : 'disconnected' };
    if (profile.selected.state === 'plan-disabled') return { state: 'plan-disabled' };
    if (profile.selected.state === 'reauthorization-required') return { state: 'failed' };
    const selected = profile.selected;
    return options.credentials.withClientLock(selected.clientId, async (store) => {
      const saved = await store.read();
      return saved && saved.clientId === selected.clientId && saved.identity.subject === selected.subject && saved.scopes.includes('chatgpt.tokens.use.direct')
        ? { state: 'connected' } : { state: 'disconnected' };
    });
  }

  async function finishLogin(attempt: PendingAttempt, snapshot: SiwcProfileSnapshot): Promise<SiwcStatus> {
    const finish = (result: SiwcStatus): SiwcStatus => {
      completed = { loginId: attempt.id, status: result };
      return result;
    };
    try {
      const callback = await attempt.callback.completion;
      if (attempt.cancelled) return finish({ state: 'disconnected' });
      await options.profiles.rememberIssuedClient(callback.clientId);
      if (attempt.cancelled) return finish({ state: 'disconnected' });
      const result = await (options.exchange ?? exchangeChatGptAuthorization)({
        attempt: attempt.callback.attempt, code: callback.code, clientId: callback.clientId,
        verifyIdentity: options.verifyIdentity,
        ...(snapshot.selected ? { expectedSubject: snapshot.selected.subject } : {}),
      });
      if (attempt.cancelled) return finish({ state: 'disconnected' });
      const activated = await options.profiles.commitLogin(snapshot.revision, result, attempt.abort.signal);
      if (!activated) throw new Error('Account selection changed.');
      lastFailure = false;
      return finish({ state: result.state });
    } catch {
      lastFailure = !attempt.cancelled;
      return finish({ state: attempt.cancelled ? 'disconnected' : 'failed' });
    } finally {
      if (pending === attempt) pending = undefined;
    }
  }

  async function cancelAttempt(attempt: PendingAttempt): Promise<SiwcStatus> {
    attempt.cancelled = true;
    attempt.abort.abort();
    attempt.callback.cancel();
    return attempt.completion;
  }

  return {
    getStatus: status,
    startLogin: async (settings?: { readonly newAccount?: boolean; readonly pendingClientId?: string; readonly enablePlanUsage?: boolean }) => {
      if (disposed) throw new Error('ChatGPT sign-in manager is closed.');
      if (pending || starting || signingOut) throw new Error('ChatGPT sign-in is already in progress.');
      if (settings?.newAccount && settings.pendingClientId) throw new Error('Choose one ChatGPT registration.');
      if (settings?.enablePlanUsage && (settings.newAccount || settings.pendingClientId)) throw new Error('Choose one ChatGPT registration.');
      starting = true;
      startingDone = new Promise<void>((resolve) => { finishStarting = resolve; });
      try {
        const snapshot = await options.profiles.read();
        if (settings?.enablePlanUsage && snapshot.selected?.state !== 'plan-disabled') throw new Error('No identity-only ChatGPT account is selected.');
        if (settings?.pendingClientId && !(await options.profiles.listIncompleteRegistrations()).includes(settings.pendingClientId)) throw new Error('ChatGPT registration is unavailable.');
        const callback = await (options.startCallback ?? startChatGptCallback)({
          hostId: snapshot.hostId,
          ...(settings?.enablePlanUsage ? { promptConsent: true } : {}),
          ...(settings?.pendingClientId ? { clientId: settings.pendingClientId }
            : !settings?.newAccount && snapshot.selected ? { clientId: snapshot.selected.clientId } : {}),
        });
        if (disposed) {
          void callback.completion.catch(() => undefined);
          callback.cancel();
          throw new Error('ChatGPT sign-in manager is closed.');
        }
        const attempt: PendingAttempt = { id: randomUUID(), callback, cancelled: false, abort: new AbortController(), completion: Promise.resolve({ state: 'disconnected' }) };
        pending = attempt;
        completed = undefined;
        lastFailure = false;
        attempt.completion = finishLogin(attempt, settings?.newAccount || settings?.pendingClientId ? { ...snapshot, selected: undefined } : snapshot);
        return { state: 'pending', loginId: attempt.id, authUrl: callback.attempt.url };
      } finally { starting = false; finishStarting?.(); startingDone = undefined; finishStarting = undefined; }
    },
    waitForLogin: async (loginId, signal) => {
      const attempt = pending;
      if (!attempt || attempt.id !== loginId) return completed?.loginId === loginId ? completed.status : status();
      if (!signal) return attempt.completion;
      if (signal.aborted) return cancelAttempt(attempt);
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const outcome = await Promise.race([attempt.completion, interrupted]);
        return outcome === 'aborted' ? cancelAttempt(attempt) : outcome;
      } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    },
    cancelLogin: async (loginId) => {
      const attempt = pending;
      if (!attempt || attempt.id !== loginId) return;
      await cancelAttempt(attempt);
    },
    dispose: async () => {
      disposed = true;
      await startingDone;
      if (pending) await cancelAttempt(pending);
    },
    listIncompleteRegistrations: () => options.profiles.listIncompleteRegistrations(),
    listAccounts: () => options.profiles.listAccounts(),
    selectAccount: async (clientId) => {
      if (signingOut) throw new Error('ChatGPT account change is already in progress.');
      signingOut = true;
      try {
        await startingDone;
        if (pending) await cancelAttempt(pending);
        const selected = await options.profiles.selectAccount(clientId);
        if (selected) { lastFailure = false; completed = undefined; }
        return selected;
      } finally { signingOut = false; }
    },
    signOut: async () => {
      if (signingOut) throw new Error('ChatGPT sign-out is already in progress.');
      signingOut = true;
      try {
        await startingDone;
        if (pending) await cancelAttempt(pending);
        const confirmed = await options.profiles.signOutAndRevoke(options.revoke ?? revokeChatGptSession);
        lastFailure = false;
        completed = undefined;
        return { remoteRevocationConfirmed: confirmed };
      } finally { signingOut = false; }
    },
    getActiveSession: async (): Promise<SiwcActiveSession | undefined> => {
      const snapshot = await options.profiles.read();
      const selected = snapshot.selected;
      if (!selected || selected.state !== 'connected') return undefined;
      const session = await options.credentials.withClientLock(selected.clientId, async (store) => {
        let tokens = await store.read();
        if (!tokens || tokens.clientId !== selected.clientId || tokens.identity.subject !== selected.subject || !tokens.scopes.includes('chatgpt.tokens.use.direct')) return undefined;
        if (tokens.expiresAt <= (options.now ?? Date.now)() + 60_000) {
          try {
            tokens = await (options.refresh ?? refreshChatGptTokens)({ previous: tokens });
            await store.write(tokens);
          } catch (error) {
            if (error instanceof ChatGptTokenError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) {
              // Invalidation runs after releasing this credential lock to avoid lock inversion.
              return { terminalRefresh: true as const, failedRefreshDigest: createHash('sha256').update(tokens.refreshToken).digest('hex') };
            }
            throw error;
          }
        }
        return tokens;
      });
      if (!session) return undefined;
      if ('terminalRefresh' in session) {
        await options.profiles.invalidateSession(snapshot.revision, selected.clientId, session.failedRefreshDigest);
        throw new Error('ChatGPT sign-in expired. Connect again.');
      }
      const current = await options.profiles.read();
      if (current.revision !== snapshot.revision || current.selected?.clientId !== selected.clientId) return undefined;
      const accountKey = createHash('sha256').update(JSON.stringify([selected.clientId, selected.subject])).digest('hex');
      return { accountKey, accessToken: session.accessToken, scopes: session.scopes };
    },
  };
}
