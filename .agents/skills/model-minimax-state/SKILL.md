---
name: model-minimax-state
description: Model a MiniMax Code workflow or concurrent state transition and assess a stated invariant. Use when asked for a statechart, model check, race analysis, or formal verification of a named behavior.
---

# Model MiniMax state

Inspired by Lauren Tan's [pstack statechart](https://github.com/cursor/plugins/blob/main/pstack/skills/statechart/SKILL.md) and [formal verification workflow](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md). No model checker or pstack helper is bundled by this skill.

1. Select the requested user-visible workflow or risky invariant; map its states, transitions, guards, ownership, cancellation, and failure paths to concrete code and tests. Record uncertain mappings and concurrency assumptions rather than treating a diagram as evidence.
2. Draw a readable statechart using the user's vocabulary. State the safety or liveness property, initial and terminal states, relevant bounds, and the harm caused by a violation. A diagram alone is not formal verification.
3. If a suitable verifier is available and the task warrants it, build the smallest faithful model in a fresh scratch directory, record the tool version and exact command, and check the property within stated bounds. Where practical, test a deliberately broken model to show the check can fail. Never weaken an invariant to obtain a pass.
4. Translate any counterexample into a sequence against the real implementation and reproduce it safely where possible. A model pass establishes only the modeled behavior under its assumptions, not correctness of the implementation. If no verifier is available or the model is incomplete, report the chart as an unverified model and specify the missing tool or evidence.
5. Report the chart, source references, command and result, bounds, assumptions, counterexamples, and untested behavior. Keep scratch and generated evidence outside the public source tree unless the requested change explicitly includes reviewed artifacts.
