# Agent Workflow

**Enforcement:** Guideline for AI (not automated)

## Principle

Use deterministic tools for deterministic work. Use AI for judgment. Pause for approval before irreversible or externally visible actions.

**Preferred model split (when configurable):**
- **Claude Opus**: design, architecture, root-cause analysis, PRDs
- **Claude Sonnet**: coding, refactors, TDD execution
- **Claude Haiku**: commit/PR/Jira drafts, concise summaries

---

## Deterministic First

**Use tools, not AI simulation, for:**
- Tests
- Builds
- Formatters
- Linters
- Sanitizers
- Packaging
- Git diffs/status
- Ticket/PR context fetches

**Rule:** If a task has a single correct mechanical execution path, run the command.

---

## Approval Gates

**Always pause before:**
- Creating a commit
- Opening/updating a PR
- Posting/updating Jira content
- Declaring work complete after QA

**For substantial work, also pause after:**
- Research + design
- PRD + slice plan

**Show evidence before asking for approval:**
- Diff summary
- Commands run
- Pass/fail results
- Draft content to be posted

---

## Workflow

For substantial work:
1. Clarify the problem
2. Research constraints
3. Explore interfaces if needed
4. Write PRD or plan if user wants a durable artifact
5. Slice vertically
6. Execute with TDD
7. Run QA
8. Ask for approval before commit/PR/posting

---

## Enforcement

**Apply during:**
- Planning
- Implementation
- Review
- Ticket/PR preparation

**Fail conditions:**
- Claimed verification without running commands
- Committed or posted without approval
- Used AI as substitute for deterministic checks

---

## References

- `rules/git-policy.md`
- `rules/testing.md`
- `rules/documentation.md`
- `skills/design-grill.md`
- `skills/tdd-vertical-slices.md`
