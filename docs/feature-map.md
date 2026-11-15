# Feature map and verification guide

This map connects user-facing workflows to the code and existing verification
gates. It is a navigation aid, not a promise that a gate covers every variation
of a workflow. For architecture, consult [Source boundaries](architecture.md);
for the evidence and limitations of previous runs, see
[Verification records](verification.md) and [TUI capability coverage](tui-capabilities.md).

| User journey | Entry point and ownership | Useful existing checks | Evidence to inspect |
| --- | --- | --- | --- |
| Start and use the interactive terminal | `mcode`; `packages/tui`, with in-process services in `packages/local-runtime-v2` | `pnpm test:capabilities`, `pnpm test:smoke`, `pnpm lint:tui` | Relevant interaction, visible result and terminal recovery; a smoke pass is not a full interactive acceptance test. |
| Run a request without the TUI | `mcode exec`; `packages/tui` headless adapter and local runtime | `pnpm test:byok`, `pnpm test:capabilities`, `pnpm test:smoke` | Exit status, output and any file change in a disposable workspace. The BYOK gate uses a local protocol fixture. |
| Connect an editor | `mcode acp`; `packages/code-acp` and `packages/tui` ACP adapter | `pnpm test:capabilities`, `pnpm test:smoke` | Initialization and the relevant client-visible messages; a protocol fixture is not acceptance in every editor. |
| Drive a session through the TypeScript SDK | `packages/code-sdk` | `pnpm test:code-sdk`, `pnpm typecheck:code-sdk` | Session lifecycle and events observable by the SDK caller. See [SDK documentation](../packages/code-sdk/README.md). |
| Sign in or configure a provider | `mcode login`, `mcode provider`, `/login`, `/provider`; `packages/oauth-core`, `packages/local-runtime-v2` | `pnpm test:byok`, `pnpm test:capabilities` | Authentication and provider behavior appropriate to the change; offline fixtures do not verify real accounts or provider availability. |
| Use files, shell, permissions and sandbox | TUI/headless tools, `packages/agent-tools`, `packages/agent-modules/permission`, `packages/local-runtime`, `third_party/sandbox-runtime` | `pnpm test:capabilities`; `pnpm test:policy` on macOS/Linux; `pnpm test:sandbox` on macOS | Affected permission and tool outcomes, including rejection or cancellation cases. Platform-specific suites cannot establish other platforms' behavior. |
| Resume or manage a session | TUI and headless session entry points; `packages/local-runtime-v2` | `pnpm test:byok`, `pnpm test:capabilities` | Expected session state and observable resume behavior using synthetic data. |
| Use plugins, MCP or connectors | `/plugins`, `mcode plugin`; `packages/agent-modules`, `packages/local-runtime-v2`, `packages/mcode-tools-host` | `pnpm test:capabilities`; `pnpm check:plugin` for plugin validation | Discovery, permission and invocation outcomes relevant to the change. Local fixtures do not establish live marketplace or connector success. |
| Build and distribute the standalone CLI | `pnpm build`; `scripts/`, `release/` | `pnpm check:source`, `pnpm check:tsconfig`, `pnpm build`, `pnpm check:standalone`, `pnpm test:artifact`, `pnpm test:release-tools` | Inventory and export checks, built artifact checks, and the applicable release review. See [Releasing](releasing.md). |

## Verification workflow

1. Identify the user journey, changed boundary and expected observable result.
   Check the feature's existing tests and limitations before choosing additional
   coverage; add focused regressions for demonstrated failure modes.
2. Run the relevant individual gates during development. Artifact-dependent
   checks require a current build. Use `pnpm verify --list` to inspect the gates
   selected for the current platform; use `pnpm verify` for the full delivery
   profile described in [Contributing](../CONTRIBUTING.md).
3. Exercise the affected entry point where feasible. Use synthetic inputs and
   isolated temporary data and workspace directories. Do not put accounts,
   credentials, sessions, logs, user content or private evidence in the source
   tree. Do not perform live external writes or paid model requests as a routine
   verification step.
4. Record the revision and environment, commands, pass/fail results, observed
   behavior, and any blocked or unrun scenarios. Keep verification artifacts
   outside the source tree. A successful offline check is not evidence of live
   provider, account, platform or interactive-terminal acceptance.

Source export reads committed `HEAD` and rejects uncommitted tracked changes.
Run focused gates during editing and run the required complete profile on the
reviewed commit with a clean tracked working tree before opening a PR. New files
also require publication review and inventory regeneration as described in
[AGENTS.md](../AGENTS.md); recording a file does not establish that it is safe to
publish. The `docs` profile applies only when all changed paths qualify, and is
not a substitute for full verification of runtime or inventory changes.
