---
name: interrogate-change
description: Independently challenge a specified change or design for concrete behavioral failures and report reproducible findings; use for adversarial review or a requested stress test.
---

# Interrogate a change

Adapted from [pstack interrogate](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md); use available review tools rather than assuming a particular agent host or model.

1. Establish the named scope and intended behavior. Inspect relevant project instructions, the diff or design, surrounding callers, and tests. Preserve existing work; record the revision and working-tree state when available.
2. Independently examine plausible failure paths, including inputs and boundaries, permission handling, platform differences, concurrency or cancellation, and misleading evidence where relevant. If independent reviewers are available, give them the intent and distinct risk areas without suggesting conclusions; otherwise review directly and disclose the limitation.
3. Reproduce material findings against the implementation or a faithful isolated fixture where feasible. Record the expected and observed result, a reproducible command, and a narrow location. Separate issues introduced by the change from pre-existing issues and unverified risks. Obtain authorization before destructive or live external operations.
4. Report actionable findings in severity order, then the checked scope and gaps. A review with no findings is valid. Fix findings when the user's request or surrounding task authorizes fixes.
