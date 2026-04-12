---
type: agent_requested
name: PRD to Plan
description: Convert a PRD into thin vertical slices with deterministic verification and explicit approval gates
when_to_use: when a PRD exists and the next step is an implementation plan before coding or ticket creation
version: 1.0.0
prerequisites:
  - write-a-prd
next_skills:
  - dani
---

# PRD to Plan

**Preferred model:** Claude Opus
**Deterministic first:** Read the PRD, inspect the repo, find existing test seams and verification commands.
**External side effects:** None

## Rule

Slice vertically, not by layer.

Each slice must include:
- User-visible behavior
- Acceptance criteria
- Deterministic verification
- Approval gates if external actions follow

## Approval gates to include

- Plan approval before coding
- Ticket approval before posting
- Commit approval before commit
- PR approval before PR create/update
- QA approval before completion

## Save

Only write a file if the user wants a durable plan.

Use the repo's plan template if it exists.

## Next skill

- `dani`
