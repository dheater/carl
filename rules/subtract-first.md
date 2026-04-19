# Subtract First

**Enforcement:** Guideline for AI and code review (not automated)

## Principle

Default response to any proposal: **Delete → Simplify → Reuse → Add (last resort)**

## Why

Features, dependencies, and code are liabilities — maintenance, security, bugs. Less code = less to break.

## Challenge Everything

- **Dependencies:** Do we need this? Can we duplicate (≤200 LOC) or vendor instead?
- **Abstractions:** 3+ real uses or delete it. No new abstraction without proof it reduces total complexity.
- **Features:** Is this solving a real, observed problem?
- **Complexity:** Can we delete half and still meet needs?

## Practical Rules

**Code Review** — each change calls out what was deleted/simplified/reused before additions.

**Surface Area:** Small, cohesive interfaces. No micro-libraries. Fewer modes and flags.

**Error Handling:** Fail fast by default. Recovery only for specific, recurring, bounded, testable failures. No hidden error handling.

**Visibility:** Explicit allocations, blocking/I/O, ownership. No hidden control flow.

## Enforcement

Apply during code review, design review, and commit messages:

- [ ] What was deleted?
- [ ] What was simplified?
- [ ] What was reused?
- [ ] Are additions justified?
- [ ] Can we delete more?

## Light Evidence > Heavy Metrics

Prefer qualitative improvements: fewer modes, fewer dependencies, smaller diffs, simpler control flow.

Quantitative when easy (latency/throughput/memory). Don't delay deletion waiting for lab-grade numbers.

