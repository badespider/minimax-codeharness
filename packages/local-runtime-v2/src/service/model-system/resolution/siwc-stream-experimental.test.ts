import { describe, expect, it, vi } from 'vitest';
import { Type, type Model, type Message } from '@earendil-works/pi-ai';
import { agentLoop, type AgentMessage } from '@earendil-works/pi-agent-core';
import { withExperimentalSiwcStream } from './siwc-stream-experimental.js';
import { LocalModelResolver } from './local-model-resolver.js';
import { EXPERIMENTAL_SIWC_PROVIDER_ID } from '../identity.js';

function testSiwcStream(input: Omit<Parameters<typeof withExperimentalSiwcStream>[0], 'withTokenLease'> & Partial<Pick<Parameters<typeof withExperimentalSiwcStream>[0], 'withTokenLease'>>) {
  return withExperimentalSiwcStream({ ...input, withTokenLease: input.withTokenLease ?? (async (action, signal) => action(await input.getAccessToken(), signal ?? new AbortController().signal)) });
}

const model: Model<'openai-responses'> = {
  id: 'test', name: 'test', provider: 'siwc-test', api: 'openai-responses', baseUrl: 'https://invalid.example',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000,
};
const call = (id: string, name: string, value: string) => ({ type: 'function_call', id: `item_${id}`, call_id: id, namespace: 'minimax', name, arguments: JSON.stringify({ value }), status: 'completed' });
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const done = (output: object[]) => ({ type: 'response.completed', response: { id: 'resp_test', status: 'completed', output } });
const frames = (items: object[]) => items.map(event).join('');

function mockFetch(contents: string[], requests: Request[]) {
  return vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(raw, init);
    requests.push(request);
    const body = contents.shift();
    if (body === undefined) throw new Error('Unexpected request');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}
function callFrames(a = call('a', 'alpha', '1'), b = call('b', 'beta', '2')) {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...a, arguments: '' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...b, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"value":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"value":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"2"}' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"1"}' },
    { type: 'response.output_item.done', output_index: 0, item: a },
    { type: 'response.output_item.done', output_index: 1, item: b },
  ];
}
const textItem = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'finished', annotations: [] }] };
const textEvents = [
  { type: 'response.output_item.added', output_index: 0, item: { ...textItem, content: [] } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'finished' },
  { type: 'response.output_item.done', output_index: 0, item: textItem },
  done([textItem]),
];

async function runLoop(first: string, second?: string) {
  const requests: Request[] = [];
  const executions: string[] = [];
  const tools = ['alpha', 'beta'].map((name) => ({
    name, label: name, description: name, parameters: Type.Object({ value: Type.String() }),
    execute: async (_id: string, args: { value: string }) => { executions.push(`${name}:${args.value}`); return { content: [{ type: 'text' as const, text: 'ok' }], details: {} }; },
  }));
  const streamFn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([first, ...(second ? [second] : [])], requests) });
  const stream = agentLoop([{ role: 'user', content: 'run', timestamp: Date.now() }], { systemPrompt: 'system', messages: [], tools }, {
    model, convertToLlm: (messages) => messages as Message[],
  }, undefined, streamFn);
  const events = [];
  for await (const ev of stream) events.push(ev);
  const messages = await stream.result();
  return { requests, executions, events, messages };
}

