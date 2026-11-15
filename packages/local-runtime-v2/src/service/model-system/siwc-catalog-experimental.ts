import type { ExperimentalSiwcProvider } from './contracts.js';
import { EXPERIMENTAL_SIWC_PROVIDER_ID } from './identity.js';

const MODELS_URL = 'https://api.openai.com/v1/models';

export interface ExperimentalSiwcCatalogModel {
  readonly slug: string;
  readonly displayName: string;
}

export interface ExperimentalSiwcOwnerOptions {
  readonly getActiveSession: ExperimentalSiwcProvider['getActiveSession'];
  readonly withActiveTokenLease?: ExperimentalSiwcProvider['withActiveTokenLease'];
  /** Trusted metadata must be obtained separately; do not invent model limits. */
  readonly getModelLimits: (accountKey: string, modelId: string) => Promise<{ readonly contextWindow: number; readonly maxTokens: number } | undefined>;
  /** Trusted injected fetch intended for testing; never derive it from provider config. */
  readonly fetchImpl?: typeof fetch;
  /** Runtime-owned credentials manager cleanup. */
  readonly dispose?: () => Promise<void>;
  /** Writer must atomically check account identity against the same lock as signout/switch. */
  readonly selectModel?: (accountKey: string, modelKey: string) => Promise<void>;
}

/** Internal-only prototype. No default startup path constructs this owner. */
export class ExperimentalSiwcOwner {
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: ExperimentalSiwcOwnerOptions) {}

  dispose(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.resolve().then(() => this.options.dispose?.());
    }
    return this.closing;
  }

  async listModels(): Promise<{ readonly accountKey: string; readonly models: readonly ExperimentalSiwcCatalogModel[] }> {
    const session = await this.readSession();
    if (!this.options.withActiveTokenLease) throw new Error('SIWC account lease unavailable');
    const data = await this.options.withActiveTokenLease(session.accountKey, async (token, signal) => {
      const response = await (this.options.fetchImpl ?? globalThis.fetch)(MODELS_URL, {
        method: 'GET', redirect: 'error', signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      }).catch(() => { throw new Error('SIWC model discovery unavailable'); });
      if (!response.ok) throw new Error(`SIWC model discovery failed (HTTP ${response.status})`);
      try { return await response.json() as unknown; } catch { throw new Error('SIWC model discovery returned invalid JSON'); }
    }, { signal: AbortSignal.timeout(10_000) });
    const after = await this.readSession();
    if (after.accountKey !== session.accountKey) throw new Error('SIWC account changed during model discovery');
    if (!data || typeof data !== 'object' || !('models' in data) || !Array.isArray(data.models)) throw new Error('SIWC model discovery returned an invalid catalog');
    const seen = new Set<string>();
    const models: ExperimentalSiwcCatalogModel[] = [];
    for (const entry of data.models) {
      if (!entry || typeof entry !== 'object' || entry.visibility !== 'list' || typeof entry.slug !== 'string' || !entry.slug.trim() || typeof entry.display_name !== 'string' || !entry.display_name.trim()) continue;
      if (seen.has(entry.slug)) continue;
      seen.add(entry.slug);
      models.push({ slug: entry.slug, displayName: entry.display_name });
    }
    return { accountKey: session.accountKey, models };
  }

  async listSelectableModels(): Promise<{ readonly accountKey: string; readonly models: readonly (ExperimentalSiwcCatalogModel & { readonly contextWindow: number; readonly maxTokens: number })[] }> {
    const listing = await this.listModels();
    const models: (ExperimentalSiwcCatalogModel & { contextWindow: number; maxTokens: number })[] = [];
    for (const model of listing.models) {
      const limits = await this.getLimits(listing.accountKey, model.slug);
      if (limits && Number.isSafeInteger(limits.contextWindow) && limits.contextWindow > 0 && Number.isSafeInteger(limits.maxTokens) && limits.maxTokens > 0) models.push({ ...model, ...limits });
    }
    if ((await this.readSession()).accountKey !== listing.accountKey) throw new Error('SIWC account changed during model selection');
    return { accountKey: listing.accountKey, models };
  }

  async selectModel(modelId: string): Promise<void> {
    if (!this.options.selectModel) throw new Error('SIWC model selection is unavailable');
    const listing = await this.listSelectableModels();
    if (!listing.models.some((model) => model.slug === modelId)) throw new Error('SIWC model unavailable for selected account');
    if ((await this.readSession()).accountKey !== listing.accountKey) throw new Error('SIWC account changed during model selection');
    await this.options.selectModel(listing.accountKey, `${EXPERIMENTAL_SIWC_PROVIDER_ID}/${modelId}`);
  }

  get resolverProvider(): ExperimentalSiwcProvider { return {
    getActiveSession: () => this.readSession(),
    ...(this.options.withActiveTokenLease ? { withActiveTokenLease: this.options.withActiveTokenLease } : {}),
    getModel: async (accountKey, modelId) => {
      const listing = await this.listModels();
      if (listing.accountKey !== accountKey || !listing.models.some((model) => model.slug === modelId)) return undefined;
      const limits = await this.getLimits(accountKey, modelId);
      const after = await this.readSession();
      if (after.accountKey !== accountKey) throw new Error('SIWC account changed during model resolution');
      return limits;
    },
    ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
  }; }

  private async getLimits(accountKey: string, modelId: string) {
    if (this.closed) throw new Error('SIWC owner is closed');
    try { return await this.options.getModelLimits(accountKey, modelId); }
    catch { throw new Error('SIWC model limits unavailable'); }
  }

  private async readSession(): Promise<NonNullable<Awaited<ReturnType<ExperimentalSiwcProvider['getActiveSession']>>>> {
    if (this.closed) throw new Error('SIWC owner is closed');
    let session: Awaited<ReturnType<ExperimentalSiwcProvider['getActiveSession']>>;
    try { session = await this.options.getActiveSession(); } catch { throw new Error('SIWC session unavailable'); }
    if (this.closed) throw new Error('SIWC owner is closed');
    if (!session || !session.accountKey?.trim() || !session.accessToken?.trim() || /[\r\n]/.test(session.accessToken) || !session.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('SIWC login with plan permission is required');
    return session;
  }
}
