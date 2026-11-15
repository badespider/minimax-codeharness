# Experimental ChatGPT plan connection

This fork contains an experimental, Windows-only connection that lets MiniMax Code request permission to use a ChatGPT plan. It uses OpenAI's Sign in with ChatGPT flow and keeps MiniMax's registration and protected credentials in its own data directory. It does not use or change the existing Codex login.

The integration is still being validated. The commands below describe the experimental build; a successful sign-in or model list does not establish that a real inference request has succeeded. ChatGPT account, workspace, plan and regional eligibility are determined by OpenAI.

## Build the fork

From this checkout on Windows, use a supported Node.js version from the root `package.json` and pnpm 9.12.0:

```powershell
pnpm install --frozen-lockfile
pnpm run build
node .\dist\cli.js chatgpt --help
```

These commands build and run this checkout; they do not replace a globally installed `mcode` command.

## Connect and choose a model

1. Run `node .\dist\cli.js chatgpt connect`. The system browser opens OpenAI's sign-in and authorization page. Select the ChatGPT account and workspace you want to use, and review the request to let MiniMax use the plan. The connection is separate from Codex even if you choose the same account.
2. Run `node .\dist\cli.js chatgpt status`. If identity sign-in succeeded but plan usage was declined, choose it explicitly with `node .\dist\cli.js chatgpt enable-plan` and review the browser prompt again.
3. Run `node .\dist\cli.js chatgpt models`. Select a model from the returned list. The experimental picker currently shows account models only when the bundled model catalog also has the limits MiniMax needs; a new model may therefore be unavailable until that catalog is updated.
4. Replace the value below with a model ID from that list. The `use` command saves the selection for the ChatGPT account. Start each MiniMax session with the explicit model option:

   ```powershell
   $model = 'MODEL_ID_FROM_THE_LIST'
   node .\dist\cli.js chatgpt use $model
   node .\dist\cli.js -m "openai-siwc-experimental/$model"
   ```

The browser-based authorization must be completed by the account owner. Keep the authorization page and any credentials private. Model requests use the ChatGPT account's available plan usage; they do not silently switch to an API-key billing path if ChatGPT plan access fails.

## Accounts and sign-out

- `node .\dist\cli.js chatgpt accounts` lists saved MiniMax ChatGPT registrations. Use `chatgpt account CLIENT_ID` to select one, then `chatgpt connect` to reauthorize it if needed.
- `node .\dist\cli.js chatgpt add-account` starts a separate registration for another account or workspace.
- `node .\dist\cli.js chatgpt pending` lists incomplete registrations. If registration completed but the exchange failed, `chatgpt retry CLIENT_ID` resumes using that issued client ID.
- `node .\dist\cli.js chatgpt disconnect` signs out the selected MiniMax registration and attempts to revoke its renewable session. If remote revocation cannot be confirmed, the command reports that local sign-out completed; you can also disconnect MiniMax in ChatGPT settings. Codex's registration is separate.

Review plan usage and app access in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). An in-progress request may hold the account lock; if disconnect reports a busy lock, stop the request and retry.

For the protocol and eligibility details, see OpenAI's [Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source) and [model and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
