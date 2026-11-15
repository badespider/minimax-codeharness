---
name: interrogate-change
description: Independently challenge a specified MiniMax Code change or design for concrete behavioral failures, and report reproducible findings with their limits. Use for adversarial review or a requested stress test.
---

# Interrogate a change

Inspired by Lauren Tan's [pstack interrogate](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md); this adaptation uses available reviewers and does not require Cursor or specific models.

1. Establish the named scope and intended behavior. For a code change, inspect the relevant diff, surrounding callers, tests, and affected entries in [the feature map](../../../docs/feature-map.md). Preserve uncommitted work and record the revision and working-tree state.
2. Independently examine plausible failure paths: inputs and boundaries, permissions, platform differences, concurrent or cancelled work, and evidence that could be misleading. When independent reviewers are available, give each the same intent and a distinct risk area without suggesting a conclusion. Otherwise review directly and disclose that limitation.
3. Reproduce material findings against the actual code or a faithful isolated fixture when feasible. Capture the command, expected and observed result, and a narrow file or line reference. Check that the issue is introduced or materially exposed by the change; label pre-existing issues and unverified risks separately. Never run destructive or live external operations as a proof without authorization.
4. Report actionable findings in severity order, followed by checked scope and gaps. A review with no findings is a valid result. Do not fix review findings unless the user asked for fixes or the surrounding task already authorizes them.
