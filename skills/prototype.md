---
type: agent_requested
name: Prototype
description: Build a minimal throw-away version to impose taste on the outcome before writing a PRD or committing to an implementation plan
when_to_use: when you need concrete feedback on a UI, architecture, or external service integration before the direction is clear enough to write a PRD
version: 1.0.0
next_skills:
  - write-a-prd
---

# Prototype

**Preferred model:** Claude Opus
**Deterministic first:** Inspect existing code, interfaces, and research notes before proposing directions.
**External side effects:** Code changes only. No commit, no PR — the human decides what to keep.

## Rule

A prototype is a question, not a deliverable. Its job is to generate concrete feedback fast so the PRD reflects reality, not assumptions.

Prototypes are throw-away by default. If the human commits one, it becomes reference material for the execution agent — not production code.

## Cycle

1. Propose 2–3 concrete directions (not abstract options)
2. Build the one the human picks — minimal, no polish
3. Show it to the human
4. Human iterates: keep, change, or discard
5. Repeat until the direction is clear

**One direction at a time.** Do not build all three and ask the human to choose from output.

## What to produce

- Working code for the chosen direction
- No tests, no error handling, no production patterns
- Enough to see and react to — not enough to ship

## Stop when

The human has seen enough to describe the end state clearly. That description becomes the PRD.

## Next skill

- `write-a-prd`
