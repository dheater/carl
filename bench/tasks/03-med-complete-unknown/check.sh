#!/usr/bin/env bash
# The red test must go green on its own terms, and `remove` must get the same
# treatment `complete` did — which the shipped test says nothing about.
. "$BENCH_TASK_DIR/../common.sh"

require_unmodified src/complete-unknown.test.ts
add_hidden_tests
# 2 from this task's own setup, 3 hidden, on top of the fixture's baseline.
require_all_green 5
