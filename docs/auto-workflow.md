# Auto workflow across projects

This fork can load a profile-wide workflow that asks the agent to select relevant skills, verify changes, run applicable tests, and review its work when the permission mode is Auto. The workflow lives in the selected MiniMax data directory and applies to projects opened with that profile. It does not copy a project's instructions or change that project's files during installation.

## Set up another computer

1. Clone your fork's `main` branch. Follow the source-build steps in [Installation](installation.md), using your fork's URL instead of the upstream URL in that guide. Install the supported Node.js and pnpm versions, install dependencies, and build the fork. The upstream build does not automatically include this fork's mode signal or workflow installer.
2. From the repository root, install the workflow into the profile you use to launch MiniMax:

   ```sh
   node scripts/install-auto-workflow.mjs
   ```

   The installer uses a nonempty `MINIMAX_DATA_DIR`, then a nonempty `MAVIS_DATA_DIR`, otherwise `~/.minimax`. To set up a named profile or any other data directory, pass that directory explicitly:

   ```sh
   node scripts/install-auto-workflow.mjs --data-dir /path/to/minimax-profile
   ```

   On Windows, use a Windows path in place of `/path/to/minimax-profile`. See [Accounts and data](installation.md#accounts-and-data) to identify the directory used by your launcher. Install separately for each profile you want to use.
3. Start a new session using the fork's build, then use `/permission auto` to select Auto and `/permission status` to confirm it. Use `/skills` to check that the four skills below are available. Existing sessions need to be restarted to load the updated runtime and profile instructions.

The installer copies profile-wide `AGENTS.md` and four skills: `verify-project`, `interrogate-change`, `correct-repeated-failures`, and `model-project-state`. It preserves identical files on repeated runs. If an existing destination differs, it reports a conflict and stops without overwriting it.

To resolve a conflict, compare the existing file with the corresponding template in `assets/auto-workflow/`. For an existing profile `AGENTS.md`, merge the applicable workflow from `assets/auto-workflow/auto-instructions.md` into your existing instructions, then install the skills without changing that file:

```sh
node scripts/install-auto-workflow.mjs --skills-only
```

Add `--data-dir /path/to/minimax-profile` if the profile is not selected by your environment. If an existing skill with the same name differs, the skills-only install also stops without overwriting anything; review both versions before deciding how to combine them, and manually copy any remaining skills you want. Project-specific instructions still apply, and a project-local skill with the same name takes precedence over the profile-wide skill in that project.

## What Auto does

Auto is a permission mode. The fork reports the current mode to the agent, and the profile instructions ask it to use the workflow while that mode is active. The agent should choose skills and checks for the actual task, run relevant project tests and verify changed behavior when feasible, review its changes, and report failures or checks it could not run. Read-only work does not need unrelated tests.

This is model-directed guidance, not a guaranteed enforcement gate: an agent can miss a step, a project may lack tests, and commands can still require approval. In particular, MiniMax may ask for confirmation when its permission classifier is unavailable. The workflow does not grant permission for external writes or paid requests. Lightweight mode intentionally omits normal project instructions and skills, so use a standard session for this workflow.

The installer copies instructions and skills only. It does not copy credentials, logins, model configuration, project data, or the `mcode-chatgpt` shortcut from another computer. To use a ChatGPT plan with this fork, see [the separate experimental ChatGPT connection](chatgpt-plan-experimental.md); that connection currently supports Windows and requires separate account-owner authorization on the new computer.
