/** A model exposed for the currently selected ChatGPT account. */
export interface SiwcModel {
  readonly slug: string;
  readonly displayName: string;
}

export class SiwcModelDiscoveryError extends Error {
  override name = 'SiwcModelDiscoveryError';
  readonly status?: number;
  readonly requestId?: string;
  constructor(message: string, status?: number, requestId?: string) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

/** Account-scoped catalog; never accepts an arbitrary URL for a bearer credential. */
export async function discoverSiwcModels(
  accessToken: string,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<SiwcModel[]> {
  if (!accessToken.trim()) throw new SiwcModelDiscoveryError('ChatGPT sign-in is required.');
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
  } catch {
    throw new SiwcModelDiscoveryError(
      options.signal?.aborted ? 'ChatGPT model discovery was cancelled.' : 'ChatGPT model discovery failed. Try again.',
    );
  }
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    throw new SiwcModelDiscoveryError(
      `ChatGPT model discovery failed (HTTP ${response.status}).`,
      response.status,
      requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : undefined,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SiwcModelDiscoveryError('ChatGPT returned an invalid model catalog.');
  }
  const records = readRecord(payload)?.models;
  if (!Array.isArray(records)) throw new SiwcModelDiscoveryError('ChatGPT returned an invalid model catalog.');
  const seen = new Set<string>();
  const models: SiwcModel[] = [];
  for (const entry of records) {
    const item = readRecord(entry);
    if (!item || item.visibility !== 'list' || typeof item.slug !== 'string') continue;
    const slug = item.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name = typeof item.display_name === 'string' ? item.display_name.trim() : '';
    models.push({ slug, displayName: name || slug });
  }
  return models;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
