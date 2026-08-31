# The model benchmark

`just bench` compares models on `carl code`. One trial is one model, one task, one
throwaway copy of a small TypeScript project — and two questions about what came
out: did the task's `check.sh` pass, and what does a judge that has never been
told which model wrote it think of the diff.

```
just bench                                    # the smoke matrix: 3 tasks × 3 models
just bench --tasks all --reps 3                # the full matrix
just bench --models sonnet4.6 --no-judge       # one arm, checks only
just bench --help
```

Output lands in `bench/results/<timestamp>/` — `report.txt`, `trials.json`, and
per-trial `repo/`, `diff.patch`, `carl.log`, `check.log`. That directory is
gitignored.

## What it measures, and what it does not

**Pass** is deterministic. The diff has to compile, the fixture's own tests and
the task's hidden tests all have to pass, no test may have been deleted, and
whatever the task said not to touch has to be untouched. There is no partial
credit: `check.sh` exits 0 or it does not.

**Correct / Scope / Style** are a judge's median score out of 5 across
`--judge-samples` verdicts. The judge sees the task text and the diff. It is not
told which model wrote it, and it is not told whether the checks passed — a judge
that knows the tests failed will find a reason, and the point of asking is to get
an opinion the checks did not already supply.

**Cost, turns, and tool errors** come from carl's own event log, joined to the
trial afterwards on workspace and time. Local models come out as `free`, which is
true of the marginal request and false of the machine.

**Wall time** is the whole `carl` invocation. For a local model the first trial of
an arm includes loading ~20GB of weights, so it is not comparable to the rest.
That is why trials are grouped by model rather than interleaved, and it is worth
remembering when reading a mean over a small number of trials.

The judge's own spend is reported separately, under the table. It belongs to no
model's row.

**Files and patch size** are in the per-trial table because a diff that touched 82
files is a finding whether or not the check passed. The judge sees a bounded prefix
of the diff, and the source changes are diffed first so that the truncation can
only ever cut the noise — a trial that dropped an `.npm-cache/` into the workspace
once pushed all its real work past the limit and was scored 1/1/1 for a refactor it
had completed correctly.

## The routing guard

`--model qwen38-27b` resolves against the local mtplx server first and falls back
to Bedrock. So a benchmark run with mtplx down would happily measure Sonnet three
times and print it as three models — the one error this cannot make quietly. Every
trial's logged route is compared against the model it was filed under; mismatched
trials are excluded from every rate, named in the report, and make the command
exit non-zero.

## Isolation

The whole run gets its own `CARL_CONFIG_DIR` under the results directory, so
benchmark runs never land in the event log that `carl stats` and
`docs/one-shot.md` are computed from. Its `config.json` is empty on purpose: with
no `validate` key carl runs no validation and therefore no repair attempts, so one
trial is one logged run.

## The fixture

`fixtures/todo-api` is a dependency-free TypeScript project: a todo store, a
filter, a formatter, and 13 tests. It installs nothing; `tsc` and `@types/node`
are borrowed from carl, so a trial costs no `npm install`.

Two of its behaviours are wrong on purpose, and its tests deliberately do not pin
them — a test asserting the bug would make the task impossible to complete without
editing a test, which is a different task.

## The tasks

Graded, so the smaller models are not measured entirely against tasks they cannot
do:

| Task | Tier | What it asks |
|---|---|---|
| `01-easy-count-by-status` | easy | add one exported function |
| `02-easy-list-numbering` | easy | fix off-by-one numbering |
| `03-med-complete-unknown` | medium | make a shipped red test green, and apply the same fix to its twin |
| `04-med-parse-due-date` | medium | a new strict date parser, wired into two existing modules |
| `05-hard-status-refactor` | hard | rename a boolean field to a union across three modules and three test files |
| `06-hard-sort-ties` | hard | turn a partial order into a total one |

Each task directory holds:

- `prompt.md` — what the model is asked, and the only thing it sees.
- `check.sh` — the deterministic verdict. Sources `tasks/common.sh`; exit 0 is a
  pass.
- `hidden/*.hidden.test.ts` — tests copied into `src/` **at check time only**. They
  never exist while the model is working, because "make the tests pass" is
  answerable by reading them, which measures something other than whether the code
  is right.
- `setup/*.ts` — optional. Files that are part of the starting state and are
  committed before the model runs, including tests that ship failing.

Your editor will report errors in `hidden/*.hidden.test.ts` — unresolved imports
of `./filter`, implicit `any`. That is expected: those files only resolve once the
harness copies them into `src/`, and they are excluded from the fixture's
`tsconfig.json` by living outside it.

### Adding a task

Make a directory under `tasks/`, put a `prompt.md` and a `check.sh` in it, and it
is discovered automatically. `check.sh` should source `common.sh` and end in
`require_all_green <n>`, where `n` is how many tests the task adds on top of the
fixture's baseline — including any it ships in `setup/`. The baseline is measured
at startup rather than hard-coded, so adding a test to the fixture does not
silently weaken every check.

The useful thing a check can do that a passing suite cannot is refuse the wrong
shape of a right answer: `05`'s `grep` for a leftover `.done` catches a diff that
added `status` alongside the field it was supposed to replace, which every test
would otherwise accept.
