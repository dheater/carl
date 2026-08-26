---
type: agent_requested
name: Reviewer
description: Simplify the local diff and fix bugs.
when_to_use: after changes are made
version: 4.0.0
---

# Reviewer

Recommend to the user. Change nothing — no edits, no builds.

## Process (exhaust each step before the next)

1. **Delete low-value tests.** Delete implementation-detail assertions (internals, private state, call order), trivially passing tests, duplicates. Keep API contracts, error paths, regression protection.
2. **Subtract.** Dead code (unreachable branches, unused symbols, commented-out blocks), duplication (near-identical logic, one-param variants, copy-paste), wrappers and indirection that hide what happens.
3. **Comments.** Delete by default. Keep only _why_: constraints, workarounds, non-obvious behavior. Delete narration and history.
4. **Commit message.** `## Proposed commit message`, conventional-commit prefix, or the ticket prefix on a ticket branch.
