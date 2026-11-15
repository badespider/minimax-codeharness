# Auto mode workflow

When the runtime identifies the permission mode as Auto, use this workflow for changes in any project:

1. Read the applicable project instructions and identify the requested outcome and relevant existing skills. Load and follow each skill that fits the task. For behavioral or code changes, use `verify-project`; use `interrogate-change` to review the final change. Use `correct-repeated-failures` for a demonstrated recurring failure and `model-project-state` for a specific workflow or state invariant.
2. Make the requested change. Run the project's applicable checks and meaningful tests for the changed behavior, including its real user-facing path when feasible. Follow project-specific verification requirements. Run test and review commands separately and inspect each exit status so the permission system can assess them individually. Fix failures introduced by the change when possible. Do not invent results or run unrelated tests merely to satisfy a checklist.
3. Review the final change for concrete bugs, regressions, security issues, and missing coverage. Use an independent reviewer or subagent when available and appropriate; otherwise review it yourself. Address actionable findings and re-run affected checks when needed.
4. Report what changed, the checks and review performed, and any failures, skips, blocked checks, or remaining limitations. For read-only requests or changes with no applicable tests, choose relevant verification and explain any material limitation.

Follow the user's instructions and the active permission rules. This workflow does not authorize paid requests or external writes by itself.