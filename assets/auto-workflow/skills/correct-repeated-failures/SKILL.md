---
name: correct-repeated-failures
description: Turn a demonstrated recurring agent or development mistake into a targeted architectural constraint or regression check; use when asked to prevent a repeated failure.
---

# Correct repeated failures

Adapted from [pstack correct](https://github.com/cursor/plugins/blob/main/pstack/skills/correct/SKILL.md); use the current project's guidance and existing checks.

1. Identify the observed failure and consequence using the task, relevant code, tests, and available history. Distinguish actual recurrence from a hypothetical risk.
2. Trace the cause and owning boundary. Prefer making the invalid path difficult or impossible through API, data, or architecture design; otherwise use a suitable type, lint rule, or behavioral check. Use prose where judgment cannot be enforced reliably.
3. Implement the smallest effective authorized change. Add a helpful failure message and register checks in the project's existing workflow where appropriate.
4. Safely demonstrate that the check catches the actual failure, and that a valid case passes. Use isolated fixtures or a temporary broken variant; do not rewrite user history or modify real credentials, data, or external services. If a faithful negative case cannot run, report that limitation.
5. Run the applicable checks and report the evidence, enforcement location, tradeoffs, and remaining uncertainty.
