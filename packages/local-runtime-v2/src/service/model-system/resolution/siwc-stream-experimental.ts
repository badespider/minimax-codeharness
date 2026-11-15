import { isDeepStrictEqual } from 'node:util';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, streamSimple, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';

const URL = 'https://api.openai.com/v1/responses';
const NS = 'minimax';
const ALLOWED_CODES = new Set(['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user', 'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']);
type Obj = Record<string, unknown>;
const record = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Explicitly opt in via LocalModelResolver's streamFn option. Not registered in production. */
export function withExperimentalSiwcStream(input: {
  provider: string;
  getAccessToken: () => Promise<string>;
  withTokenLease: (action: (token: string, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) => Promise<void>;
  /** Trusted internal dependency only; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  fallback?: StreamFn;
}): StreamFn {
  const base = input.fallback ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== input.provider) return base(model, context, options);
    const out = createAssistantMessageEventStream();
    void (async () => {
      let last: AssistantMessage | undefined;
      let terminal: Obj | undefined;
      let incomplete = false;
      let terminalCount = 0;
      let doneCount = 0;
      let afterTerminal = false;
      let finished = false;
      let status: number | undefined;
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let completedEvent: Extract<AssistantMessageEvent, { type: 'done' }> | undefined;
      let failedEvent: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
      let token = '';
      let leaseSignal: AbortSignal | undefined;
      const rememberError = (error: unknown) => {
        if (!record(error)) return;
        if (typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) status = error.status;
        const details = record(error.error) ? error.error : error;
        if (typeof details.code === 'string' && ALLOWED_CODES.has(details.code)) errorCode = details.code;
        const id = error.requestID ?? error.requestId;
        if (typeof id === 'string' && /^req_[a-zA-Z0-9_-]{1,100}$/.test(id) && !id.includes(token)) requestId = id;
      };
      const safeError = () => `SIWC request failed${status ? ` (HTTP ${status})` : ''}${errorCode ? ` [${errorCode}]` : ''}${requestId ? ` request ${requestId}` : ''}`;
      try {
        if (model.api !== 'openai-responses') throw new Error('SIWC requires openai-responses');
        token = await input.getAccessToken();
        if (!token || /[\r\n]/.test(token)) throw new Error('SIWC access token unavailable');
        const perform = async (leasedToken: string, currentLeaseSignal: AbortSignal) => {
        leaseSignal = currentLeaseSignal;
        token = leasedToken;
        if (!token || /[\r\n]/.test(token)) throw new Error('SIWC access token unavailable');
        const securedFetch: typeof fetch = async (request, init) => {
          const prepared = new Request(request, init);
          if (prepared.url !== URL || prepared.method !== 'POST') throw new Error('Rejected non-SIWC endpoint');
          const headers = new Headers(prepared.headers);
          headers.set('authorization', `Bearer ${token}`);
          return (input.fetchImpl ?? globalThis.fetch)(new Request(prepared, { headers, redirect: 'error' }));
        };
        const stream = await streamSimple({ ...model, baseUrl: 'https://api.openai.com/v1', headers: {} }, context, {
          ...options,
          apiKey: token,
          headers: {},
          fetch: securedFetch,
          signal: currentLeaseSignal,
          maxRetries: 0,
          onProviderError: (error, modelArg) => {
            rememberError(error);
            options?.onProviderError?.(new Error(safeError()), modelArg);
          },
          onPayload: async (payload, modelArg) => {
            const changed = await options?.onPayload?.(payload, modelArg);
            const sanitized = siwcPayload(changed === undefined ? payload : changed);
            if (sanitized.model !== model.id) throw new Error('SIWC model override rejected');
            return sanitized;
          },
          onProviderStreamEvent: (event, modelArg) => {
            if (terminalCount > 0) afterTerminal = true;
            if (record(event) && event.type === 'response.completed' && record(event.response)) { terminal = event.response; terminalCount++; }
            if (record(event) && (event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error')) {
              incomplete = true;
              if (record(event.response)) rememberError(event.response);
              else rememberError(event);
            }
          },
        });
        for await (const event of stream) {
          last = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          if (event.type === 'done') {
            doneCount++;
            completedEvent = event;
            finished = true;
          } else if (event.type === 'error') {
            failedEvent = { ...event, error: { ...event.error, content: event.error.content.filter((x) => x.type !== 'toolCall'), errorMessage: safeError() } };
            finished = true;
          } else if (event.type.startsWith('toolcall_')) {
            // Partial tool calls are intentionally withheld.
          } else {
            out.push(snapshotEvent(event));
          }
        }
        if (!finished) throw new Error('SIWC stream ended without a result');
        if (completedEvent) {
          if (failedEvent || doneCount !== 1 || terminalCount !== 1 || afterTerminal) throw new Error('SIWC stream contained invalid terminal events');
          verifyCompletion(terminal, incomplete, completedEvent.message, context.tools?.map((t) => t.name) ?? []);
        }
        };
        await input.withTokenLease(perform, options?.signal);
        if (completedEvent) {
          for (let index = 0; index < completedEvent.message.content.length; index++) {
            const item = completedEvent.message.content[index]!;
            if (item.type !== 'toolCall') continue;
            out.push({ type: 'toolcall_start', contentIndex: index, partial: completedEvent.message });
            out.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(item.arguments), partial: completedEvent.message });
            out.push({ type: 'toolcall_end', contentIndex: index, toolCall: item, partial: completedEvent.message });
          }
          try { options?.onProviderStreamEvent?.({ type: 'response.completed', response: terminal }, model); } catch { /* observational */ }
          out.push(completedEvent);
        } else if (failedEvent) out.push(failedEvent);
      } catch (error) {
        const aborted = options?.signal?.aborted === true || leaseSignal?.aborted === true;
        const final: AssistantMessage = {
          ...(last ?? { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }),
          content: (last?.content ?? []).filter((x) => x.type !== 'toolCall'),
          stopReason: aborted ? 'aborted' : 'error',
          // Avoid exposing token or remote payload via thrown errors.
          errorMessage: aborted ? 'SIWC request aborted' : safeError(),
        };
        out.push({ type: 'error', reason: final.stopReason as 'error' | 'aborted', error: final });
      } finally { out.end(); }
    })();
    return out;
  };
}

function snapshotEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (!('partial' in event)) return event;
  const partial = structuredClone(event.partial);
  // Preserve content indexes in text/thinking events while hiding tool details.
  partial.content = partial.content.map((item) => item.type === 'toolCall' ? { type: 'text', text: '' } : item);
  return { ...event, partial };
}

function siwcPayload(payload: unknown): Obj {
  if (!record(payload) || typeof payload.model !== 'string' || !Array.isArray(payload.input)) throw new Error('Invalid SIWC request');
  const result: Obj = { model: payload.model, input: payload.input.map((raw: unknown) => {
    if (!record(raw)) throw new Error('Invalid input item');
    const item = { ...raw };
    if (item.role === 'system') item.role = 'developer';
    if (item.type === 'function_call') {
      if (item.namespace !== undefined && item.namespace !== NS) throw new Error('Unknown tool namespace');
      item.namespace = NS;
    }
    return item;
  }), store: false, stream: true };
  for (const key of ['instructions', 'reasoning', 'include'] as const) if (payload[key] !== undefined) result[key] = payload[key];
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools)) throw new Error('Invalid tool list');
    const names = new Set<string>();
    const tools = payload.tools.map((tool: unknown) => {
      if (!record(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name)) throw new Error('Invalid function tool');
      names.add(tool.name);
      return Object.fromEntries(['type', 'name', 'description', 'parameters', 'strict'].filter((k) => tool[k] !== undefined).map((k) => [k, tool[k]]));
    });
    if (tools.length) result.tools = [{ type: 'namespace', name: NS, description: 'Local MiniMax tools', tools }];
  }
  return result;
}

function verifyCompletion(terminal: Obj | undefined, incomplete: boolean, message: AssistantMessage, names: string[]): void {
  if (incomplete || !terminal || terminal.status !== 'completed' || !Array.isArray(terminal.output)) throw new Error('SIWC did not complete');
  const calls = terminal.output.filter((item: unknown) => record(item) && item.type === 'function_call') as Obj[];
  const blocks = message.content.filter((item) => item.type === 'toolCall');
  if (calls.length !== blocks.length) throw new Error('SIWC tool count mismatch');
  const used = new Set<string>();
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const block = blocks[i]!;
    if (call.namespace !== NS || typeof call.name !== 'string' || !names.includes(call.name) || call.name !== block.name || typeof call.call_id !== 'string' || !call.call_id || used.has(call.call_id) || !block.id.startsWith(`${call.call_id}|`) || typeof call.arguments !== 'string') throw new Error('Invalid SIWC function call');
    used.add(call.call_id);
    const args: unknown = JSON.parse(call.arguments);
    if (!record(args) || !isDeepStrictEqual(args, block.arguments)) throw new Error('Invalid SIWC function arguments');
  }
}
