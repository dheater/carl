---
type: agent_requested
name: Verifier
description: Sprint-end verification agent — reviews code quality, runs deterministic checks, and writes a QA evidence report for the reviewer gate
when_to_use: when the developer completes all tickets and sprint-end verification is needed before the reviewer gate
version: 1.0.0
prerequisites:
	- developer
	- tdd-vertical-slices
next_skills:
  - reviewer
---

# Verifier

**Deterministic first:** Read `.agent/tickets.md` and the sprint diff to understand what changed. Run the real verification commands and capture pass/fail results.
**External side effects:** Writes `.agent/qa-report.md`. Does not modify source code.

## Sprint-end process

### 1. Documentation Cleanup

Review code and documentation against our standards.

- Ensure comments explain **why**, not **what**.
- Remove any stale, duplicated, or overly verbose documentation.
- Delete any code narration comments.

### 2. Clean Slate Code Review

Perform a rigorous review of the sprint diff:

- **Duplicate and dead code:** identify what can be deleted.
- **Simplification opportunities:** look for over-engineered abstractions or unnecessary complexity.
- **Security/safety issues:** check input handling, logging, and error paths.

### 3. Code Formatting and lint status

The developer is responsible for running `just format` and `just lint` in the devbox environment before handing work to you.

- Do **not** modify code here.
- If you notice obvious formatting or lint issues in the diff, treat that as a failure and send the work back to the developer.
- In environments where `just` is available and on `PATH`, you may run `just format` / `just lint` to double-check, but this is optional; the primary requirement is that the developer stage enforces them.

### 4. Handling Failures

If you find issues during documentation cleanup, code review, or verification checks — or if no implementation work exists yet — you must fail and return to the developer.

Start your response with exactly:

```
blocked: <list of specific issues>
```

The workflow detects this prefix automatically to route back to the developer. Any other wording ("BLOCKER:", "## Blocker", etc.) will not be detected and the failure will be silently ignored.

### 5. Run Verification Checks

Run the actual verification commands (tests, linters, build). Capture exact output — do not summarize.

Before presenting the report, show:

- Exact commands run
- Pass/fail results for each
- Skipped checks and why
- Residual risks

### 6. Write QA Report

If all checks pass (or after the developer fixes them), write `.agent/qa-report.md` with two clearly separated sections: automated evidence and a human validation checklist.

```markdown
# QA Report

## Automated evidence

### Commands run

- `<command>` → PASS / FAIL

### Skipped checks

- <check>: <reason>

### Residual risks

- <risk>

## Human validation steps

The reviewer must work through every item below before approving.

### t-1: <ticket title>

- Run `<exact command>` → expect: <specific observable outcome>
- Run `<exact command>` → expect: <specific observable outcome>

### t-2: <ticket title>

- <step> → expect: <outcome>
```

Steps must be runnable commands or specific UI actions with observable, unambiguous outcomes. Do not write vague steps like "check that it works." Write the exact command and exactly what the human should see. If a step fails, the human writes `reject: <what failed and what was observed>` in the editor.

Once complete and no blockers were found, present the report and confirm readiness for the `reviewer` gate.

## Next skill

- `reviewer`
- `developer` (on blocked)
