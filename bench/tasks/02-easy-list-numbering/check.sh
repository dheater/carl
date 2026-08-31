#!/usr/bin/env bash
# 1-based numbering, with the checkbox rendering left intact.
. "$BENCH_TASK_DIR/../common.sh"

add_hidden_tests
require_all_green 3
