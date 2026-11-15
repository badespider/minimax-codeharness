import { describe, expect, it, vi } from 'vitest';
import { ExperimentalSiwcOwner, type ExperimentalSiwcOwnerOptions } from './siwc-catalog-experimental.js';
import { initializeModelSystem } from './initialize.js';
import { EXPERIMENTAL_SIWC_PROVIDER_ID } from './identity.js';
import { getKnownOpenAiModelLimits } from './siwc-runtime-experimental.js';
import { getModels } from '@earendil-works/pi-ai';

const session = { accountKey: 'account-a', accessToken: 'fake-token', scopes: ['chatgpt.tokens.use.direct'] };
const testLease: NonNullable<ExperimentalSiwcOwnerOptions['withActiveTokenLease']> = async (_account, action, options) => action('fake-token', options?.signal ?? new AbortController().signal);
function testOwner(options: ExperimentalSiwcOwnerOptions) { return new ExperimentalSiwcOwner({ withActiveTokenLease: testLease, ...options }); }
const modelList = { models: [
  { slug: 'm1', display_name: 'Model 1', visibility: 'list' },
  { slug: 'private', display_name: 'Hidden', visibility: 'hide' },
  { slug: 'm2', display_name: 'Model 2', visibility: 'list' },
  { slug: 'm1', display_name: 'Duplicate', visibility: 'list' },
] };
const limits = async () => ({ contextWindow: 8000, maxTokens: 1000 });
const config = {
  read: () => ({ dataDir: 'C:/unused-siwc-test' }),
  updateByok: vi.fn(), compareAndSetModelContext: vi.fn(), setDefaultModel: vi.fn(), removeProvider: vi.fn(),
} as never;
const selection = { sessionId: 's', turnId: 't', agentConfig: { agent_id: 'x', system_prompt: 's', tools: [], skills: [], model: { provider: EXPERIMENTAL_SIWC_PROVIDER_ID, model_id: 'm1' } } };

