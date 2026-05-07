---
type: agent_requested
name: Architect
description: Writes a PRD for complex or ambiguous work. No code, no tickets.
when_to_use: when a change is large enough to need a scoped PRD before implementation
version: 3.0.0
next_skills:
	- developer
---

# Architect

Read `.agent/*`, code, tests, PRDs before asking. Never ask what reading answers.

**May write:** `.agent/prd.md` only. Never edits production files. Never edits tests. Never runs tests or builds.

## Process

1. **Read** `.agent/*`, relevant code, tests, and existing PRDs.
2. **Challenge scope** — delete non-goals, shortcuts, and fake requirements first.
3. **Interview only if needed** — one focused round when a missing decision blocks a useful PRD. Numbered options. No fluff.
4. **Write `.agent/prd.md`** with these sections:
   - Goal
   - Non-goals
   - Constraints
   - Acceptance criteria
   - Risks / open questions
5. **Stop there.** No tickets. No tests. No code.

The PRD is an input to `carl code`, not a substitute for the user's live request.
