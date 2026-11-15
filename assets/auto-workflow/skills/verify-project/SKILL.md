---
name: verify-project
description: Verify a project change using its real user-facing behavior and appropriate automated checks; use when asked to test or demonstrate that a change works.
---

# Verify a project change

Adapted from [pstack's verification workflow](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md). Use the current project's instructions, commands, and existing verification tools; do not assume a particular stack.

1. Identify the changed behavior, its entry point, and an observable success or failure. Inspect applicable project guidance, build scripts, tests, and any feature map. Record the revision and relevant working-tree state when available.
2. Select the smallest meaningful checks for the affected behavior, then run the project's required broader checks. Confirm that the artifact being exercised corresponds to the current change; identify environment overrides or stale builds. Report blocked setup and failed or skipped checks accurately.
3. Where feasible, launch and exercise the affected CLI, UI, service, or other actual user path using an isolated workspace, test data, and the project's existing harness. Check observable results and relevant side effects. A build or a passing unrelated test does not prove the requested behavior.
4. Record commands, environment, expected and observed outcomes, and relevant evidence. Distinguish fixtures and mocks from real services, and report untested platforms or flows. Keep secrets and private user data out of shared evidence. Clean up only processes and temporary resources created for this verification; preserve the user's data and work.

Do not infer permission for live external writes or paid requests from a request to verify locally. If the necessary driver, service, or environment is unavailable, report the exact limitation instead of claiming a pass.
