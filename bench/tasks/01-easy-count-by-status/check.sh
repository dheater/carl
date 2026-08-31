#!/usr/bin/env bash
# countByStatus must exist, be exported, and be right about the counts.
. "$BENCH_TASK_DIR/../common.sh"

add_hidden_tests
require_all_green 3
