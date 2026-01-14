# Review Project

**Trigger:** "review project" or "assess project"

**Mode:** READ-ONLY (no edits, assessment only)

---

## Steps

1. **Run carl checks:** `deps`, `tests`, `ABI`, `commits`, `exports`
2. **Run "review code" in analysis mode** (see review-code.md for checklist)
3. **Generate report** with P0/P1/P2 action items

---

## Output

```markdown
# Assessment: [Project]

**Grade:** A-F | **Critical:** X | **Warnings:** X

## CARL Compliance
| Rule | Status | Details |
|------|--------|---------|
| Deps (≤5) | ✅/❌ | X deps |
| Tests | ✅/❌ | X files |
| Comments | ✅/⚠️/❌ | X narration |
| Docs | ✅/⚠️/❌ | README X lines |

## Code Quality (from review-code analysis)
[Dead code, duplication, simplification findings]

## Action Items
**P0:** [Critical issues]
**P1:** [Warnings]
**P2:** [Improvements]
```

---

## Details

**Checklist:** See review-code.md (dead code, duplication, comments, simplification, API design, critical issues)

**Principles:** See review-code.md (be specific, actionable, prioritized, direct, focus on deletion)

**To fix issues:** User says "review code" (interactive mode)

