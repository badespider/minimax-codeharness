---
name: correct-repeated-failures
description: Turn a demonstrated recurring MiniMax Code agent or development mistake into a targeted architectural constraint or regression check. Use when asked to prevent a repeated failure or encode a correction.
---

# Correct repeated failures

Inspired by Lauren Tan's [pstack correct](https://github.com/cursor/plugins/blob/main/pstack/skills/correct/SKILL.md); this is a project-specific workflow, not the Cursor plugin.

1. Identify the requested failure and its consequences. Use the current task, relevant code and tests, and available history as evidence. Distinguish observed recurrences from suspected risks; do not invent historical examples.
2. Trace the root cause and owning boundary using [the feature map](../../../docs/feature-map.md). Consider eliminating the invalid path through API or data design first, then an appropriate type, lint or architecture check, then behavior tests. Use prose for judgment that a reliable check cannot express. Follow the repository's existing sources of truth and avoid weakening supported capabilities.
3. Implement the smallest effective change in the authorized scope. When adding a check, make its failure identify the problem and a useful correction. Register tests and verification gates using [the agent guide](../../../AGENTS.md); do not add CI-only duplicate checks.
4. Demonstrate the check detects the failure with a safe, isolated reproduction or a temporary broken variant, then show the corrected case and a relevant legitimate case pass. Never rewrite user history or alter real credentials, data, or external services for a reproduction. If a faithful negative case cannot be run, say so.
5. Run the affected declared gates and report evidence, the enforcement location, tradeoffs and remaining untested cases. Use [verify-minimax-code](../verify-minimax-code/SKILL.md) when runtime behavior needs evidence.
