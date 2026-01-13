# ast-grep vs grep: Code Search Accuracy

**Date:** 2026-01-13
**Corpus:** 216 C/C++/Zig files from real projects
**Scenarios:** 45 search patterns (simple, medium, complex)

---

## Question

Is ast-grep more accurate than grep for searching code?

---

## Hypothesis

AST-based search (ast-grep) will have fewer false positives than text-based search (grep) when searching for code patterns.

---

## Method

- **Corpus:** 216 real C/C++/Zig files
- **Scenarios:** 45 search patterns (function calls, struct definitions, type casts, etc.)
- **Iterations:** 5 runs per scenario (225 measurements per tool)
- **Metrics:** Accuracy (% correct matches), false positives, speed

---

## Results

### Accuracy

| Tool | Accuracy | False Positives |
|------|----------|-----------------|
| ast-grep | **100%** | **0** |
| grep | 69.5% | 2,568 |

### Speed

| Tool | Average Time |
|------|--------------|
| grep | 0.027s |
| ast-grep | 0.030s |

**Difference:** 3ms (negligible)

### Complexity Impact

| Pattern Complexity | grep Accuracy | ast-grep Accuracy |
|-------------------|---------------|-------------------|
| Simple | 89.8% | 100% |
| Medium | 67.8% | 100% |
| Complex | 58.1% | 100% |

**Finding:** grep accuracy degrades with complexity; ast-grep remains 100%

---

## Conclusion

**ast-grep is superior for code search.**

- **100% accuracy** vs grep's 69.5%
- **Zero false positives** vs grep's 2,568
- **Negligible speed difference** (3ms)
- **Consistent accuracy** across all complexity levels

**Why:** ast-grep understands code structure; grep matches text (including comments, strings, documentation).

---

## Reproducibility

```bash
cd experiments/ast-grep-vs-grep
python3 run-experiment.py
```

Raw data: `results/comprehensive_results.csv`

---

## Note

This experiment measures **search accuracy**, not AI refactoring performance. For AI refactoring results, see `../rule-effectiveness/`.

