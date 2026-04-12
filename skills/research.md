---
type: agent_requested
name: Research
description: Fetch, summarize, and cache external context that the agent cannot easily rediscover in a fresh context window
when_to_use: when the work depends on external APIs, uncommon libraries, or hard-to-explore context that would slow or derail each execution phase
version: 1.0.0
next_skills:
  - prototype
  - write-a-prd
---

# Research

**Preferred model:** Claude Opus
**Deterministic first:** Fetch real docs with `md-fetch` or `auggie web-fetch`. Do not summarize from memory.
**External side effects:** None — research is read-only until the user approves saving it.

## Rule

Research has a sprint lifetime. It exists to give the execution agent reliable context it cannot find on its own. It rots — delete it when the sprint ends or the context changes.

**Fetch, don't hallucinate.** Every claim in the research output must come from a fetched source.

## What to produce

A concise summary covering only what the execution agent needs:

- What the external thing is and what problem it solves
- The API surface the agent will actually call (endpoints, types, auth)
- Rate limits, quotas, known gotchas
- Links to the canonical docs for follow-up

Do not summarize the entire API. Only what this sprint needs.

## Save

Save to `.agent/notes/research-<topic>.md` unless the user asks for a committed artifact.

Add at the top:

```
<!-- research: sprint-scoped — delete when this sprint ends -->
```

## Stop when

The agent has enough context to write the PRD or begin prototyping without needing to re-fetch docs mid-sprint.

## Next skill

- `prototype`
- `write-a-prd`
