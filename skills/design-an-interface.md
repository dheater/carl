---
type: agent_requested
name: Design an Interface
description: Generate multiple radically different interface designs, compare them, and recommend one
when_to_use: when designing or reshaping an API, module boundary, callback surface, or service contract before implementation
version: 1.0.0
next_skills:
  - write-a-prd
  - dani
---

# Design an Interface

**Preferred model:** Claude Opus
**Deterministic first:** Inspect current callers, callees, tests, and real constraints before designing.
**External side effects:** None

## Rule

Produce 3 radically different designs, not 3 small variants of the same idea.

For each design, show:
1. Interface signature
2. Usage example
3. Complexity hidden internally
4. Trade-offs

## Compare on

- Simplicity
- Depth
- Fit for dominant caller
- Ease of correct use
- Ease of misuse

## End with

One opinionated recommendation.

## Next skill

- `write-a-prd`
- `dani`
