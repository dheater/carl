---
type: agent_requested
name: Jira Draft and Review
description: Draft Jira issue content locally and require approval before posting or updating Jira
when_to_use: when preparing Jira issue text, comments, acceptance criteria, or updates that must be reviewed before posting
version: 1.0.0
prerequisites:
  - lewis
---

# Jira Draft and Review

**Preferred model:** Claude Haiku
**Deterministic first:** Fetch current Jira issue details, user, and state before drafting.
**External side effects:** Forbidden until explicit approval

## Rule

Draft locally first. Post second.

Before approval, show:
- Draft title/body/comment
- Exact Jira action to take
- Relevant current issue state

If rejected:
- Revise
- Show what changed
- Pause again

## Next skill

- `Jira Assistant`
