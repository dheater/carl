#!/usr/bin/env bash
# A multi-file rename with call sites in three modules and three test files. The
# grep is the part a passing suite does not prove: leaving a `.done` behind and
# adding `status` alongside it satisfies every test and misses the point.
. "$BENCH_TASK_DIR/../common.sh"

grep -rn "TodoStatus" src/types.ts >/dev/null ||
  fail "src/types.ts does not declare TodoStatus"

# `\.done` rather than `done`: "done" is a legitimate status value and appears in
# every file that sets one.
if grep -rn "\.done\b" src/ >/dev/null; then
  echo "--- remaining references ---" >&2
  grep -rn "\.done\b" src/ >&2
  fail "src/ still reads or writes .done"
fi

if grep -rn "blocked" src/ >/dev/null; then
  fail "src/ mentions 'blocked', which this task explicitly excluded"
fi

add_hidden_tests
require_all_green 4
