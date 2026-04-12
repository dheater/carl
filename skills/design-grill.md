---
type: agent_requested
name: Design Grill
description: Stress-test a feature, bugfix, or refactor one hard question at a time before writing plans or code
when_to_use: when the problem is partly understood but key design decisions still need to be clarified before writing a PRD, plan, or implementation
version: 1.0.0
next_skills:
  - write-a-prd
  - prd-to-plan
  - design-an-interface
---

# Design Grill

**Preferred model:** Claude Opus
**Deterministic first:** Inspect the repo, existing plans, tests, and interfaces before asking the user.
**External side effects:** None

## Rule

Ask one high-leverage question at a time. For each question:
1. Explain why it matters
2. Give a recommended answer
3. Wait for confirmation or correction

If the repo answers the question, don't ask it.

## Drive toward

- Actual problem
- Desired outcome
- Constraints
- Interface shape
- Test strategy
- Out-of-scope items

## Stop when

The design is clear enough to:
- write a PRD
- write a plan
- compare interfaces

## Next skill

- `write-a-prd`
- `prd-to-plan`
- `design-an-interface`
