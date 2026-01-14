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

⚠️ **NEVER generate time estimates or timelines.**

**Why:**
- AI models are bad at estimating (off by 2-10x)
- Creates false expectations
- Humans are better at this

**❌ DON'T:**
```markdown
**Total effort:** ~470 hours (12 weeks)
**Implementation time:** 2-3 days
```

**✅ DO:**
```markdown
**Scope:** 4 concrete improvements
**Complexity:** Medium
**Dependencies:** None
```

**If user asks for estimates:**
- Acknowledge you're bad at this
- Provide complexity (low/medium/high)
- Suggest consulting domain experts
- Provide scope/dependencies instead

**Exception:** Historical data (actual time spent) is OK.

---

## Agent Notes

**Location:** `.agent/notes/` (gitignored)

**Purpose:** Temporary notes, summaries, analysis

**Format:**
```
.agent/notes/
  2025-01-12-refactor-summary.md
  investigation-async-io.md
```

**No structure required** - these are ephemeral.

---

## Enforcement

**Automated (limited):**
- `carl check_docs` - Detects new .md files in uncommitted changes
  - Only checks git diff (not overall doc quality)
  - Can't assess if docs are overwhelming or helpful
  - Use as indicator for "did AI create unsolicited docs"

**AI Review (recommended):**
- Trigger: "review project" or "review code" prompt
- AI can assess:
  - Is documentation overwhelming or helpful?
  - Does README explain too much or too little?
  - Are there redundant .md files?
  - Can docs be consolidated or deleted?

**Manual:**
- Code review: Challenge every new .md file
  - Did user request this?
  - Can we delete it?
  - Can we simplify it?

---

## Before Creating Any .md File

**Self-check:**
1. Did user explicitly ask for docs? If NO → Don't create
2. Is this agent notes? If YES → Use `.agent/notes/`
3. Is this user docs? If YES → Verify user requested it
4. Can we improve code instead? If YES → Refactor, don't document

---

## References

- Self-documenting code (see subtract-first.md)
- Code comments for details (see comments.md)
- Agent notes location (see file-organization.md)

