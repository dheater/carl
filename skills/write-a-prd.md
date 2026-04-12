---
type: agent_requested
name: Write a PRD
description: Turn a clarified problem into a durable PRD focused on behavior, decisions, and testing intent
when_to_use: when the problem and direction are understood and the user wants a durable requirements document before implementation
version: 1.0.0
next_skills:
  - prd-to-plan
---

# Write a PRD

**Preferred model:** Claude Opus
**Deterministic first:** Inspect existing interfaces, tests, tickets, and adjacent code before writing.
**External side effects:** None unless the user explicitly asks to post it

## Rule

Write behavior, not diff-shaped prose.

**Include:**
- Problem statement
- Solution
- User stories
- Implementation decisions
- Testing decisions
- Out of scope

**Do not include:**
- File paths
- Line numbers
- Current-code trivia that will rot

## Save

Save to `.agent/notes/prd-<topic>.md`.

## Approval gate

Present the PRD to the human and wait for approval before handing off to `prd-to-plan` or `dani`.

## Next skill

- `prd-to-plan`
