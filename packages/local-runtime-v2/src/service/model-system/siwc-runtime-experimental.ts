import { join } from 'node:path';
import { getModels } from '@earendil-works/pi-ai';
import { createSiwcAuthManager } from './siwc-auth-manager.js';
import { createChatGptIdentityVerifier } from './siwc-identity.js';
import { WindowsChatGptProfileStore } from './siwc-profile-storage.js';
import type { ExperimentalSiwcOwnerOptions } from './siwc-catalog-experimental.js';

/**
 * Trusted owner factory only. Deliberately not called by normal CLI startup.
 * This uses a MiniMax-specific data directory, never Codex credentials.
 */
export function createExperimentalSiwcRuntime(input: {
  readonly dataDir: string;
  readonly getModelLimits?: ExperimentalSiwcOwnerOptions['getModelLimits'];
  readonly selectModel?: NonNullable<ExperimentalSiwcOwnerOptions['selectModel']>;
  /** Trusted test transport only; never obtain from provider config. */
  readonly fetchImpl?: typeof fetch;
}) {
  const profileStore = new WindowsChatGptProfileStore(join(input.dataDir, 'minimax-chatgpt-plan'));
  const auth = createSiwcAuthManager({ profiles: profileStore, credentials: profileStore, verifyIdentity: createChatGptIdentityVerifier() });
  const ownerOptions: ExperimentalSiwcOwnerOptions = {
    getActiveSession: () => auth.getActiveSession(),
    withActiveTokenLease: (accountKey, action, options) => profileStore.withActiveTokenLease(accountKey, action, options),
    getModelLimits: input.getModelLimits ?? getKnownOpenAiModelLimits,
    selectModel: input.selectModel ?? (async (accountKey, modelKey) => {
      if (!(await profileStore.selectModel(accountKey, modelKey))) throw new Error('ChatGPT account changed during model selection.');
    }),
    dispose: () => auth.dispose(),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  return {
    auth,
    ownerOptions,
    getSelectedModel: async () => {
      const profile = await profileStore.read();
      return profile.selected?.state === 'connected' ? profile.selected.modelKey : undefined;
    },
  };
}

/** Exact-match local Pi model catalog only; unknown account slugs stay unavailable. */
export async function getKnownOpenAiModelLimits(_accountKey: string, modelId: string) {
  // OpenAI's published model pages (checked 2026-11-15). Sol uses the
  // conservative 500K Codex/ChatGPT Work context documented on its page.
  // These are only considered after the account-specific roster contains the ID.
  const documented: Readonly<Record<string, { contextWindow: number; maxTokens: number }>> = {
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol
    'gpt-6.1-sol': { contextWindow: 500_000, maxTokens: 128_000 },
    // https://developers.openai.com/api/docs/models/gpt-6.1-terra
    'gpt-6.1-terra': { contextWindow: 1_050_000, maxTokens: 128_000 },
    // https://developers.openai.com/api/docs/models/gpt-6-astra
    'gpt-6-astra': { contextWindow: 1_050_000, maxTokens: 128_000 },
  };
  if (documented[modelId]) return documented[modelId];
  const model = getModels('openai').find((entry) => entry.id === modelId);
  if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) return undefined;
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}
