import { describe, expect, it, vi } from 'vitest';
import { createTuiProgram } from '../cli/program.js';
import { projectExperimentalSiwcModels } from './experimental-siwc-projection.js';
import { ExperimentalSiwcOwner } from '../../../local-runtime-v2/src/service/model-system/siwc-catalog-experimental.js';
import { LocalModelResolver } from '../../../local-runtime-v2/src/service/model-system/resolution/local-model-resolver.js';
import { resolveRequestedSessionModel } from '../../../local-runtime-v2/src/service/model-system/catalog/model-selection.js';
import { resolveTurnModelSelection } from '../../../local-runtime-v2/src/service/turn-system/agent-host/preparation/config/session-model-selection.js';

describe('SIWC in-memory launch projection', () => {
  it('does not mutate persisted configuration or overwrite a reserved provider', () => {
    const saved = { dataDir: '/test', provider: { minimax: { models: { standard: {} } } } };
    const projected = projectExperimentalSiwcModels(saved, [{ slug: 'model', displayName: 'Model', contextWindow: 8000, maxTokens: 1000 }]);
    expect(saved.provider).not.toHaveProperty('openai-siwc-experimental');
    expect(projected.provider?.['openai-siwc-experimental']?.models?.model?.limit).toEqual({ context: 8000, output: 1000 });
    expect(() => projectExperimentalSiwcModels(projected, [])).toThrow('conflicts');
  });

  it('uses the account catalog through CLI model override, session and turn gates, then the SIWC resolver', async () => {
    const requests: string[] = [];
    const getActiveSession = async () => ({ accountKey: 'account', accessToken: 'fake-token', scopes: ['chatgpt.tokens.use.direct'] });
    const modelResponse = { models: [{ slug: 'model', display_name: 'Model', visibility: 'list' }] };
    const fetchImpl: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init);
      requests.push(request.url);
      if (request.url.endsWith('/models')) return new Response(JSON.stringify(modelResponse));
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const owner = new ExperimentalSiwcOwner({ getActiveSession, withActiveTokenLease: async (_account, action) => action('fake-token', new AbortController().signal), getModelLimits: async () => ({ contextWindow: 8000, maxTokens: 1000 }), fetchImpl });
    const catalog = await owner.listSelectableModels();
    const config = projectExperimentalSiwcModels({ dataDir: '/test', defaultModel: 'minimax/standard', provider: { minimax: { models: { standard: {} } } } }, catalog.models);
    const launchTui = vi.fn(async () => undefined);
    const program = createTuiProgram({ version: 'test', launchTui, runExec: vi.fn(), runLogin: vi.fn(), runLogout: vi.fn(), runUpdate: vi.fn(), resolveLane: () => undefined });
    await program.parseAsync(['node', 'mcode', '-m', 'openai-siwc-experimental/model']);
    expect(launchTui).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai-siwc-experimental/model' }));
    const selected = resolveRequestedSessionModel(config, { providerId: 'openai-siwc-experimental', modelId: 'model' });
    const turn = await resolveTurnModelSelection({ config, session: { sessionId: 's' } as never, requested: { provider_id: selected.providerId, model_id: selected.modelId } });
    expect(turn).toMatchObject({ providerId: 'openai-siwc-experimental', modelId: 'model' });
    const resolver = new LocalModelResolver({ experimentalSiwc: owner.resolverProvider });
    const resolved = await resolver.resolveModel({ sessionId: 's', turnId: 't', agentConfig: { agent_id: 'a', system_prompt: '', tools: [], skills: [], model: { provider: turn.providerId, model_id: turn.modelId } } });
    const stream = await resolved.streamFn!(resolved.model, { messages: [] }, { apiKey: resolved.apiKey });
    for await (const _ of stream) { /* drain */ }
    expect((await stream.result()).stopReason).toBe('stop');
    expect(requests.at(-1)).toBe('https://api.openai.com/v1/responses');
  });
});
