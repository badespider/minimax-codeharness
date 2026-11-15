import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeChatGptSession } from '../packages/local-runtime-v2/src/service/model-system/siwc-revoke.ts';

test('uses the fixed official endpoint and keeps refresh token in form body', async () => {
  let captured;
  assert.equal(await revokeChatGptSession('issued-client', 'fake-secret', { fetchImpl: async (url, options) => { captured = { url, options }; return new Response(null, { status: 200 }); } }), true);
  assert.equal(captured.url, 'https://auth.openai.com/api/accounts/oauth/revoke');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.body.get('client_id'), 'issued-client');
  assert.equal(captured.options.body.get('token'), 'fake-secret');
  assert.equal(captured.options.body.get('token_type_hint'), 'refresh_token');
});

test('reports unconfirmed revocation on transient failure without exposing errors', async () => {
  assert.equal(await revokeChatGptSession('issued-client', 'fake-secret', { fetchImpl: async () => { throw new Error('fake-secret'); } }), false);
  assert.equal(await revokeChatGptSession('issued-client', 'fake-secret', { fetchImpl: async () => new Response(null, { status: 503 }) }), false);
  assert.equal(await revokeChatGptSession('dynamic_agent_client', 'fake-secret'), false);
});
