# Documentation

**Enforcement:** ⚠️ Limited automation (quality is subjective - use AI review instead)

**TODO:**
- Detect overwhelming documentation (based on guidelines: prefer code > comments > docs)

**Will NOT enforce (Guidelines for AI, not project rules):**
- Time estimates in docs (AI guideline)
- Unsolicited documentation (AI guideline)

## Principle

**Don't create unsolicited documentation.**

Documentation helps users, not intimidates them.

**Prefer (in order):**
1. Self-documenting code (good names, clear structure)
2. Code comments (for non-obvious decisions)
3. User documentation (for high-level understanding)

If docs are needed to explain code, improve the code first.

---

## Why

- Documentation rots (code changes, docs don't)
- Over-documentation intimidates users
- Most docs repeat what code already says
- Maintenance burden (another thing to update)

---

## When to Document

### User Documentation (Rare)

**Write when:**
- New feature needs explanation
- Architecture changes significantly
- Public API changes
- Setup/build process changes

**Don't write when:**
- Making small bug fixes
- Refactoring internals
- Adding tests
- Updating dependencies

### Agent Notes (Common)

**Write when:**
- Planning multi-step refactors
- Analyzing complex issues
- Tracking investigation progress

**Location:** Always `.agent/notes/` (gitignored), never project root

---

## Examples

### ✅ DO: Minimal README

```markdown
# Project Name

Brief description (1-2 sentences).

## Quick Start

\`\`\`bash
just build
just test
\`\`\`

## Architecture

Two-plane design:
- Control plane: Command protocol (HTTP/gRPC)
- Data plane: Data tunnels (WebSocket/QUIC)
```

### ❌ DON'T: Overwhelming Docs

```markdown
❌ BAD: 50-page architecture document with every class diagram
✅ GOOD: 2-page overview with links to code

❌ BAD: Separate docs repeating what code comments say
✅ GOOD: High-level docs, detailed comments in code

❌ BAD: Exhaustive API reference (duplicates code)
✅ GOOD: Link to code, provide examples
```

---

## README Guidelines

**Keep minimal:**
- Brief description (1-2 sentences)
- Quick start (install, build, test)
- Architecture (2-3 sentence summary or link)

**Don't include:**
- Detailed API docs (use code comments)
- Change history (use git)
- Implementation details (use code)
- Exhaustive feature lists
- Time estimates (see below)

---

## Time Estimates

⚠️ **NEVER generate time estimates or timelines.** AI estimates are off by 2-10x. If asked: provide complexity (low/medium/high) and scope/dependencies instead. Historical actual data is OK.

---

## Agent Notes

**Location:** `.agent/notes/` (gitignored). Temporary notes, summaries, analysis. No structure required.

---

## Enforcement

**Automated:** `carl check_docs` — detects new .md files in uncommitted changes (indicator only).

**Before creating any .md file:**
1. Did user explicitly ask? If NO → Don't create
2. Agent notes? → Use `.agent/notes/`
3. User docs? → Verify user requested it
4. Can we improve code instead? → Refactor, don't document

