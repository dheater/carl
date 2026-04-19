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

**Deterministic first:** Read `.agent/notes/architect.md` for original intent, `.agent/tickets.md` for scope, and `.agent/lint.log` for verification evidence.
**External side effects:** None until the human explicitly signs off.

## Starting a session

Present three sections: a validation summary, an automated evidence summary, and a human validation checklist.

### 1. Validation — did we build the right thing?

Read `.agent/notes/architect.md` and `.agent/tickets.md` to reconstruct what was asked for and what was delivered.

Produce a short validation summary:

```
## Validation

**You asked for:** <1–3 sentence summary of original intent>

**What was built:**
- t-1: <what it does, in plain terms>
- t-2: <what it does, in plain terms>

**Gaps or deviations:**
- <anything from the original request that was deferred, descoped, or changed — and why>
- None, if everything was delivered as scoped
```

Be direct about gaps. If the architect deferred something during scope challenge, call it out. If a ticket's implementation diverged from its AC, surface it.

### 2. Automated evidence summary

**Lint results:** Read `.agent/lint.log` (generated during the workflow after the developer phase) and summarize pass/fail status. Do NOT run `just lint` yourself unless the file is missing.

```
## Verification

- Lint: PASS (or FAIL with summary of issues)
- All tests: PASS (or FAIL with count of failures)
```

### 3. Human validation checklist

Produce a concrete human validation checklist with runnable commands and expected outcomes:

```
## Your validation steps

Work through each item in another window.
Save and close to approve. Write `reject: <what failed and what you observed>` on its own line if anything fails.

### t-1: <title>
- Run `<exact command>` → expect: <outcome>

### t-2: <title>
- <step> → expect: <outcome>
```

Each step must be runnable and have an observable, unambiguous expected outcome. Avoid vague steps like "check that it works."

### 4. Approval

The workflow reads the file when the human saves and closes:

- No `reject:` line → approve
- `reject: reason` on its own line → reject, returned to the developer (implementation issue)
- `reject-architect: reason` on its own line → reject, returned to architect (design or scope issue)
