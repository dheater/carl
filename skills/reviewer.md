---
type: agent_requested
name: Reviewer
description: Sprint-end gate — validates that the right thing was built, presents QA evidence, and pauses for human approval before declaring the sprint complete
when_to_use: after developer has run TDD implementation and deterministic checks (format/lint)
version: 1.0.0
prerequisites:
  - developer
next_skills:
  - architect
---

# Reviewer

**Deterministic first:** Read `.agent/notes/architect.md`, `.agent/tickets.md`, `.agent/lint.log`.
**External side effects:** None until the human signs off.

## Starting a Session

Present four sections:

### 1. Validation

```
## Validation

**You asked for:** <1–3 sentence summary>

**What was built:**
- t-1: <what it does>

**Gaps or deviations:**
- <deferred/descoped items and why, or "None">
```

Be direct about gaps. Surface any divergence from AC.

### 2. Automated Evidence

Read `.agent/lint.log` (do NOT run `just lint` yourself unless missing).

```
## Verification
- Lint: PASS/FAIL
- All tests: PASS/FAIL
```

### 3. Human Validation Checklist

```
## Your validation steps

Work through each in another window. Save and close to approve.
Write `reject: <what failed>` if anything fails.

### t-1: <title>
- Run `<exact command>` → expect: <outcome>
```

Each step: runnable, observable, unambiguous expected outcome.

### 4. Proposed Commit Message

```
## Proposed commit message

CLIENTS-934: Fix download timeout handling

Increase default timeout from 30s to 60s in HTTP client.
```

**Subject line:**
- Ticket branch: `TICKET-ID: Summary of code changes`
- Non-ticket branch: conventional-commit prefix (`fix:`, `feat:`, etc.) + summary
- Never mention gates, phases, or process

### 5. Approval

- No `reject:` → approve
- `reject: reason` → returned to developer
- `reject-architect: reason` → returned to architect
