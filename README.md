# Carl

Opinionated AI development workflow CLI: ask about the code, plan a change, write it, review your own changes, work through review feedback, review a teammate's PR.

## Why

I have tried spec-driven development with sopisticated AI orchastration. I prefer being the orcharstrator and using
AI as an assistance tool. I've found that being to far from the implementation means I can't effectively answer questions
about, debug, and maintain the code. Carl is my effort to find a good balance between human and AI coding.
Carl's commands are intentionally single-shot. I find this helps me keep iterations small and keeps me in the loop.

I prefer my text editor over small prompt boxes. That is why Carl uses $EDITOR as a "Tom Riddle's Diary" interface.
When Carl is run, you enter your prompt in your editor. When Carl responds, its output is also written into your editor.
This allows you to edit the output, save it, and feed the file back as the next prompt. This works very well for
iterating between `carl review` and `carl code`.

Off a terminal — backgrounded, piped, or in CI — Carl opens no editor. It prints the path it wrote instead, and a
command with no prompt file exits with the file to pass.

## Prerequisites

- Node.js 22.15+ — the agent runtime compresses session transcripts with
  `node:zlib`'s Zstandard APIs, which landed in that release. Carl is developed
  and tested on Node 26.
- AWS credentials with Bedrock access, in the environment or a profile the AWS
  SDK chain can find (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `~/.aws`, or
  an IAM role).
- `gh` CLI, installed and authenticated — required only for `carl pr-review`, which
  reads the PR diff with it.
