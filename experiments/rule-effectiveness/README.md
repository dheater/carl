# Rule Effectiveness Experiment

**Status:** Complete (20 tests, 90% confidence)

## Purpose

Test whether the ephemeral-scripts rule improves AI tool selection for code refactoring tasks.

## Methodology

**A/B test design:**
- 2 conditions: no rule vs new rule
- 10 scenarios (7 code tasks, 3 text tasks)
- 20 total tests (10 scenarios × 2 conditions)
- Independent sub-agents with clean context windows

**Execution:**
- Use sub-agent tool to launch independent AI instances
- Each sub-agent gets one instruction (with or without rule context)
- Extract tool choice from response
- Compare against correct tool for the task

**Metrics:**
- Accuracy: % correct tool choices
- By category: code vs text tasks
- Statistical test: Fisher's exact test

**Sample size:**
- For 90% confidence (alpha=0.10), 80% power, large effect size
- n=10 per group is adequate
- Randomly sampled from 15 scenarios

## Results

**Overall accuracy:**
- No rule: 5/10 = 50.0%
- New rule: 10/10 = 100.0%

**By category:**
- Code tasks (7 scenarios):
  - No rule: 2/7 = 28.6%
  - New rule: 7/7 = 100.0%
- Text tasks (3 scenarios):
  - No rule: 3/3 = 100.0%
  - New rule: 3/3 = 100.0%

**Statistical significance:**
- Fisher's exact test: p = 0.033
- ✓ Statistically significant at 90% confidence (p < 0.10)
- ✓ Also significant at 95% confidence (p < 0.05)

**Key findings:**
1. New rule improves code task accuracy from 29% to 100%
2. Text task accuracy remains 100% (both conditions)
3. Without rule, AI often chooses codebase-retrieval + str-replace-editor instead of ast-grep
4. With rule, AI consistently chooses ast-grep for code tasks

## Test Cases

See `results.csv` for all 20 test results.

**Code scenarios tested:**
1. rename_function
2. update_struct
3. api_signature
4. update_type
5. update_constant
6. remove_deprecated
7. refactor_loop

**Text scenarios tested:**
1. find_todos
2. search_logs
3. search_docs

## Limitations

1. **Sample size:** 20 tests (adequate for 90% confidence with large effect)
2. **Sub-agent fidelity:** May not perfectly represent independent AI instances
3. **Task selection:** Limited to 10 scenarios, may not generalize to all tasks
4. **Base model knowledge:** Results specific to Claude Sonnet 4.5 (2026-01-13)

## Conclusion

The ephemeral-scripts rule significantly improves AI tool selection for code refactoring tasks:
- **50% → 100% accuracy** (p = 0.033)
- **Code tasks: 29% → 100%** (critical improvement)
- **Text tasks: 100% → 100%** (no degradation)

The rule is effective and worth keeping.

