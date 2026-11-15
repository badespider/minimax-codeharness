---
name: verify-minimax-code
description: Verify MiniMax Code runtime behavior through its built CLI and isolated offline fixtures; use when a change needs observable CLI, ACP, provider, tool, or permission evidence.
---

# Verify MiniMax Code

Run from the repository root. Use [the feature map](../../../docs/feature-map.md)
to identify the affected user journey, entry point, expected result, and relevant
gate. Use [testing-workflow](../testing-workflow/SKILL.md) for the declared test
suites and delivery checks. This skill covers exercising runtime behavior and
recording its evidence; a passing generic smoke test alone does not establish an
unrelated feature works.

1. **Diagnose.** Record the changed behavior, expected observable result,
   `git rev-parse HEAD`, `git status --short`, OS, and `node --version`. Confirm
   dependencies and a current `dist/cli.js` are available. Run `pnpm build` when
   the artifact is missing or stale; the build may download its pinned runtime
   artifact. The fixtures honor `MCODE_TEST_CLI`; check whether it is set and
   record the exact artifact it selects, or unset it for these child tests to
   exercise `dist/cli.js`. Report a blocked build rather than testing an older
   artifact.
2. **Launch and drive.** Start with the existing offline fixtures, which invoke
   the built CLI with temporary data and workspace directories, synthetic data,
   and a network guard. From the repository root:

   ```bash
   node --test test/smoke.test.mjs
   node --test --test-name-pattern="lightweight mode omits workspace instructions" test/byok.test.mjs
   ```

   The smoke suite checks CLI help/version, provider configuration, ACP startup,
   and other declared scenarios. The targeted BYOK fixture checks that a local
   mock provider receives no workspace instructions or offered tools in
   lightweight mode and that an unoffered tool call cannot create its marker
   file. For broader provider/session behavior, run `pnpm test:byok`; select the
   owning gate and additional scenarios from the feature map. Fixtures use a
   local HTTP server where needed and intercept network attempts in guarded Node
   children. This is not OS-level network isolation; the fixtures also inherit
   parts of the host environment. They clean up temporary data on normal completion.
3. **Observe.** Inspect test results, exit codes and failure output. Exercise
   the changed user-visible path with synthetic inputs in an isolated workspace
   when the fixtures do not cover it. For interactive TUI behavior, observe the
   relevant interaction when available; describe it as untested otherwise.
   A live provider, account, public write, or paid request requires the relevant
   user authorization and must not be inferred from an offline fixture.
4. **Record and clean up.** Report each command, outcome, observed behavior,
   revision and checkout state, plus skipped, blocked and untested paths.
   Mark mock-provider results as offline evidence, not live-service acceptance.
   Keep evidence outside the source tree and remove secrets or private content
   before sharing. Existing fixtures remove their own temporary state on normal
   completion; after an interrupted run, remove only a confirmed fixture-owned
   temporary directory after checking its absolute path.
