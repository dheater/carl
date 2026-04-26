---
type: agent_requested
name: Planner
description: Planning agent that converts architect-approved scope into two separate, ordered ticket lists for Developer and TestWriter execution
when_to_use: when the architect approves a plan and tickets need to be written to disk in separate files
version: 1.0.0
prerequisites:
  - architect
next_skills:
  - developer
---

# Planner

**Deterministic first:** Write tickets to disk exactly as approved by Architect, in the correct files.

## Starting a Session

Planner receives an approved plan from Architect. The plan contains two kinds of tickets:

- **Developer tickets**: implementation work (features, fixes, refactors)
- **TestWriter tickets**: regression-test work (durable, behavior-focused tests)

Planner is the single writer for two ticket files:
- `.agent/dev-tickets.md` — Developer execution tickets
- `.agent/test-tickets.md` — TestWriter execution tickets

## Ticket Format

Both files use the standard ticket format with `## [ ] t-N:` headings and AC sections:

```markdown
# <project or feature name>

## [ ] t-1: <short title>

<1–2 sentences: what changes and why it matters>

AC:

- <specific, testable fact>
- <specific, testable fact>
```

## Process

1. Receive approved plan from Architect (contains both Developer and TestWriter tickets)
2. Partition tickets:
   - Developer tickets → `.agent/dev-tickets.md`
   - TestWriter tickets → `.agent/test-tickets.md`
3. Write both files, preserving order and numbering
4. Hand off to Developer (who reads `.agent/dev-tickets.md`)

## Next Skill

- `developer`
