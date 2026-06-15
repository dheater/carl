# Carl

Opinionated AI development workflow. Manual phase commands driven by skill files and run by the `carl` CLI.

## Install

### Building from source

```bash
git clone https://github.com/dheater/carl.git
cd carl
just install
```

`just install` builds the TypeScript and installs a `carl` shim to `~/.local/bin/`.

## Usage

```bash
carl plan          # Open editor; write .agent/prd.md for complex work
carl code          # Open editor; run the implementation session
carl review        # Run reviewer on your own local changes (cleanup / refactor)
carl verify        # Run verifier on your own local changes (validation evidence)
carl chat          # Open editor for the first prompt, then enter interactive auggie chat
carl reset         # Clear .agent/

carl pr-review <github-pr-url>  # Review another developer's PR (requires gh CLI)
```

Phase artifacts live in `.agent/` (gitignored). Diagnostics in `.carl/events.jsonl`. Use `ls .agent/` to see what's in flight.

## Workflow

### Local development

```text
simple work:   code → verify
complex work:  plan → code → review? → verify
```

Each command runs once and exits. There is no automatic kick-back between phases.

- **plan** — Architect writes `.agent/prd.md` for larger or ambiguous work. No code. No tickets. The PRD includes acceptance criteria.
- **code** — Developer runs the full implementation session: understand the request, write/update tests, change code, validate, and report. If `.agent/prd.md` exists, it is input context.
- **review** — Reviewer performs subtract-first cleanup and acceptance-criteria audit on your own live git diff. Does not touch PRs.
- **verify** — Verifier runs the smallest meaningful validation, records the commands and results, and reports remaining risk.
- **chat** — General-purpose agent for quick questions, research, and direct changes.

### PR review

Review another developer's PR from a local checkout:

```bash
gh pr checkout <number>          # check out the PR branch
carl pr-review <github-pr-url>   # draft and upload a pending review
```

`carl pr-review` is a one-shot command:

1. Validates `gh` CLI is installed and authenticated.
2. Parses the PR URL and checks that the local repo matches the PR repo.
3. Fetches PR metadata from GitHub; rejects fork PRs.
4. Confirms local HEAD matches the PR head commit (fails with a `git checkout` hint on drift).
5. Fetches the authoritative PR diff from GitHub.
6. Writes `.agent/pr-review.md` containing the diff and a `## Review comments` section.
7. Runs the pr-reviewer skill — prose-only anchored comments, no workspace edits.
8. Validates all `||| COMMENT` anchors against the PR diff; reruns once to fix errors.
9. Creates a **pending** GitHub review (not auto-submitted). Open the PR on GitHub and submit it.

No tracked workspace files are modified. Only `.agent/pr-review.md` changes.

**Reset**: `carl reset` clears `.agent/` and discards the draft. Rerun `carl pr-review <url>` to start fresh.

**Error cases**: repo mismatch, HEAD drift, tracked local drift outside `.agent/`, missing draft, empty diff, fork PR, malformed comment anchors, and missing rationale all fail with an explicit actionable message.

Indexing:

- **`plan` / `code` / `review` / `verify` / `chat`** index the repo by default (via Auggie).
- **`pr-review`** reads workspace files for context but does not modify them.

Artifacts:

- **`.agent/prd.md`** — Optional PRD for complex work
- **`.agent/pr-review.md`** — PR review draft (created and consumed by `carl pr-review`)
- **`.agent/notes/*.md`** — Per-phase notes and reports
- **`.carl/events.jsonl`** — Per-phase timing and outcome metadata

## License

MIT
