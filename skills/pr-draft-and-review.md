---
type: agent_requested
name: PR Draft and Review
description: Draft PR contents from the actual diff and require approval before creating or updating a pull request
when_to_use: when preparing a PR title, body, summary, or major PR update that must be reviewed before posting
version: 1.0.0
prerequisites:
  - lewis
---

# PR Draft and Review

**Preferred model:** Claude Haiku
**Deterministic first:** Gather branch diff summary, changed files, test evidence, and skipped checks.
**External side effects:** Forbidden until explicit approval

## Rule

Draft the PR from the actual diff. Review it. Post only after approval.

Before approval, show:
- Proposed PR title
- Change summary
- Test evidence
- Risks/caveats

If rejected:
- Revise
- Show what changed
- Pause again