describe('experimental SIWC Pi stream adapter', () => {
  it('executes parallel completed calls and replays them in the next turn', async () => {
    const a = call('a', 'alpha', '1'); const b = call('b', 'beta', '2');
    const result = await runLoop(frames([...callFrames(a, b), done([a, b])]), frames(textEvents));
    expect(result.executions.sort()).toEqual(['alpha:1', 'beta:2']);
    expect(result.requests).toHaveLength(2);
    for (const request of result.requests) {
      expect(request.url).toBe('https://api.openai.com/v1/responses');
      expect(request.redirect).toBe('error');
      expect(request.headers.get('authorization')).toBe('Bearer fake-token');
    }
    const first = await result.requests[0]!.json();
    const second = await result.requests[1]!.json();
    expect(first).toMatchObject({ model: 'test', store: false, stream: true });
    expect(first.max_output_tokens).toBeUndefined();
    expect(first.tools[0].type).toBe('namespace');
    expect(second.input.filter((x: { type: string }) => x.type === 'function_call').every((x: { namespace: string }) => x.namespace === 'minimax')).toBe(true);
    expect(second.input.filter((x: { type: string }) => x.type === 'function_call_output')).toHaveLength(2);
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  });

  it.each([
    ['EOF', frames(callFrames())],
    ['incomplete', frames([...callFrames(), { type: 'response.incomplete', response: { status: 'incomplete' } }])],
    ['failed', frames([...callFrames(), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])],
    ['foreign namespace', frames([...callFrames(), done([{ ...call('a', 'alpha', '1'), namespace: 'foreign' }, call('b', 'beta', '2')])])],
  ])('does not execute tools on %s', async (_label, body) => {
    const result = await runLoop(body);
    expect(result.executions).toEqual([]);
    expect(result.requests).toHaveLength(1);
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' });
  });

  it('does not activate for another provider', async () => {
    const fallback = vi.fn(() => { throw new Error('unchanged'); });
    const stream = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => { throw new Error('unexpected'); }, fetchImpl: vi.fn() as unknown as typeof fetch, fallback });
    expect(() => stream({ ...model, provider: 'other' }, { messages: [] })).toThrow('unchanged');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('does not expose provisional tool calls to stream or native observers on EOF', async () => {
    const raw = frames([...callFrames(), { type: 'response.output_item.added', output_index: 2, item: { ...textItem, content: [] } }, { type: 'response.output_text.delta', output_index: 2, delta: 'working' }]);
    const observer = vi.fn();
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([raw], []) });
    const stream = await fn(model, { messages: [], tools: [{ name: 'alpha', description: 'a', parameters: Type.Object({ value: Type.String() }) }, { name: 'beta', description: 'b', parameters: Type.Object({ value: Type.String() }) }] }, { onProviderStreamEvent: observer });
    const events = [];
    for await (const ev of stream) events.push(ev);
    expect(observer).not.toHaveBeenCalled();
    expect(events.some((ev) => ev.type.startsWith('toolcall_'))).toBe(false);
    for (const ev of events) if ('partial' in ev) expect(ev.partial.content.some((c) => c.type === 'toolCall')).toBe(false);
    expect((await stream.result()).stopReason).toBe('error');
  });

  it('redacts raw network exceptions from callbacks and final errors', async () => {
    const onError = vi.fn();
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: (async () => { throw new Error('oops fake-token'); }) as typeof fetch });
    const stream = await fn(model, { messages: [] }, { onProviderError: onError });
    for await (const _ of stream) { /* drain */ }
    const result = await stream.result();
    expect(JSON.stringify(result)).not.toContain('fake-token');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).not.toContain('fake-token');
  });

  it('pins endpoint and bearer despite caller base URL, headers and fetch overrides', async () => {
    const requests: Request[] = [];
    const rogue = vi.fn();
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([frames(textEvents)], requests) });
    const stream = await fn({ ...model, headers: { Authorization: 'Bearer wrong' } }, { messages: [] }, { headers: { Authorization: 'Bearer wrong-again' }, fetch: rogue });
    for await (const _ of stream) { /* drain */ }
    expect(rogue).not.toHaveBeenCalled();
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer fake-token');
    expect(requests[0]!.redirect).toBe('error');
    expect((await stream.result()).stopReason).toBe('stop');
  });
  it('consumes the response inside the account lease and releases it before emitting done', async () => {
    const requests: Request[] = [];
    let released = false;
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'old-preflight', fetchImpl: mockFetch([frames(textEvents)], requests), withTokenLease: async (action) => {
      await action('fresh-lease-token', new AbortController().signal);
      released = true;
    } });
    const stream = await fn(model, { messages: [] });
    for await (const ev of stream) if (ev.type === 'done') expect(released).toBe(true);
    expect((await stream.result()).stopReason).toBe('stop');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer fresh-lease-token');
  });
  it('emits full verified argument deltas for proxy consumers', async () => {
    const a = call('a', 'alpha', '1'); const b = call('b', 'beta', '2');
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([frames([...callFrames(a, b), done([a, b])])], []) });
    const stream = await fn(model, { messages: [], tools: ['alpha', 'beta'].map((name) => ({ name, description: name, parameters: Type.Object({ value: Type.String() }) })) });
    const deltas: string[] = [];
    for await (const ev of stream) if (ev.type === 'toolcall_delta') deltas.push(ev.delta);
    expect(deltas.map((delta) => JSON.parse(delta))).toEqual([{ value: '1' }, { value: '2' }]);
  });
  it('does not issue a request or emit tools if the account lease is rejected', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'preflight', fetchImpl, withTokenLease: async () => { throw new Error('account changed'); } });
    const stream = await fn(model, { messages: [] });
    const events = [];
    for await (const ev of stream) events.push(ev);
    expect((await stream.result()).stopReason).toBe('error');
    expect(events.some((ev) => ev.type.startsWith('toolcall_'))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects caller payload callbacks that change the account-selected model', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl });
    const stream = await fn(model, { messages: [] }, { onPayload: (payload) => ({ ...(payload as object), model: 'different-model' }) });
    for await (const _ of stream) { /* drain */ }
    expect((await stream.result()).stopReason).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects extra events after a completed terminal event', async () => {
    const extra = { type: 'response.output_text.delta', output_index: 0, delta: 'late' };
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([frames([...textEvents, extra])], []) });
    const stream = await fn(model, { messages: [] });
    for await (const _ of stream) { /* drain */ }
    expect((await stream.result()).stopReason).toBe('error');
  });

  it.each([401, 403, 429, 503])('keeps safe recovery details for HTTP %s', async (status) => {
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fake-token' } }), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test123' } })) as typeof fetch });
    const stream = await fn(model, { messages: [] });
    for await (const _ of stream) { /* drain */ }
    const result = await stream.result();
    expect(result.errorMessage).toContain(`HTTP ${status}`);
    expect(result.errorMessage).toContain('subscription_sharing_usage_limit_exceeded');
    expect(result.errorMessage).not.toContain('fake-token');
  });

  it('reports cancellation without exposing provider errors', async () => {
    const controller = new AbortController(); controller.abort();
    const fn = testSiwcStream({ provider: 'siwc-test', getAccessToken: async () => 'fake-token', fetchImpl: (async () => { throw new Error('fake-token'); }) as typeof fetch });
    const stream = await fn(model, { messages: [] }, { signal: controller.signal });
    for await (const _ of stream) { /* drain */ }
    const result = await stream.result();
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).not.toContain('fake-token');
  });

  it('can be explicitly injected through the existing LocalModelResolver streamFn seam', async () => {
    const requests: Request[] = [];
    const injected = testSiwcStream({ provider: 'custom_provider:siwc-experiment', getAccessToken: async () => 'fake-token', fetchImpl: mockFetch([frames(textEvents)], requests) });
    const resolver = new LocalModelResolver({
      streamFn: injected,
      byokConfigGetter: () => ({ custom_provider: { 'siwc-experiment': {
        api: 'openai-responses', options: { apiKey: 'placeholder-only', baseURL: 'https://unused.example/v1' },
        models: { test: { limit: { context: 8000, output: 1000 } } },
      } } }),
    });
    const resolved = await resolver.resolveModel({ sessionId: 's', turnId: 't', agentConfig: {
      agent_id: 'test', system_prompt: 'system', tools: [], skills: [], model: { provider: 'custom_provider:siwc-experiment', model_id: 'test' },
    } });
    const stream = await resolved.streamFn!(resolved.model, { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] }, { apiKey: resolved.apiKey });
    const events = [];
    for await (const ev of stream) events.push(ev);
    expect((await stream.result()).stopReason).toBe('stop');
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer fake-token');
    expect(events.at(-1)?.type).toBe('done');
  });

  const siwcInput = {
    sessionId: 's', turnId: 't', agentConfig: { agent_id: 'test', system_prompt: 'system', tools: [], skills: [], model: { provider: EXPERIMENTAL_SIWC_PROVIDER_ID, model_id: 'test' } },
  };
  const validSession = { accountKey: 'account-a', accessToken: 'fake-token', scopes: ['chatgpt.tokens.use.direct'] };

  it('fails closed when the reserved SIWC provider has not been injected', async () => {
    const resolver = new LocalModelResolver({ providerConfig: { fallback: { models: { normal: {} }, options: { apiKey: 'key', baseURL: 'https://example.invalid' } } } });
    await expect(resolver.resolveModel(siwcInput)).rejects.toThrow('experimental SIWC provider is disabled');
  });

  it('resolves only the selected account catalog and fetches a fresh same-account token', async () => {
    const requests: Request[] = [];
    const getActiveSession = vi.fn().mockResolvedValueOnce(validSession).mockResolvedValueOnce({ ...validSession, accessToken: 'refreshed-fake-token' });
    const getModel = vi.fn().mockResolvedValue({ contextWindow: 8000, maxTokens: 1000 });
    const resolver = new LocalModelResolver({ experimentalSiwc: { getActiveSession, getModel, withActiveTokenLease: async (_account, action) => action('refreshed-fake-token', new AbortController().signal), fetchImpl: mockFetch([frames(textEvents)], requests) } });
    const resolved = await resolver.resolveModel(siwcInput);
    expect(getModel).toHaveBeenCalledWith('account-a', 'test');
    expect(resolved.model).toMatchObject({ provider: EXPERIMENTAL_SIWC_PROVIDER_ID, api: 'openai-responses', contextWindow: 8000, maxTokens: 1000, baseUrl: 'https://api.openai.com/v1' });
    expect(JSON.stringify(resolved)).not.toContain('fake-token');
    const stream = await resolved.streamFn!(resolved.model, { messages: [] }, { apiKey: resolved.apiKey });
    for await (const _ of stream) { /* drain */ }
    expect((await stream.result()).stopReason).toBe('stop');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer refreshed-fake-token');
  });

  it.each([
    ['missing session', undefined],
    ['missing scope', { ...validSession, scopes: [] }],
    ['invalid token', { ...validSession, accessToken: '' }],
  ])('rejects %s before model lookup', async (_name, session) => {
    const getModel = vi.fn();
    const resolver = new LocalModelResolver({ experimentalSiwc: { getActiveSession: async () => session, getModel } });
    await expect(resolver.resolveModel(siwcInput)).rejects.toThrow('SIWC login');
    expect(getModel).not.toHaveBeenCalled();
  });

  it('rejects unknown account models and sanitizes supplier failures', async () => {
    const missing = new LocalModelResolver({ experimentalSiwc: { getActiveSession: async () => validSession, getModel: async () => undefined } });
    await expect(missing.resolveModel(siwcInput)).rejects.toThrow('unavailable for the selected account');
    const broken = new LocalModelResolver({ experimentalSiwc: { getActiveSession: async () => { throw new Error('fake-token'); }, getModel: async () => undefined } });
    await expect(broken.resolveModel(siwcInput)).rejects.toThrow('SIWC session unavailable');
  });

  it.each([
    ['account changed', { ...validSession, accountKey: 'account-b' }],
    ['session revoked', undefined],
    ['scope revoked', { ...validSession, scopes: [] }],
  ])('does not issue a network request after %s', async (_name, replacement) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const getActiveSession = vi.fn().mockResolvedValueOnce(validSession).mockResolvedValueOnce(replacement);
    const resolver = new LocalModelResolver({ experimentalSiwc: { getActiveSession, getModel: async () => ({ contextWindow: 8000, maxTokens: 1000 }), fetchImpl } });
    const resolved = await resolver.resolveModel(siwcInput);
    const stream = await resolved.streamFn!(resolved.model, { messages: [] }, { apiKey: resolved.apiKey });
    for await (const _ of stream) { /* drain */ }
    expect((await stream.result()).stopReason).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not consult SIWC dependencies for ordinary configured providers', async () => {
    const getActiveSession = vi.fn();
    const getModel = vi.fn();
    const options = { byokConfigGetter: () => ({ custom_provider: { work: { api: 'openai-responses' as const, options: { apiKey: 'normal-key', baseURL: 'https://example.invalid/v1' }, models: { test: { limit: { context: 8000, output: 1000 } } } } } }) };
    const ordinary = { ...siwcInput, agentConfig: { ...siwcInput.agentConfig, model: { provider: 'custom_provider:work', model_id: 'test' } } };
    const baseline = await new LocalModelResolver(options).resolveModel(ordinary);
    const withSiwc = await new LocalModelResolver({ ...options, experimentalSiwc: { getActiveSession, getModel } }).resolveModel(ordinary);
    expect(withSiwc.model).toEqual(baseline.model);
    expect(withSiwc.apiKey).toBe('normal-key');
    expect(getActiveSession).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
  });
});
