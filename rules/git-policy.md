# Git Commit & Push Policy

**Enforcement:** Guideline for AI (not enforced on projects)

⚠️ **NEVER commit or push without explicit permission.**

---

## Rule

**Before ANY git commit or push:**
1. Ask the user
2. Explain what will be committed/pushed
3. Wait for approval

**Exception:** User explicitly says "commit and push when done" or similar.

---

## Why

**Commits are permanent:**
- Can't easily undo once pushed
- Affects team members immediately
- May trigger CI/CD pipelines
- May deploy to production

**User should control:**
- When changes are committed
- Commit message content
- What gets pushed
- When it gets pushed

---

## Examples

### ❌ DON'T

```
# Making changes...
# Committing without asking...
git add -A
git commit -m "fix: Update code"
git push
```

**Problem:** User didn't approve commit message, timing, or push.

### ✅ DO

```
# Making changes...

I've completed the changes. Here's what I modified:
- src/main.zig: Fixed memory leak
- src/parser.zig: Added error handling

Would you like me to commit these changes?
If so, what commit message would you prefer?
```

**Wait for user response.**

### ✅ DO (with explicit permission)

**User:** "Fix the bug and commit when done"

```
# Making changes...
# Committing with permission...
git add -A
git commit -m "fix: Prevent memory leak in parser"

Committed changes. Would you like me to push?
```

---

## What to Ask

**Before commit:**
- "Should I commit these changes?"
- "What commit message would you like?"
- Show list of modified files

**Before push:**
- "Should I push to remote?"
- "Which branch/remote?"
- Warn if pushing to main/master

**Before rebase/merge:**
- "Should I rebase/merge?"
- Explain what will happen
- Warn about potential conflicts

---

## Dangerous Operations

**ALWAYS ask before:**
- `git commit`
- `git push`
- `git rebase`
- `git merge`
- `git reset --hard`
- `git push --force`
- `git cherry-pick`
- Changing branches with uncommitted changes

**NEVER do without explicit permission:**
- Force push (`git push --force`)
- Rewriting history on shared branches
- Deleting branches
- Changing remote URLs

---

## Commit Messages

**If user doesn't specify format:**
- Use conventional commits (feat:, fix:, docs:, etc.)
- Be descriptive
- Reference issue numbers if applicable

**If user specifies format:**
- Use exactly what they say
- Don't modify or "improve" it

---

## Key Principles

1. **User controls git history** - Not the AI
2. **Ask before committing** - Every time
3. **Explain what will happen** - Before doing it
4. **Wait for approval** - Don't assume
5. **Respect user's commit messages** - Don't change them

---

## Common Mistakes

**Mistake 1: Committing after every change**
```
# Fixed bug
git commit -m "fix bug"
# Added test
git commit -m "add test"
# Updated docs
git commit -m "update docs"
```

**Better:** Ask user when to commit and what to include.

**Mistake 2: Assuming permission**
```
User: "Fix the bug"
AI: *fixes bug and commits without asking*
```

**Better:** Fix bug, then ask if user wants to commit.

**Mistake 3: Pushing without asking**
```
git commit -m "fix: Bug fix"
git push  # ← WRONG
```

**Better:** Commit, then ask if user wants to push.

---

## Exception: Explicit Permission

**User says:** "Commit and push when done"

**You can:**
- Commit with appropriate message
- Push to current branch
- Still show what you did

**You cannot:**
- Force push
- Push to different branch
- Rebase/merge without asking

