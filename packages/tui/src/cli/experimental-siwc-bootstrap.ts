import { createExperimentalSiwcRuntime, ExperimentalSiwcOwner } from '@mavis/local-runtime-v2/cli-service';
import { runExperimentalSiwcCommand, type ExperimentalSiwcRequest } from './experimental-siwc-command.js';

/** Trusted composition only: not called from the default CLI entry point. */
export function createExperimentalSiwcCli(input: {
  readonly dataDir: string;
  /** Override only in trusted tests; production uses the profile store CAS. */
  readonly selectModel?: (accountKey: string, modelKey: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
}) {
  const runtime = createExperimentalSiwcRuntime({ dataDir: input.dataDir, ...(input.selectModel ? { selectModel: input.selectModel } : {}) });
  const owner = new ExperimentalSiwcOwner(runtime.ownerOptions);
  return {
    /** Pass to trusted RunTuiCliDependencies to register commands explicitly. */
    run: (request: ExperimentalSiwcRequest) => runExperimentalSiwcCommand(request, { auth: runtime.auth, catalog: owner, openExternal: input.openExternal }),
    /** Pass to embedded runtime only after startup, selection and auth review. */
    runtimeOptions: runtime.ownerOptions,
    getSelectedModel: runtime.getSelectedModel,
    getRuntimeModels: () => owner.listSelectableModels(),
    close: () => owner.dispose(),
  };
}