describe('experimental SIWC startup and catalog', () => {
  it('uses only exact, known OpenAI catalog limits and fails for unknown models', async () => {
    const known = getModels('openai').find((model) => model.contextWindow > 0 && model.maxTokens > 0)!;
    expect(await getKnownOpenAiModelLimits('account-a', known.id)).toEqual({ contextWindow: known.contextWindow, maxTokens: known.maxTokens });
    expect(await getKnownOpenAiModelLimits('account-a', `${known.id}-unknown`)).toBeUndefined();
    expect(await getKnownOpenAiModelLimits('account-a', 'gpt-6.1-sol')).toEqual({ contextWindow: 500_000, maxTokens: 128_000 });
    expect(await getKnownOpenAiModelLimits('account-a', 'gpt-6.1-terra')).toEqual({ contextWindow: 1_050_000, maxTokens: 128_000 });
  });
  it('does not expose SIWC on normal model-system startup', async () => {
    const owner = initializeModelSystem({ config });
    expect(owner.experimentalSiwc).toBeUndefined();
    await expect(owner.resolver.resolveModel(selection)).rejects.toThrow('provider is disabled');
  });

  it('lists visible account models in server order and pins endpoint and redirect behavior', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(modelList), { headers: { 'content-type': 'application/json' } }));
    const owner = testOwner({ getActiveSession: async () => session, getModelLimits: limits, fetchImpl: fetchImpl as typeof fetch });
    const listing = await owner.listModels();
    expect(listing).toEqual({ accountKey: 'account-a', models: [{ slug: 'm1', displayName: 'Model 1' }, { slug: 'm2', displayName: 'Model 2' }] });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer fake-token' }) }));
    expect(JSON.stringify(listing)).not.toContain('fake-token');
  });

  it('connects an explicitly supplied catalog to the real resolver', async () => {
    const getModelLimits = vi.fn(limits);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(modelList)));
    const owner = initializeModelSystem({ config, experimentalSiwc: { withActiveTokenLease: testLease, getActiveSession: async () => session, getModelLimits, fetchImpl: fetchImpl as typeof fetch } });
    expect(owner.experimentalSiwc).toBeDefined();
    const resolved = await owner.resolver.resolveModel(selection);
    expect(resolved.model).toMatchObject({ id: 'm1', provider: EXPERIMENTAL_SIWC_PROVIDER_ID, contextWindow: 8000, maxTokens: 1000 });
    expect(getModelLimits).toHaveBeenCalledWith('account-a', 'm1');
    await expect(owner.resolver.resolveModel({ ...selection, agentConfig: { ...selection.agentConfig, model: { ...selection.agentConfig.model, model_id: 'private' } } })).rejects.toThrow('unavailable for the selected account');
  });

  it('discards a catalog if account changes during discovery', async () => {
    const getActiveSession = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce({ ...session, accountKey: 'account-b' });
    const owner = testOwner({ getActiveSession, getModelLimits: limits, fetchImpl: (async () => new Response(JSON.stringify(modelList))) as typeof fetch });
    await expect(owner.listModels()).rejects.toThrow('account changed');
  });

  it('fails closed if no plan permission or if catalog/limits are unavailable', async () => {
    const fetchImpl = vi.fn();
    const denied = testOwner({ getActiveSession: async () => ({ ...session, scopes: [] }), getModelLimits: limits, fetchImpl });
    await expect(denied.listModels()).rejects.toThrow('plan permission');
    expect(fetchImpl).not.toHaveBeenCalled();
    const malformed = testOwner({ getActiveSession: async () => session, getModelLimits: limits, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    await expect(malformed.listModels()).rejects.toThrow('invalid catalog');
    const noLimits = initializeModelSystem({ config, experimentalSiwc: { withActiveTokenLease: testLease, getActiveSession: async () => session, getModelLimits: async () => undefined, fetchImpl: (async () => new Response(JSON.stringify(modelList))) as typeof fetch } });
    await expect(noLimits.resolver.resolveModel(selection)).rejects.toThrow('unavailable for the selected account');
  });

  it('does not leak tokens when injected session or fetch fails', async () => {
    const badSession = testOwner({ getActiveSession: async () => { throw new Error('fake-token'); }, getModelLimits: limits });
    await expect(badSession.listModels()).rejects.toThrow('SIWC session unavailable');
    const badFetch = testOwner({ getActiveSession: async () => session, getModelLimits: limits, fetchImpl: (async () => { throw new Error('fake-token'); }) as typeof fetch });
    await expect(badFetch.listModels()).rejects.toThrow('SIWC model discovery unavailable');
  });

  it('projects selectable models and selects only models with trustworthy limits', async () => {
    const selectModel = vi.fn(async () => undefined);
    const owner = testOwner({ getActiveSession: async () => session, getModelLimits: async (_account, id) => id === 'm1' ? limits() : undefined, selectModel, fetchImpl: (async () => new Response(JSON.stringify(modelList))) as typeof fetch });
    const listing = await owner.listSelectableModels();
    expect(listing.models).toEqual([{ slug: 'm1', displayName: 'Model 1', contextWindow: 8000, maxTokens: 1000 }]);
    await owner.selectModel('m1');
    expect(selectModel).toHaveBeenCalledWith('account-a', `${EXPERIMENTAL_SIWC_PROVIDER_ID}/m1`);
    await expect(owner.selectModel('m2')).rejects.toThrow('model unavailable');
    expect(selectModel).toHaveBeenCalledOnce();
  });

  it('closes the supplied manager once and rejects later lookups', async () => {
    const dispose = vi.fn(async () => undefined);
    const getActiveSession = vi.fn(async () => session);
    const owner = testOwner({ getActiveSession, getModelLimits: limits, dispose, fetchImpl: (async () => new Response(JSON.stringify(modelList))) as typeof fetch });
    await Promise.all([owner.dispose(), owner.dispose()]);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(owner.listModels()).rejects.toThrow('owner is closed');
    expect(getActiveSession).not.toHaveBeenCalled();
  });
});
