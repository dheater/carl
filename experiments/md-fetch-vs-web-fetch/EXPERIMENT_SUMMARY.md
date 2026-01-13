# md-fetch vs web-fetch: Complete Experiment Summary

**Date:** January 13, 2026  
**Question:** Should Carl recommend md-fetch for web content fetching?  
**Answer:** **YES** - md-fetch is dramatically better quality and AI uses it consistently.

## Two-Phase Experiment

### Phase 1: Quality Comparison ✅

**Question:** Is md-fetch output better quality than web-fetch?

**Answer:** YES. Dramatically better. (5/5 tests, md-fetch wins decisively)

| Metric | md-fetch | web-fetch | Winner |
|--------|----------|-----------|--------|
| **Readability** | 4.8/5 ⭐⭐⭐⭐⭐ | 1.4/5 ⭐ | md-fetch |
| **Noise Removal** | 4.8/5 ⭐⭐⭐⭐⭐ | 1.4/5 ⭐ | md-fetch |
| **Code Preserved** | 100% ✅ | 40% ❌ | md-fetch |
| **Links Preserved** | 100% ✅ | 20% ❌ | md-fetch |
| **Avg File Size** | 103 KB | 193 KB | md-fetch |

**Real-world examples:**
- GitHub README: md-fetch 2.1 KB vs web-fetch ~200 KB
- Zig docs: md-fetch 454 KB readable vs web-fetch ~300 KB CSS/JS

**Details:** `EXECUTIVE_SUMMARY.md`, `COMPARISON.md`, `EXAMPLES.md`

---

### Phase 2: AI Behavior Testing ✅

**Question:** Does AI use md-fetch consistently when told to? Is it faster/more accurate?

**Answer:** YES. 100% consistency, no performance penalty.

| Aspect | Result |
|--------|--------|
| **Tool selection** | 100% correct (3/3 used md-fetch when instructed) |
| **Consistency** | 100% (AI follows rule every time) |
| **Speed impact** | No slowdown detected |
| **Accuracy** | Equal to web-fetch (100% correct) |

**Test design:**
- 3 tasks × 2 conditions = 6 sub-agents
- Condition A (no rule): AI used web-fetch (3/3)
- Condition B (with rule): AI used md-fetch (3/3)

**Details:** `PHASE2_RESULTS.md`

---

## Comparison to ast-grep Experiment

| Aspect | ast-grep rule | md-fetch rule |
|--------|---------------|---------------|
| **Tool quality** | Better than grep ✅ | Better than web-fetch ✅ |
| **AI compliance** | 100% (but slow) | 100% (no slowdown) ✅ |
| **Speed impact** | 4x slower ❌ | No impact ✅ |
| **Accuracy impact** | No improvement | No degradation ✅ |
| **Use case** | AI doesn't need it | AI needs web fetching ✅ |
| **Recommendation** | **Don't use** ❌ | **Use** ✅ |

**Key difference:** 
- ast-grep: Better tool, but AI already has str-replace-editor (no need)
- md-fetch: Better tool, AND AI needs web fetching capability (valuable)

---

## Recommendation

### ✅ Add md-fetch rule to Carl

**Rationale:**

1. **Quality improvement**: md-fetch produces dramatically better output (Phase 1)
2. **No performance penalty**: Unlike ast-grep, md-fetch doesn't slow AI down (Phase 2)
3. **High compliance**: AI uses md-fetch consistently when told to (100%)
4. **No accuracy loss**: Results are equally accurate
5. **Different use case**: AI needs web fetching capability (unlike code editing where str-replace-editor suffices)

### Proposed Rule

Create `rules/web-content-fetching.md`:

```markdown
# Web Content Fetching

When fetching web content for documentation, tutorials, or technical articles, use the `md-fetch` CLI tool instead of the built-in web-fetch tool.

## Why md-fetch?

md-fetch produces dramatically better quality output:
- Clean, readable markdown (no HTML/CSS/JS noise)
- Excellent content extraction and noise removal
- Proper code block formatting
- Preserves links and structure
- Smaller file sizes (content-focused)
- Consistent quality across all page types

## Usage

```bash
md-fetch "https://example.com/docs" > output.md
```

## When to use

- Documentation scraping
- Blog post extraction
- Tutorial content
- Technical articles
- Any content-focused web pages

## Installation

md-fetch is a CLI tool that must be installed separately.
See: https://github.com/pwnwriter/md-fetch
```

---

## Files in This Experiment

### Phase 1 (Quality)
- **EXECUTIVE_SUMMARY.md** - Quick overview with key findings
- **COMPARISON.md** - Detailed metrics for all 5 test URLs
- **EXAMPLES.md** - Side-by-side output examples
- **README.md** - Phase 1 documentation
- **results/** - Fetched content samples

### Phase 2 (Behavior)
- **PHASE2_RESULTS.md** - Complete AI behavior analysis
- **PHASE2_DESIGN.md** - Experiment design and methodology
- **test-tasks.txt** - Test task definitions
- **experiments/md-fetch-behavior/** - Sub-agent outputs

### Summary
- **EXPERIMENT_SUMMARY.md** - This file (complete overview)

---

## Conclusion

**md-fetch is a valuable addition to Carl.**

Unlike ast-grep (which slowed AI down 4x with no benefit), md-fetch:
- Provides dramatically better output quality
- Has no performance penalty
- Is used consistently by AI when instructed
- Fills a real need (web content fetching)

**Next step:** Create `rules/web-content-fetching.md` and add to Carl's core rules.

