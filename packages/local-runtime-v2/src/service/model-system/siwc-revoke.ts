/** Revoke only at OpenAI's published revocation endpoint. No credentials enter logs. */
export async function revokeChatGptSession(
  clientId: string,
  refreshToken: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (!clientId || clientId === 'dynamic_agent_client' || !refreshToken) return false;
  try {
    const response = await (options.fetchImpl ?? fetch)('https://auth.openai.com/api/accounts/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: refreshToken, token_type_hint: 'refresh_token' }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    return response.status === 200;
  } catch { return false; }
}
