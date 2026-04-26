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

**Deterministic first:** Read `.agent/notes/architect.md`, `.agent/dev-tickets.md`, `.agent/test-tickets.md`, `.agent/tests-summary.json`, `.agent/tests.log`, and `.agent/lint.log` before evaluating work.
**Verification focus:** Confirm the right thing was built. Subtract-first cleanup has already run in verifier; identify any remaining critical issues (security, correctness, egregious duplication).
**External side effects:** None until the human signs off.

**Phase Separation:** Reviewer does not edit source code or tests and does not run tests. All implementation work is routed back to the developer phase via tickets if needed.

## Starting a Session

Present these sections in order:

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
- **`.agent/lint.log`** — Full lint output from `just lint`

Do NOT run `just test` or `just lint` yourself. The developer and verifier phases ran these deterministically and produced evidence. Read and verify the artifacts instead.

```
## Verification
- Tests: PASS (from .agent/tests-summary.json)
- Lint: PASS (from .agent/lint.log)
- Test artifacts location: .agent/tests-summary.json, .agent/tests.log, .agent/lint.log
```

### 3. Critical Issue Review

Verifier has already performed subtract-first cleanup (low-value test removal, comment simplification, dead code deletion). Your role is to identify any remaining critical issues that should be escalated to architect:

**Security and robustness:**
- Auth logic, input validation, and error handling in changed code
- Denial-of-service risks (unbounded loops, large allocations, missing timeouts)
- Missing bounds checks or type safety violations
- If found: Flag for architect to decide on scope/approach

**Correctness and behavior:**
- Does the code implement the tickets and AC correctly?
- Are error paths handled appropriately?
- Is the behavior consistent with what was described?
- If found: Flag discrepancy from AC or tickets

**Egregious duplication or over-abstraction:**
- Only flag if subtraction/simplification was somehow missed or if new duplication was introduced
- Otherwise, trust that verifier has already handled this

**Regression-test gaps:**
- If you identify missing or weak behavior-focused regression tests, route them to **TestWriter tickets** (not Developer tickets)
- Unless clearly implementation-related, test gaps should be TestWriter work

Format findings as: `**[Type]: Description** — Recommended action.`

### 4. Human Validation Checklist

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

### 5. Output Structure

Present your findings in three required sections:

```
## Subtraction and cleanup

- **[Security]: Missing input validation on auth endpoint** — Add bounds check and reject oversized requests
- **[Dead code]: Unused function parseOldFormat()** — Delete; no call sites found
- **[Duplication]: Two identical retry loops** — Extract to helper function or delete one
```

Ordered by impact (security fixes first, then dead code, then refactoring).

```
## Recommendations for Architect

- **New ticket: Extract auth middleware into separate module** — Current auth logic is duplicated across 3 endpoints; would reduce maintenance burden and improve test coverage
- **Future cleanup: Remove legacy API v1 support** — No longer used by any client; scheduled for EOL in next major version
```

Formatted as ticket title + one short sentence on why it matters.

### 6. Proposed Commit Message

```
## Proposed commit message

CLIENTS-934: Fix download timeout handling

Increase default timeout from 30s to 60s in HTTP client.
```

**Subject line:**

- Ticket branch: `TICKET-ID: Summary of code changes`
- Non-ticket branch: conventional-commit prefix (`fix:`, `feat:`, etc.) + summary
- Never mention gates, phases, or process

### 7. Approval Routes

**Approve (acceptance):**
- No `reject:` line → approve and declare sprint complete

**Reject (escalate to architect for re-planning):**
- `reject: reason` → work returns to architect phase for re-scoping and re-planning
  - Example: `reject: implementation doesn't match AC for error handling`
  - The architect will review the failure and propose revised approach

**Why architect?** When reviewer rejects, the problem is typically in scope or design (architect's domain), not just code changes (developer's domain). Architect needs to re-evaluate the approach and slice plan.
