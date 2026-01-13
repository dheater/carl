# Carl Experiments

Empirical validation of Carl's principles.

---

## ast-grep vs grep: Code Search Accuracy

**Question:** Is ast-grep more accurate than grep for searching code?

**Answer:** Yes. 100% accuracy vs 69.5%. Zero false positives vs 2,568.

**Details:** `ast-grep-vs-grep/`

---

## Ephemeral Scripts Rule: AI Performance

**Question:** Does mandating ast-grep improve AI refactoring performance?

**Answer:** No. Made AI 18-400% slower with no accuracy improvement.

**Tested approaches:**
- Mandatory ast-grep rewrite: 4x slower, no accuracy gain
- Hybrid (ast-grep find + str-replace edit): 4x slower, no accuracy gain
- Pure str-replace-editor: Fastest and equally accurate

**Details:** `rule-effectiveness/`

**Outcome:** Rule removed from Carl.

---

## md-fetch vs web-fetch: Web Content Quality

**Question:** Should Carl recommend md-fetch for web content fetching?

**Answer:** Yes. md-fetch is dramatically better quality (5/5 tests) and AI uses it consistently (100%).

**Phase 1 (Quality):**
- md-fetch: 4.8/5 readability, 100% code/link preservation
- web-fetch: 1.4/5 readability, 40% code preservation, 20% link preservation

**Phase 2 (AI Behavior):**
- AI uses md-fetch 100% of the time when told to
- No performance penalty (unlike ast-grep)
- Equal accuracy to web-fetch

**Details:** `md-fetch-vs-web-fetch/`

**Outcome:** Recommend adding md-fetch rule to Carl.

---

## Summary

1. **ast-grep is better than grep** for code search (100% vs 69.5% accuracy)
2. **AI doesn't need ast-grep** for refactoring (str-replace-editor is faster and equally accurate)
3. **Hybrid approach doesn't help** - AI already finds locations accurately without ast-grep
4. **md-fetch is better than web-fetch** for content extraction (4.8/5 vs 1.4/5 quality)
5. **AI uses md-fetch consistently** when told to (100% compliance, no slowdown)

---

## Running Experiments

```bash
# Code search accuracy
cd experiments/ast-grep-vs-grep
python3 run-experiment.py
```

---

## Adding Experiments

- One directory per experiment
- README.md with: question, hypothesis, method, results, conclusion
- Reproducible (include scripts/data)
- Simple and clean (document results, not process)

