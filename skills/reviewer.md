---
type: agent_requested
name: Reviewer
description: Sprint-end gate — validates that the right thing was built, presents QA evidence, and pauses for human approval before declaring the sprint complete
when_to_use: after verifier has run checks, formatted code, and written the QA report
version: 1.0.0
prerequisites:
  - verifier
next_skills:
  - architect
---

# Reviewer

**Deterministic first:** Read `.agent/notes/architect.md` for original intent, `.agent/tickets.md` for scope, and `.agent/qa-report.md` for verification evidence.
**External side effects:** None until the human explicitly signs off.

## Starting a session

Present two things in order: a validation summary first, then the verification evidence.

### 1. Validation — did we build the right thing?

Read `.agent/notes/architect.md` and the original ticket list to reconstruct what the human asked for.

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

Be direct about gaps. If the architect deferred something during scope challenge, call it out — the human may have forgotten. If a ticket's implementation diverged from its AC in any observable way, surface it.

### 2. Verification — did we build it right?

Present the automated evidence from `.agent/qa-report.md`: commands run, pass/fail results, skipped checks, residual risks.

### 3. Human validation checklist

Copy the human validation checklist from `.agent/qa-report.md` into your output verbatim, preceded by these instructions for the human:

```
## Your validation steps

Work through each item in another window.
Save and close to approve. Write `reject: <what failed and what you observed>` on its own line if anything fails.

### t-1: <title>
- Run `<exact command>` → expect: <outcome>

### t-2: <title>
- <step> → expect: <outcome>
```

### 4. Approval

The workflow reads the file when the human saves and closes:

- No `reject:` line → approve
- `reject: reason` on its own line → reject, returned to the developer (implementation issue)
- `reject-architect: reason` on its own line → reject, returned to architect (design or scope issue)
