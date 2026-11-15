import { describe, expect, it, vi } from 'vitest';
import { createTuiProgram } from './program.js';
import { runExperimentalSiwcCommand, type ExperimentalSiwcCommandDependencies } from './experimental-siwc-command.js';
import { createExperimentalSiwcCli } from './experimental-siwc-bootstrap.js';
import { runTuiCli } from './main.js';

function dependencies(): ExperimentalSiwcCommandDependencies {
  return {
    auth: {
      getStatus: vi.fn(async () => ({ state: 'connected' })),
      startLogin: vi.fn(async () => ({ state: 'pending', loginId: 'login', authUrl: 'https://auth.openai.com/api/accounts/authorize?id_token_hint=secret' })),
      waitForLogin: vi.fn(async () => ({ state: 'connected' })),
      cancelLogin: vi.fn(async () => undefined),
      signOut: vi.fn(async () => ({ remoteRevocationConfirmed: false })),
      listAccounts: vi.fn(async () => [{ clientId: 'client-a', email: 'test@example.invalid', state: 'connected', selected: true }]),
      selectAccount: vi.fn(async () => true),
      listIncompleteRegistrations: vi.fn(async () => ['pending-client']),
    },
    catalog: { listSelectableModels: vi.fn(async () => ({ models: [{ slug: 'model', displayName: 'Model' }] })), selectModel: vi.fn(async () => undefined) },
    openExternal: vi.fn(async () => undefined),
  };
}
const programOptions = () => ({ version: 'test', launchTui: vi.fn(), runExec: vi.fn(), runLogin: vi.fn(), runLogout: vi.fn(), runUpdate: vi.fn(), resolveLane: () => undefined });

describe('experimental ChatGPT CLI', () => {
  it('does not register without trusted injection', () => {
    expect(createTuiProgram(programOptions()).commands.some((command) => command.name() === 'chatgpt')).toBe(false);
  });
  it('constructs a separate in-process owner only through explicit composition', async () => {
    const cli = createExperimentalSiwcCli({ dataDir: 'C:/unused-siwc-test', selectModel: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined) });
    expect(cli.run).toBeTypeOf('function');
    expect(cli.runtimeOptions.getActiveSession).toBeTypeOf('function');
    await cli.close();
  });
  it('routes model selection only when explicitly injected', async () => {
    const runExperimentalSiwc = vi.fn(async () => undefined);
    const program = createTuiProgram({ ...programOptions(), runExperimentalSiwc });
    await program.parseAsync(['node', 'mcode', 'chatgpt', 'use', 'model']);
    expect(runExperimentalSiwc).toHaveBeenCalledWith({ action: 'use', modelId: 'model' });
  });
  it('starts MiniMax sign-in without exposing the sensitive authorization URL', async () => {
    const deps = dependencies();
    const output = await runExperimentalSiwcCommand({ action: 'connect' }, deps);
    expect(deps.auth.startLogin).toHaveBeenCalledWith(undefined);
    expect(deps.openExternal).toHaveBeenCalledOnce();
    expect(output).toBe('ChatGPT account connected to MiniMax.');
    expect(output).not.toContain('secret');
  });
  it('requests plan permission only for the explicit enable action', async () => {
    const deps = dependencies();
    await runExperimentalSiwcCommand({ action: 'enable-plan' }, deps);
    expect(deps.auth.startLogin).toHaveBeenCalledWith({ enablePlanUsage: true });
  });
  it('cancels and sanitizes browser failures or non-OpenAI URLs', async () => {
    const deps = dependencies();
    vi.mocked(deps.auth.startLogin).mockResolvedValue({ state: 'pending', loginId: 'login', authUrl: 'https://evil.invalid/?secret' });
    await expect(runExperimentalSiwcCommand({ action: 'connect' }, deps)).rejects.toThrow('Could not open ChatGPT sign-in.');
    expect(deps.auth.cancelLogin).toHaveBeenCalledWith('login');
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
  it('lists and selects available models and reports unconfirmed remote revocation', async () => {
    const deps = dependencies();
    expect(await runExperimentalSiwcCommand({ action: 'models' }, deps)).toBe('model\tModel');
    expect(await runExperimentalSiwcCommand({ action: 'use', modelId: 'model' }, deps)).toContain('model');
    expect(deps.catalog.selectModel).toHaveBeenCalledWith('model');
    expect(await runExperimentalSiwcCommand({ action: 'disconnect' }, deps)).toContain('remote revocation could not be confirmed');
  });
  it('lists saved accounts and explicitly selects a registration', async () => {
    const deps = dependencies();
    expect(await runExperimentalSiwcCommand({ action: 'accounts' }, deps)).toContain('client-a');
    await runExperimentalSiwcCommand({ action: 'account', clientId: 'client-a' }, deps);
    expect(deps.auth.selectAccount).toHaveBeenCalledWith('client-a');
  });
  it('only resumes incomplete registration on explicit retry', async () => {
    const deps = dependencies();
    expect(await runExperimentalSiwcCommand({ action: 'pending' }, deps)).toContain('pending-client');
    await runExperimentalSiwcCommand({ action: 'retry', clientId: 'pending-client' }, deps);
    expect(deps.auth.startLogin).toHaveBeenCalledWith({ pendingClientId: 'pending-client' });
  });
  it('real CLI launch injects the authorized catalog and closes the owner', async () => {
    const launchTui = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const runtimeOptions = { getActiveSession: vi.fn(), getModelLimits: vi.fn() };
    const createExperimentalSiwc = vi.fn(async () => ({ runtimeOptions, getRuntimeModels: async () => ({ accountKey: 'account', models: [{ slug: 'model', displayName: 'Model', contextWindow: 8000, maxTokens: 1000 }] }), close }));
    const stdout = { destroyed: false, writableEnded: false, write: (_value: string, callback?: () => void) => callback?.(), once: vi.fn(), off: vi.fn() };
    const processRef = { title: '', argv: ['node', 'mcode', '-m', 'openai-siwc-experimental/model'], env: {}, versions: { node: process.versions.node }, stdout, stderr: stdout, exit: vi.fn() };
    await runTuiCli({ processRef, createExperimentalSiwc: createExperimentalSiwc as never, launchTui, configureNetworkProxy: vi.fn() });
    expect(launchTui).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai-siwc-experimental/model', experimentalSiwc: runtimeOptions, experimentalSiwcModels: expect.arrayContaining([expect.objectContaining({ slug: 'model' })]) }));
    expect(close).toHaveBeenCalledOnce();
  });
  it('refuses an unavailable account model before launching the TUI', async () => {
    const launchTui = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createExperimentalSiwc = vi.fn(async () => ({ runtimeOptions: {}, getRuntimeModels: async () => ({ accountKey: 'account', models: [] }), close }));
    const stdout = { destroyed: false, writableEnded: false, write: (_value: string, callback?: () => void) => callback?.(), once: vi.fn(), off: vi.fn() };
    const processRef = { title: '', argv: ['node', 'mcode', '-m', 'openai-siwc-experimental/unknown'], env: {}, versions: { node: process.versions.node }, stdout, stderr: stdout, exit: vi.fn(), exitCode: undefined as number | undefined };
    await runTuiCli({ processRef, createExperimentalSiwc: createExperimentalSiwc as never, launchTui, configureNetworkProxy: vi.fn() });
    expect(launchTui).not.toHaveBeenCalled();
    expect(processRef.exitCode).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });
});
