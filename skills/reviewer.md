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

**Deterministic first:** Read `.agent/notes/architect.md`, `.agent/tickets.md`, `.agent/tests-summary.json`, and `.agent/tests.log` before evaluating work.
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

### 2. Deterministic Test & Lint Evidence

Read the deterministic artifacts produced after developer phase completion:

- **`.agent/tests-summary.json`** — Machine-readable summary of test results (status, pass count, fail count)
- **`.agent/tests.log`** — Full test output from `just test`

Do NOT run `just test` or `just lint` yourself. The developer phase ran these deterministically and produced evidence. Read and verify the artifacts instead.

```
## Verification
- Tests: PASS (from .agent/tests-summary.json)
- Lint: PASS (implicit - developer gate enforces this)
- Test artifacts location: .agent/tests-summary.json, .agent/tests.log
```

### 3. Human Validation Checklist

```
## Your validation steps

Work through each in another window. Save and close to approve.
Write `reject: <what failed>` if anything fails.

### Code review
- **Review the code or diff in your own tools** (git UI, terminal `git diff`, IDE, etc.) outside of Carl. Verify the logic, style, and approach match expectations.
- **If you want code changes**, close this editor with a line like `reject: <reason>` (e.g., `reject: missing error handling for network timeout`) to send the work back to the developer.
- **If you're satisfied**, proceed to approve.

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

### 5. Approval Routes

**Approve (acceptance):**
- No `reject:` line → approve and declare sprint complete

**Reject (escalate to architect for re-planning):**
- `reject: reason` → work returns to architect phase for re-scoping and re-planning
  - Example: `reject: implementation doesn't match AC for error handling`
  - The architect will review the failure and propose revised approach

**Why architect?** When reviewer rejects, the problem is typically in scope or design (architect's domain), not just code changes (developer's domain). Architect needs to re-evaluate the approach and slice plan.
