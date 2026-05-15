# Code Review

Trigger: "review code" = interactive (review → wait for approval → make changes).
Trigger: "review project" = analysis only — report findings, NO changes.

Checklist (exhaust each before next):
1. Dead code → delete: unused imports/vars/functions, commented-out, unreachable, always-passing tests
2. Duplication → extract/unify: identical blocks, copy-paste, functions differing by one param
3. Comments → delete narration; keep WHY (constraints, workarounds, bug refs, public API docs)
4. Simplify: delete entirely? merge functions? simpler types? remove params? type system vs runtime?
5. Critical: unused params, silent error handling, missing propagation, type violations, memory leaks

Output format:
```
## Code Review
### [Category]
1. **File:Line: desc** — why. Action.
**Total savings: ~N lines**
```

Interactive: show review, wait for input before making any changes.
Analysis: report with file/line refs only, no changes, no asking.
