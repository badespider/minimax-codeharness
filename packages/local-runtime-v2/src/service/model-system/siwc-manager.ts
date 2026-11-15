import { discoverSiwcModels } from './connectivity/siwc-model-discovery.js';

export type SiwcStatus =
  | { readonly state: 'disconnected' }
  | { readonly state: 'pending'; readonly loginId: string; readonly authUrl: string }
  | { readonly state: 'connected' }
  | { readonly state: 'plan-disabled' }
  | { readonly state: 'failed' };

/** This is a verified active account, never a raw decoded JWT or legacy Codex credential. */
export interface SiwcActiveSession {
  readonly accountKey: string;
  readonly accessToken: string;
  readonly scopes: readonly string[];
}

/** The auth owner validates identity, refreshes credentials and commits login atomically. */
export interface SiwcManagerAuthPort {
  getStatus(): Promise<SiwcStatus>;
  startLogin(options?: { readonly newAccount?: boolean; readonly pendingClientId?: string; readonly enablePlanUsage?: boolean }): Promise<SiwcStatus>;
  waitForLogin(loginId: string, signal?: AbortSignal): Promise<SiwcStatus>;
  cancelLogin(loginId: string): Promise<void>;
  getActiveSession(): Promise<SiwcActiveSession | undefined>;
}

export interface SiwcManagerOptions {
  readonly auth: SiwcManagerAuthPort;
  /** Called only after checking the account-scoped model roster and active session. */
  readonly selectModel: (accountKey: string, slug: string) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

/** SIWC remains disabled until the real auth port and model resolver are wired. */
export function createSiwcManager(options: SiwcManagerOptions) {
  async function activePlanSession(): Promise<SiwcActiveSession | undefined> {
    const session = await options.auth.getActiveSession();
    if (!session?.accountKey || !session.accessToken || !session.scopes.includes('chatgpt.tokens.use.direct')) return undefined;
    return session;
  }

  async function checkedStatus(status: SiwcStatus): Promise<SiwcStatus> {
    if (status.state !== 'connected') return status;
    const session = await options.auth.getActiveSession();
    if (!session) return { state: 'disconnected' };
    return session.accountKey && session.accessToken && session.scopes.includes('chatgpt.tokens.use.direct')
      ? status : { state: 'plan-disabled' };
  }

  async function currentModels() {
    const session = await activePlanSession();
    if (!session) throw new Error('ChatGPT plan permission is required.');
    const models = await discoverSiwcModels(session.accessToken, { fetchImpl: options.fetchImpl });
    const current = await activePlanSession();
    if (!current || current.accountKey !== session.accountKey) throw new Error('ChatGPT account changed during model discovery.');
    return { accountKey: session.accountKey, models };
  }

  return {
    getStatus: async () => checkedStatus(await options.auth.getStatus()),
    startLogin: async (settings?: { readonly newAccount?: boolean; readonly pendingClientId?: string; readonly enablePlanUsage?: boolean }) => checkedStatus(await options.auth.startLogin(settings)),
    waitForLogin: async (loginId: string, signal?: AbortSignal) => checkedStatus(await options.auth.waitForLogin(loginId, signal)),
    cancelLogin: (loginId: string) => options.auth.cancelLogin(loginId),
    listModels: async () => (await currentModels()).models,
    selectModel: async (slug: string) => {
      const { accountKey, models } = await currentModels();
      if (!models.some((model) => model.slug === slug)) throw new Error('The selected model is unavailable for this account.');
      // The configuration owner must perform this as a compare-and-set against
      // the accountKey so an account switch cannot race the selection commit.
      await options.selectModel(accountKey, slug);
    },
  };
}
