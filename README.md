# Carl

Opinionated AI development workflow CLI. Three commands: write code, review your own changes, review a teammate's PR.

## Why

I have tried spec-driven development with sopisticated AI orchastration. I prefer being the orcharstrator and using
AI as an assistance tool. I've found that being to far from the implementation means I can't effectively answer questions
about, debug, and maintain the code. Carl is my effort to find a good balance between human and AI coding.
Carl's commands are intentionally single-shot. I find this helps me keep iterations small and keeps me in the loop.

I prefer my text editor over small prompt boxes. That is why Carl uses $EDITOR as a "Tom Riddle's Diary" interface.
When Carl is run, you enter your prompt in your editor. When Carl responds, its output is also written into your editor.
This allows you to edit the output, save it, and feed the file back as the next prompt. This works very well for
iterating between `carl review` and `carl code`.

## Prerequisites

- Node.js 18+
- AWS credentials with Bedrock access (default backend) — or an [Augment](https://www.augmentcode.com/) account
- `gh` CLI — required only for `carl pr-review`

## Install

**From a release** (no build step):

```bash
curl -fsSL https://github.com/dheater/carl/releases/latest/download/carl.mjs \
  -o ~/.local/bin/carl.mjs
echo '#!/usr/bin/env bash
exec node "$HOME/.local/bin/carl.mjs" "$@"' > ~/.local/bin/carl
chmod +x ~/.local/bin/carl
```

**From source:**

```bash
git clone https://github.com/dheater/carl.git
cd carl
npm ci && npm run build
# then install the shim:
just install
# or manually:
echo "exec node \"$(pwd)/dist/carl.mjs\" \"\$@\"" > ~/.local/bin/carl
chmod +x ~/.local/bin/carl
```

## Configuration

On first run, carl writes `~/.config/carl/config.json`:

```json
{
  "backend": "bedrock",
  "models": {
    "code": "sonnet4.6",
    "review": "sonnet4.6",
    "pr-review": "sonnet4.6"
  }
}
```

A per-project `.carl/config.json` is optional and overrides the global file
field-by-field. `CARL_CONFIG_DIR` overrides the global directory (used by tests).

**Backends:**

- `"bedrock"` — AWS Bedrock. Requires AWS credentials in the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, or an IAM role).
- `"auggie"` — Augment SDK. Requires `@augmentcode/auggie-sdk` available (it is bundled when installing from source).

Edit `~/.config/carl/config.json` to change the backend or default models.

## Usage

```
carl [--model <model>] <command>
carl --version
```

| Command                          | What it does                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `carl code [<prompt-file>]`      | Open editor (or read file) for a prompt; run the implementation skill; open notes in editor |
| `carl review`                    | Review staged/uncommitted local changes; open notes in editor                               |
| `carl pr-review <github-pr-url>` | Review a teammate's PR; create a pending GitHub review                                      |
| `carl reset`                     | Clear `.agent/`                                                                             |
| `carl stats`                     | Report cost, tokens, turns, and duration per skill                                          |

`--model <model>` overrides the model for that run. Supported model aliases: `sonnet4.6`, `sonnet4.5`, `sonnet4`, `haiku4.5`, `opus4.5` (and others — see `~/.config/carl/config.json` after first run).

Diagnostics are appended to `~/.config/carl/events.jsonl`, one JSON object per line.

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
carl pr-review https://github.com/owner/repo/pull/<number>
```

Carl fetches the authoritative diff from GitHub, runs the review skill, and creates a **pending** review — it is not submitted automatically. Open the PR on GitHub to review and submit it.

Requires: `gh` CLI installed and authenticated, local HEAD matching the PR head commit, and the PR must not be from a fork.

**Reset a draft:** `carl reset` clears `.agent/`. Rerun `carl pr-review <url>` to start fresh.

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
