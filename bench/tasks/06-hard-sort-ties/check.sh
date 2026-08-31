#!/usr/bin/env bash
# A total order with four keys. Passing needs every tier of the comparator, and
# the last hidden test catches a comparator that is merely stable rather than
# total — which is what `Array.prototype.sort` gives you for free.
. "$BENCH_TASK_DIR/../common.sh"

add_hidden_tests
require_all_green 6
