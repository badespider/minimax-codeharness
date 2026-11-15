import { describe, expect, it, vi } from 'vitest';
import { ModelRouteAvailabilityError, resolveTurnModelSelection } from './session-model-selection.js';

const config = {
  defaultModel: 'fallback/valid',
  provider: { fallback: { models: { valid: {} } } },
};

describe('reserved ChatGPT plan session selection', () => {
  it('never repairs an unavailable session override to the configured default', async () => {
    const repairSessionModel = vi.fn();
    await expect(resolveTurnModelSelection({
      config: config as never,
      session: { sessionId: 'session', effectiveModel: 'openai-siwc-experimental/missing' } as never,
      repair: { repairSessionModel },
    })).rejects.toBeInstanceOf(ModelRouteAvailabilityError);
    expect(repairSessionModel).not.toHaveBeenCalled();
  });

  it('rejects an unavailable explicit SIWC model without selecting or repairing the default', async () => {
    const repairSessionModel = vi.fn();
    await expect(resolveTurnModelSelection({
      config: config as never,
      session: { sessionId: 'session' } as never,
      requested: { provider_id: 'openai-siwc-experimental', model_id: 'missing' },
      repair: { repairSessionModel },
    })).rejects.toBeInstanceOf(ModelRouteAvailabilityError);
    expect(repairSessionModel).not.toHaveBeenCalled();
  });

  it('preserves existing repair behavior for an unrelated stale configured provider', async () => {
    const repairSessionModel = vi.fn();
    const result = await resolveTurnModelSelection({
      config: config as never,
      session: { sessionId: 'session', effectiveModel: 'retired/missing' } as never,
      repair: { repairSessionModel },
    });
    expect(result).toMatchObject({ providerId: 'fallback', modelId: 'valid' });
    expect(repairSessionModel).toHaveBeenCalledOnce();
  });
});
