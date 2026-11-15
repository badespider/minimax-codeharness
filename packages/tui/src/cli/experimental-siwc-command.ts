import { sanitizeTerminalText } from '../tui/rendering/terminal-text.js';

export type ExperimentalSiwcRequest = { readonly action: 'connect' | 'add-account' | 'enable-plan' | 'status' | 'models' | 'disconnect' | 'accounts' | 'pending' } | { readonly action: 'use'; readonly modelId: string } | { readonly action: 'account' | 'retry'; readonly clientId: string };
type AuthStatus = { readonly state: string; readonly loginId?: string; readonly authUrl?: string };
export interface ExperimentalSiwcCommandDependencies {
  readonly auth: {
    getStatus(): Promise<AuthStatus>;
    startLogin(options?: { readonly newAccount?: boolean; readonly enablePlanUsage?: boolean; readonly pendingClientId?: string }): Promise<AuthStatus>;
    waitForLogin(loginId: string): Promise<AuthStatus>;
    cancelLogin(loginId: string): Promise<void>;
    signOut(): Promise<{ readonly remoteRevocationConfirmed: boolean }>;
    listAccounts(): Promise<readonly { readonly clientId: string; readonly email?: string; readonly state: string; readonly selected: boolean }[]>;
    selectAccount(clientId: string): Promise<boolean>;
    listIncompleteRegistrations(): Promise<readonly string[]>;
  };
  readonly catalog: {
    listSelectableModels(): Promise<{ readonly models: readonly { readonly slug: string; readonly displayName: string }[] }>;
    selectModel(modelId: string): Promise<void>;
  };
  readonly openExternal: (url: string) => Promise<void>;
}

/** Not registered in production; invoke only with a trusted explicitly composed owner. */
export async function runExperimentalSiwcCommand(request: ExperimentalSiwcRequest, deps: ExperimentalSiwcCommandDependencies): Promise<string> {
  switch (request.action) {
    case 'connect':
    case 'add-account':
    case 'enable-plan':
    case 'retry': {
      const started = await deps.auth.startLogin(request.action === 'connect' ? undefined : request.action === 'add-account' ? { newAccount: true } : request.action === 'retry' ? { pendingClientId: request.clientId } : { enablePlanUsage: true });
      if (started.state !== 'pending' || !started.loginId || !started.authUrl) throw new Error('ChatGPT sign-in could not start.');
      try {
        const url = new URL(started.authUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.port) throw new Error('invalid authorization URL');
        await deps.openExternal(started.authUrl);
      } catch {
        await deps.auth.cancelLogin(started.loginId).catch(() => undefined);
        throw new Error('Could not open ChatGPT sign-in.');
      }
      const result = await deps.auth.waitForLogin(started.loginId);
      if (result.state === 'connected') return 'ChatGPT account connected to MiniMax.';
      if (result.state === 'plan-disabled') return 'Signed in; ChatGPT plan usage was not enabled.';
      throw new Error('ChatGPT sign-in did not complete.');
    }
    case 'status': {
      const status = await deps.auth.getStatus();
      return `ChatGPT authorization: ${sanitizeTerminalText(status.state)}`;
    }
    case 'models': {
      const { models } = await deps.catalog.listSelectableModels();
      return models.length ? models.map((model) => `${sanitizeTerminalText(model.slug)}\t${sanitizeTerminalText(model.displayName)}`).join('\n') : 'No supported ChatGPT models are available.';
    }
    case 'accounts': {
      const accounts = await deps.auth.listAccounts();
      return accounts.length ? accounts.map((account) => `${account.selected ? '* ' : '  '}${sanitizeTerminalText(account.clientId)}\t${sanitizeTerminalText(account.email ?? 'ChatGPT account')}\t${sanitizeTerminalText(account.state)}`).join('\n') : 'No saved MiniMax ChatGPT accounts.';
    }
    case 'pending': {
      const registrations = await deps.auth.listIncompleteRegistrations();
      return registrations.length ? registrations.map(sanitizeTerminalText).join('\n') : 'No incomplete MiniMax ChatGPT registrations.';
    }
    case 'account':
      if (!(await deps.auth.selectAccount(request.clientId))) throw new Error('ChatGPT account is unavailable.');
      return 'ChatGPT account selected for MiniMax.';
    case 'use':
      await deps.catalog.selectModel(request.modelId);
      return `ChatGPT model saved. Start MiniMax with -m openai-siwc-experimental/${sanitizeTerminalText(request.modelId)}.`;
    case 'disconnect': {
      const result = await deps.auth.signOut();
      return result.remoteRevocationConfirmed ? 'ChatGPT disconnected from MiniMax.' : 'ChatGPT disconnected locally; remote revocation could not be confirmed.';
    }
  }
}