- [`tuicr`](https://github.com/agavra/tuicr) — required only for `carl pr-review`,
  which opens the drafted comments in it (`brew install tuicr`).
- `just` — optional; it only saves you writing the shim by hand.

## Install

Carl installs from source and runs out of its clone:

```bash
git clone https://github.com/dheater/carl.git
cd carl
npm ci          # installs dependencies and builds dist/carl.mjs via `prepare`
just install    # writes the shim to ~/.local/bin/carl
carl --version
```

If you would rather not install `just`, the shim is one line:

```bash
echo "exec node \"$(pwd)/dist/carl.mjs\" \"\$@\"" > ~/.local/bin/carl
chmod +x ~/.local/bin/carl
```

Either way, `~/.local/bin` needs to be on your `PATH`.

The shim points back at the clone on purpose. `dist/carl.mjs` is not
self-contained: the agent runtime is a separate process launched out of
`node_modules/`, and its composition lives in `runtime/cordis.yml`, so the bundle
needs both siblings present. Copying `carl.mjs` somewhere on its own will not
work, and there is no single-file release for the same reason.

To update: `git pull && npm ci`. Re-run `just install` only if you moved the
clone.

### Do I have to install DeepSeek Harness first?

No. DSH is not a separate program you install and point carl at — it is a set of
npm libraries, and carl depends on them like any other package. `npm ci`
installs them. There is no `dsh` CLI to install, nothing to initialize, and no
`~/.dsh` profile to write: carl composes its own runtime from
`runtime/cordis.yml` in this repo (see [Runtime](#runtime)) and boots it with the
DSH JSON-RPC entry point out of `node_modules/`.

Carl also never reads or creates `~/.dsh`, so an existing DSH installation
neither helps nor interferes. The plugins that would read from there — the
user-global `AGENTS.md` loader and the skill filesystem — are both switched off
in carl's composition. `DSH_HOME` is still exported into `bash` tool calls, since
a script may care, but nothing in carl consults it.

Two npm details worth knowing, in case an install looks odd:

- **Carl pins exact DSH versions.** The `latest` dist-tag on these packages is
  older than the `next` one, so `npm install @deepseek-ai/dsh-...` without a
  version resolves to a stale prerelease. Change versions in `package.json`
  deliberately, not by re-adding a dependency.
- **`npm ci` prints an `allow-scripts` warning listing packages whose install
  scripts were skipped.** That is expected and nothing is broken. Carl approves
  the one install script it actually needs — `dsh-subprocess-local`, which
  restores the executable bit on the terminal helper `bash` spawns — through the
  `allowScripts` field in `package.json`, so `npm ci` runs it for you. The rest
  are skipped because their packages ship prebuilt binaries for every platform
  carl runs on.

## Configuration

On first run, carl writes `~/.config/carl/config.json`:

```json
{
  "models": {
    "code": "sonnet4.6",
    "ask": "sonnet4.6",
    "plan": "sonnet4.6",
    "feedback": "sonnet4.6",
    "review": "sonnet4.6",
    "pr-review": "sonnet4.6"
  }
}
```

A per-project `.carl/config.json` is optional and overrides the global file
field-by-field. `CARL_CONFIG_DIR` overrides the global directory (used by tests).

Edit `~/.config/carl/config.json` to change the default models and effort levels.

There is nothing to configure for AWS beyond having credentials. Every model is
invoked through a us-east-1 inference profile; AWS refuses on-demand invocation
of these models any other way, so there is no region to configure.

Earlier versions had a `"backend"` field with one valid value. It is gone, and an
existing config.json that still names it keeps working — the key is ignored.

### Validation

```json
{
  "validate": "just check",
  "maxRetries": 2
}
```

`validate` is the shell command that decides whether a change is good. After
`carl code` or `carl feedback` stops, carl runs it in the workspace root through a shell (so
`just lint && just test` works), and if it fails, starts a **fresh** session with
the original request, the previous session's summary, and the command's output —
up to `maxRetries` repair runs (default `2`; `0` validates and reports without
repairing). Whether the tests pass is a fact about the workspace, so carl checks
it instead of asking the model whether it is done.

`maxRetries` is a ceiling, not a promise to spend: **a repair session that
changed no file ends the loop.** It cannot have changed the outcome, so another
run would only re-roll the same dice at full price. That is why the budget needs
no upper bound — the gate, not the number, is what stops a runaway.

Because it is a per-project fact, `validate` usually belongs in the project's own
`.carl/config.json`. With no `validate` configured, carl runs the skill once and
hands back, and tells the session that nothing will check its work.

Details worth knowing:

- `carl code` and `carl feedback` validate — they are the two commands that
  change the workspace. `ask`, `plan` and `review` are read-only and `pr-review`
  only writes a draft, so there is nothing to check.
- The model is told which command carl will run, and asked to run it before
  finishing — a fix inside the first session is far cheaper than another one.
- A second or later repair session is told how many repairs already failed, so it
  reconsiders instead of retrying the previous session's fix.
- The last 8000 characters of combined stdout and stderr go to the repair
  session. Runners print failures last, so the tail is the useful end.
- A command that has not finished in 15 minutes is killed and **not** retried:
  `spawnSync` discards a killed process's output, so there would be nothing to
  hand the repair session.
- "Changed no file" means no successful `write`/`edit` tool call. `bash` does not
  count — nearly every session runs it to look around — so a session that only
  mutated files through `sed -i` reads as stalled. The cost of that is stopping
  early and handing back to you.
- If validation is still failing when the loop ends, carl says so after the notes
  close, prints the output, and exits non-zero. Nothing is reverted — the
  workspace is left as the last run made it. The message says _why_ it stopped,
  because raising `maxRetries` helps an exhausted budget and helps nothing else.

Each validated run appends a `validation` event to
`~/.config/carl/events.jsonl` recording how the loop ended, so the defaults can
be argued from data rather than taste:

```bash
jq -r 'select(.event=="validation") | [.meta.repairs, .meta.passed, .meta.stopped] | @tsv' \
  ~/.config/carl/events.jsonl | sort | uniq -c
```

Read the columns as: how many repairs it took, whether it ended green, and what
ended it (`passed`, `budget`, `stalled`, `timeout`). A pile of
`1  true  passed` says one repair earns its keep; `stalled` rows are runs the
gate saved you from paying for. The per-attempt `validate` events carry
`session_mutations` if you want to see it attempt by attempt. `carl stats` does
not report any of this yet.

## Runtime

The agent itself is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
runtime, composed by `runtime/cordis.yml` and driven over stdio JSON-RPC. Carl
spawns one runtime per skill run and reads its session events for the output,
token accounting, and tool timings.

Two consequences worth knowing:

- **Tools run in Code Mode.** The model writes one TypeScript program per turn
  that calls tools as functions, instead of emitting one tool call per turn.
  `carl stats` shows both layers: the outer `run_code` calls are model
  round-trips, the inner `read`/`edit`/`bash` calls are the work.
- **`ask`, `plan` and `review` are sandboxed read-only** — they cannot write at
  all. `code`, `feedback` and `pr-review` run workspace-write (`pr-review` only to
  edit its own draft). The sandbox is the runtime's filesystem boundary, not a
  hidden write tool, so `bash` cannot route around it either.

Session transcripts are written under `~/.config/carl/sessions/`, namespaced by
workspace — never inside your repository.

## Usage

```
carl [--model <model>] <command>
carl --version
```

| Command                          | What it does                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `carl code [<prompt-file>]`      | Open editor (or read file) for a prompt; run the implementation skill; open notes in editor |
| `carl code --plan`               | Implement the plan in `.agent/notes/plan.md`, your edits included                           |
| `carl ask [<prompt-file>]`       | Ask a question about the code; read-only, answer opens in editor                            |
| `carl plan [<prompt-file>]`      | Plan a change without making it; read-only, plan opens in editor                            |
| `carl review`                    | Review staged/uncommitted local changes; open notes in editor                               |
| `carl feedback [<file>]`         | Assess review comments, apply the correct ones, report each disposition                     |
| `carl feedback --review`         | Same, reading the comments from `.agent/notes/review.md`                                    |
| `carl pr-review <pr-number>`     | Review a teammate's PR; open the drafted comments in tuicr to edit and submit               |
| `carl reset`                     | Clear `.agent/`                                                                             |
| `carl stats`                     | Report cost, tokens, turns, and duration per skill                                          |

`--model <model>` overrides the model for that run. Supported aliases: `haiku4.5`,
`sonnet4.5`, `sonnet4.6`, `sonnet5`, `opus4.1`, `opus4.5`, `opus4.6`, `opus4.7`,
`opus4.8`, `opus5`, `fable5`.

`--effort low|medium|high` overrides how much the model thinks. `low` is the
smallest thinking budget the model offers, not none.

While a skill runs, carl streams progress to **stderr** — one timestamped line
per model request, per tool call the agent's program makes, and per thing the
agent says on its way to the answer:

```
  [3s] thinking…
  [7s] read {"file_path":"src/skill.ts"}
  [9s] grep {"pattern":"runSkill"}
```

It is stderr so that redirecting stdout keeps the progress on your terminal, and
piping stdout keeps the progress out of the pipe. `carl code 2>/dev/null`
silences it; `carl code 2>progress.log` follows it from another window.

Diagnostics are appended to `~/.config/carl/events.jsonl`, one JSON object per line.

## Ask and plan

Two read-only commands for the part of the work that is thinking rather than
typing. Neither can change a file — the sandbox is read-only, so "writes
nothing" is enforced rather than promised.

```bash
carl ask                     # editor opens for the question
carl ask question.md         # or read it from a file
carl plan                    # editor opens; the plan lands in .agent/notes/plan.md
carl code --plan             # implement that plan, your edits included
```

`carl ask` answers a question about the code and writes the answer to
`.agent/notes/ask.md`. It is one turn, not a chat session: to follow up, edit the
answer file and pass it back with `carl ask .agent/notes/ask.md`. That is the same
diary loop `review` and `code` use, and it keeps you in the loop by construction.
The skill is told to lead with the answer, cite `path:line`, and say "I don't
know" rather than guess.

`carl plan` investigates and writes an implementation plan — goal, files to touch,
ordered steps, tests, out of scope, risks — to `.agent/notes/plan.md`. It opens in
your editor when the session ends, which is where the plan is approved: **edit the
file until it says what you want built, then run `carl code --plan`.** That reads
the file back verbatim, your edits included, as the implementation prompt. The
plan session and the implementation session share no memory, so anything you
delete from the plan is gone and anything you add is instruction.

`carl code --plan` fails with a pointer to `carl plan` when there is no plan file.
`carl reset` deletes it along with the rest of `.agent/`.

Both commands respect `models` and `efforts` in config.json under the keys `ask`
and `plan`. `plan` defaults to `high` effort for the same reason `pr-review` does:
it is the cheap step whose mistakes are paid for by the expensive one after it.

### Why not DSH plan mode

DSH ships `@deepseek-ai/dsh-plan-mode`, and carl deliberately does not mount it.
Three reasons, all structural:

- **Carl could not turn it on.** Plan mode activates through `ctx.planMode.set()`
  or the `/plan` command in the UI command plane. The JSON-RPC wire carl drives
  the runtime over serves `initialize`, `session/prompt` and `shutdown` — there is
  no command plane and no service access, so every SDK session would start with
  plan mode inactive and no way to flip it.
- **Its exit needs a human at the keyboard.** `exit_plan_mode` reviews the plan
  through `ctx.userQuestions` and requires an exact approval. Carl has no
  interactive channel during a run — the same reason approvals are set to `never`
  — so that tool could only ever fail. Carl's approval is the editor, after the
  run.
- **Carl's guidance is already stronger.** Plan mode contributes its section at
  system-prompt order 50; carl's skill and rules are the order-0 persona.

So `carl plan` is a carl skill with a read-only sandbox and a file handoff, which
lands in the same place: explore, do not touch the code, present a plan a human
approves before anything is built.

## Feedback

`carl feedback` works through review comments: it checks each one, applies the ones
that hold up, and writes a reply per comment that you can paste back into the
thread it came from.

```bash
carl feedback                  # editor opens; paste the PR review
carl feedback comments.md      # or read it from a file
carl feedback --review         # or take the comments from .agent/notes/review.md
```

**The comments are claims, not instructions.** The skill is told to read the code
each one points at, judge the claim against that code rather than the reviewer's
confidence, and prove behavioral claims by running something before acting on
them. A reviewer — human or bot — can cite a language rule that does not say what
they think it says, or describe a function that has since been deleted. Rejecting
a wrong comment with evidence is a success; applying one is a defect carl
introduced.

Every comment gets exactly one verdict: **Applied**, **Applied differently**,
**Already handled**, **Stale**, **Rejected**, **Deferred**, or **Needs your call**.
Each becomes its own block in `.agent/notes/feedback.md`, headed with the
`path:line` or the reviewer's own heading, saying what was checked, what was found,
and what changed — plain enough to paste into a thread without rewriting it. The
file ends with the verdict counts, the files changed, and the check that was run.

Because it edits code, `carl feedback` validates exactly like `carl code`: the
`validate` command runs afterwards and a failure starts a repair session. It
carries the same git policy too — it will not commit for you.

## Stats

`carl stats` reports what carl costs and how hard it is working, broken out by skill.

```
carl stats                                  # this week (default)
carl stats --this-month
carl stats --this-year
carl stats --all
carl stats --from 2026-08-01 --to 2026-08-05 # --to is inclusive
carl stats --skill code
carl stats --json                            # aggregates for downstream charting
```

```
SKILL      RUNS    COST  $/RUN  p50 DUR  p50 TURNS  p50 TOKENS  p50 TOOLS  CACHE  ERR
code        246  $78.95  $0.34      57s         10        127k         12    94%   6%
review       33   $5.58  $0.17      47s        8.5        127k         14    89%   3%
TOTAL       287  $84.53  $0.32      56s         10        127k                     6%
```

Also printed: per-skill cost/duration/turn/token histograms, per-tool call counts
and error rates, and breakdowns by effort level, workspace, and day.

The event log is the source of truth. `~/.config/carl/metrics.db` is a derived
cache that is refreshed incrementally on every run; delete it or pass `--rebuild`
at any time and it is reconstructed from the log.

Unpriced runs (no token data recorded, or a model with no known rates) are
reported as unpriced, never as $0.

**Costs are always reported at current rates, including historical runs.** These
metrics exist to show whether a change to carl made it cheaper, so every run is
priced with one rate table; pricing each run at the rates in effect on its own
date would make a vendor price change look like a regression in carl. When the
rate table changes, the next `carl stats` reprices every cached run and says so.
Historical invoices will not match — use AWS Cost Explorer for billing.

## PR review

```bash
gh pr checkout <number>
carl pr-review <number>
```

The PR number is resolved against the repo in the current directory. Carl fetches the
authoritative diff from GitHub, runs the review skill, then opens
[tuicr](https://github.com/agavra/tuicr) on that PR and loads every drafted comment
into it as a local draft, authored as `carl (<model>)`. You read the diff, edit or
delete comments, add your own, and `:submit` when you are happy — carl never posts
anything to GitHub itself. Comments you drop in tuicr are dropped.

Carl waits for tuicr to publish its review session before injecting the comments, so
they appear a moment after the TUI opens (after the commit selector, if tuicr shows
one).

Comments are written for the person who has to act on them: what is wrong in plain
language, then one concrete recommendation, in a short paragraph. The skill is told
to write for a developer six months into the job who does not know the codebase, to
name a consequence rather than a category ("this crashes when the list is empty",
not "unhandled edge case"), and to define any term of art in the same sentence it
uses one. Carl rejects an inline comment that opens with a code fence instead of a
sentence, and re-runs the session to fix it.

Requires: `gh` and `tuicr` installed, `gh` authenticated, and local HEAD matching the
PR head commit — the review skill reads workspace files for context, so a checkout on
a different commit would produce comments about code the PR does not contain.

**Reset a draft:** `carl reset` clears `.agent/`. Rerun `carl pr-review <number>` to start fresh.

## Vim integration

I often just open a scratch buffer `:enew` and write a propt there, then use a keybind to send the prompt to `carl code`.
These are some keybinds for carl that I use with nvim:

```
-- Carl: run code skill with current buffer as prompt
vim.keymap.set("n", "<leader>cc", function()
  local tmpfile = vim.fn.tempname() .. ".md"
  vim.fn.writefile(vim.fn.getline(1, "$"), tmpfile)
  vim.cmd("enew")
  vim.fn.termopen("carl code " .. tmpfile, {
    env = { EDITOR = "nvim --server " .. vim.v.servername .. " --remote" },
    cwd = vim.fn.getcwd(),
    on_exit = function()
      vim.fn.delete(tmpfile)
    end,
  })
  vim.cmd("startinsert")
end, { desc = "Carl: run code skill with current buffer as prompt" })

-- Carl: run review skill
vim.keymap.set("n", "<leader>cr", function()
  vim.cmd("enew")
  vim.fn.termopen("carl review", {
    env = { EDITOR = "nvim --server " .. vim.v.servername .. " --remote" },
    cwd = vim.fn.getcwd(),
  })
  vim.cmd("startinsert")
end, { desc = "Carl: run review skill" })
```

## License

MIT
