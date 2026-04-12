---
type: agent_requested
name: Commit Review Gate
description: Gather deterministic diff and verification evidence, draft a commit summary, and require approval before committing
when_to_use: when code changes are ready for review and a commit must not be created until the diff and message are approved
version: 1.0.0
prerequisites:
  - grey
  - tdd-vertical-slices
---

# Commit Review Gate

**Preferred model:** Claude Haiku
**Deterministic first:** Gather `git status`, `git diff --stat`, focused diffs, and test results.
**External side effects:** Forbidden until explicit approval

## Rule

No commit before diff review.

Before approval, show:
- Proposed commit message
- Files in scope
- Diff summary
- Verification evidence
- Known risks

If rejected:
- Adjust scope/message
- Pause again
