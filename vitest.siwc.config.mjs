import base from './vitest.oss.config.mjs';
export default { ...base, test: { ...base.test, include: [
  'packages/local-runtime-v2/src/service/model-system/resolution/siwc-stream-experimental.test.ts',
  'packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts',
  'packages/local-runtime-v2/src/service/model-system/siwc-catalog-experimental.test.ts',
  'packages/tui/src/cli/experimental-siwc-command.test.ts',
  'packages/tui/src/runtime/experimental-siwc-projection.test.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/config/siwc-no-fallback.test.ts',
] } };
