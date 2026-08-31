#!/usr/bin/env bash
# A new module with a strict parser, wired into an existing one. The edge cases
# are the task: `new Date(input)` alone accepts most of what must be rejected.
. "$BENCH_TASK_DIR/../common.sh"

[ -f src/due.ts ] || fail "src/due.ts was not created"

add_hidden_tests
require_all_green 7
