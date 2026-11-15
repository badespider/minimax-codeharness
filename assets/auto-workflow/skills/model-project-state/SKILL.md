---
name: model-project-state
description: Model a project workflow or concurrent state transition and assess an explicit invariant; use for a statechart, race analysis, model checking, or formal verification request.
---

# Model project state

Adapted from [pstack statechart](https://github.com/cursor/plugins/blob/main/pstack/skills/statechart/SKILL.md) and its [formal verification workflow](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md). No model checker is bundled.

1. Select the requested user-visible workflow or risk. Map states, transitions, guards, ownership, cancellation, and failures to the current code and tests. Record uncertain mappings and concurrency assumptions.
2. Draw a readable statechart using the reader's vocabulary. State the safety or liveness property, initial and terminal states, bounds, and the consequence of violation. A diagram alone is not formal verification.
3. When a suitable verifier is available and the task warrants it, build the smallest faithful model in a fresh scratch directory. Record the tool version, exact command, and bounds; where practical use a deliberately broken model to demonstrate that the property check can fail. Do not weaken an invariant merely to obtain a pass.
4. Translate counterexamples into sequences against the actual implementation and reproduce them safely when feasible. A passing model establishes only its modeled behavior under the stated assumptions, not implementation correctness.
5. Report the chart, sources, assumptions, tool and result, counterexamples, and untested behavior. If the checker or faithful model is unavailable, label the result as an unverified model. Keep generated evidence outside the project unless the task calls for reviewed artifacts.
