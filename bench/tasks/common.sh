# Shared helpers for task checks. Sourced by each task's check.sh, with the
# trial workspace as the working directory.
#
# The harness supplies three variables, because a check must not depend on what
# happens to be installed on the machine running it:
#
#   BENCH_TSC             the TypeScript compiler to use. The fixture has no
#                         dependencies of its own and the checks borrow carl's,
#                         so a trial costs no `npm install`.
#   BENCH_TASK_DIR        this task's directory, for reaching `hidden/`.
#   BENCH_BASELINE_TESTS  how many tests the pristine fixture passes, measured
#                         once at startup rather than hard-coded, so adding a
#                         fixture test does not silently weaken every check.

set -u

TEST_LOG=".bench-check.log"

fail() {
  echo "CHECK FAIL: $*" >&2
  exit 1
}

# Type errors are a distinct failure from test failures and worth reporting as
# one: a diff that does not compile never got as far as being wrong.
typecheck() {
  "$BENCH_TSC" --noEmit -p tsconfig.json || fail "tsc --noEmit reported errors"
}

# Compiles and runs the suite, echoing the number of passing tests so a caller
# can refuse a diff that went green by deleting tests. Emits to stdout only that
# count; everything the compiler and runner said goes to the log and, on
# failure, to stderr.
run_tests() {
  rm -rf build
  if ! "$BENCH_TSC" -p tsconfig.json >"$TEST_LOG" 2>&1; then
    cat "$TEST_LOG" >&2
    fail "tsc could not build the project"
  fi
  # The glob rather than the directory: `node --test build/` reads the directory
  # as a single test file and reports one opaque failure.
  if ! node --test "build/*.test.js" >"$TEST_LOG" 2>&1; then
    cat "$TEST_LOG" >&2
    fail "node --test reported failures"
  fi
  awk '/^. pass /{print $3; exit}' "$TEST_LOG"
}

require_min_tests() {
  local want="$1" got="${2:-0}"
  [ "$got" -ge "$want" ] ||
    fail "only $got tests passed, expected at least $want — did the diff delete tests?"
}

# Hidden tests are copied in at check time and never exist while the model is
# working. Without that, "make the tests pass" is answerable by reading them,
# which measures something other than whether the code is right.
add_hidden_tests() {
  [ -d "$BENCH_TASK_DIR/hidden" ] || fail "task has no hidden/ directory"
  cp "$BENCH_TASK_DIR"/hidden/*.ts src/ || fail "could not copy hidden tests"
}

# A file the task said not to touch. The starting state is a git commit, so this
# is a real comparison rather than a heuristic — and "make the failing test pass"
# has an obvious cheat that this is the only defence against.
require_unmodified() {
  git diff --quiet HEAD -- "$1" ||
    fail "$1 was modified, and this task requires it to be left alone"
}

# The fixture's own tests plus this task's hidden ones, all green, and no test
# quietly removed along the way. The usual last line of a check.
require_all_green() {
  local extra="${1:-0}"
  typecheck
  local passed
  passed="$(run_tests)"
  require_min_tests "$((BENCH_BASELINE_TESTS + extra))" "$passed"
}
