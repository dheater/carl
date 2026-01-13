# Ephemeral Scripts Rule: Performance Testing

**Date:** 2026-01-13
**Status:** Rule removed from Carl
**Reason:** Degrades AI performance without improving accuracy

---

## Question

Does mandating ast-grep for code refactoring improve AI performance?

---

## Hypothesis

AI agents using ast-grep (AST-based tool) will be faster and more accurate than agents using regex-based tools (sed/perl) or str-replace-editor.

---

## Method

Controlled experiments with identical test corpora:
- 3 conditions: no rule (agent's choice), with rule (mandatory ast-grep rewrite), hybrid (ast-grep find + str-replace-editor)
- Independent sub-agents per test
- Measured: time to completion, accuracy, compilation success

**Test 1: Simple refactoring**
- Task: Add parameter to 9 function calls
- Corpus: 3 C files
- Conditions: no rule vs with rule

**Test 2: Complex refactoring**
- Task: 5 challenging scenarios (rename, multi-line calls, type changes, nested calls, scope-aware)
- Corpus: 5 C files with edge cases
- Conditions: no rule vs with rule vs hybrid

---

## Results

### Simple Refactoring

| Condition | Time | Tool | Accuracy | Compiles |
|-----------|------|------|----------|----------|
| No rule | 73s | perl | 100% | Yes |
| With rule | 86s | ast-grep | 100% | Yes |

**Finding:** Rule made AI **18% slower** with **no accuracy improvement**

### Complex Refactoring

| Condition | Time | Workflow | Accuracy | Compiles |
|-----------|------|----------|----------|----------|
| No rule | 15s | str-replace-editor only | 100% | Yes |
| With rule | 60s | ast-grep rewrite + fallback | 100% | Yes |
| Hybrid | 60s | ast-grep find + str-replace | 100% | Yes |

**Finding:** Both ast-grep approaches made AI **4x slower** with **no accuracy improvement**

---

## Conclusion

**The ephemeral-scripts rule degrades AI performance.**

1. **Speed:** Consistently slower (18% to 4x)
2. **Accuracy:** No improvement (all conditions 100%)
3. **Tool choice:** Irrelevant - str-replace-editor was faster and equally accurate
4. **Complexity:** ast-grep struggled with nested calls and scope-aware changes
5. **Hybrid approach:** No benefit - AI already finds locations accurately without ast-grep

**Recommendation:** Rule removed from Carl.

---

## Hybrid Approach Analysis

**Hypothesis:** Using ast-grep to find locations, then str-replace-editor to make changes, would combine the strengths of both tools.

**Result:** No improvement over pure str-replace-editor.

**Why hybrid didn't help:**
1. AI already finds correct locations using view/codebase-retrieval
2. ast-grep finding step adds overhead (parse output, filter results)
3. Manual filtering still required (scope, declarations vs calls)
4. Same 60s time as failed ast-grep rewrite approach

**When hybrid might help:**
- Very large codebases (1000+ files) where finding is expensive
- Cross-file refactoring at scale
- Verification: "Did I find everything?"

**For typical refactoring:** Pure str-replace-editor is superior.

---

## Note on ast-grep

While ast-grep is superior to grep for code search (see `../ast-grep-vs-grep/`), it does not improve AI refactoring performance. AI's built-in str-replace-editor is already excellent for code transformations.

**Training data problem:** AI doesn't know ast-grep well enough to use it efficiently. The hybrid experiment showed ast-grep can find locations accurately, but AI already does this using view/codebase-retrieval. Adding ast-grep just adds overhead without improving accuracy.

