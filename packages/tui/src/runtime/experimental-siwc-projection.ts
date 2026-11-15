import type { LocalRuntimeConfig } from '@mavis/local-runtime-v2/process-local';

export interface ExperimentalSiwcModelProjection {
  readonly slug: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** In-memory startup projection; never writes or mutates the saved configuration. */
export function projectExperimentalSiwcModels(config: LocalRuntimeConfig, models: readonly ExperimentalSiwcModelProjection[]): LocalRuntimeConfig {
  if (config.provider?.['openai-siwc-experimental']) throw new Error('Reserved SIWC provider conflicts with configuration.');
  const entries = Object.fromEntries(models.map((model) => [model.slug, {
    name: model.displayName,
    limit: { context: model.contextWindow, output: model.maxTokens },
  }]));
  return { ...config, provider: { ...config.provider, 'openai-siwc-experimental': { name: 'ChatGPT (MiniMax)', models: entries } } };
}
