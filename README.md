# Carl

Opinionated AI development workflow. Manual skill commands run by the `carl` CLI.

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
carl duck          # Rubber duck: index code and ask critical questions to debug, design, trace, or analyze logs
carl review        # Run reviewer on your own local changes (cleanup / refactor)
carl reset         # Clear .agent/

carl pr-review <github-pr-url>  # Review another developer's PR (requires gh CLI)
```

Skill artifacts live in `.agent/` (gitignored). Diagnostics in `.carl/events.jsonl`. Use `ls .agent/` to see what's in flight.

## Workflow

### Local development

```text
duck → review
```

Each command runs once and exits. There is no automatic kick-back between skills.

- **duck** — Rubber duck for design, debug, trace, and log analysis. Indexes code, asks critical numbered questions, and summarizes findings in `.agent/notes/duck.md`. No code, no PRD, no file edits.
- **review** — Reviewer assesses the changes and makes recommendations to cleanup and fix bugs.

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
6. Writes `.agent/notes/pr-review.md` containing the diff and a `## Review comments` section.
7. Runs the pr-review skill — prose-only anchored comments, no workspace edits.
8. Validates all `||| COMMENT` anchors against the PR diff; reruns once to fix errors.
9. Creates a **pending** GitHub review (not auto-submitted). Open the PR on GitHub and submit it.

No tracked workspace files are modified. Only `.agent/notes/pr-review.md` changes.

**Reset**: `carl reset` clears `.agent/` and discards the draft. Rerun `carl pr-review <url>` to start fresh.

**Error cases**: repo mismatch, HEAD drift, tracked local drift outside `.agent/`, missing draft, empty diff, fork PR, malformed comment anchors, and missing rationale all fail with an explicit actionable message.

Indexing:

- **`duck` / `review`** index the repo by default (via Auggie).
- **`pr-review`** reads workspace files for context but does not modify them.

Artifacts:

- **`.agent/notes/pr-review.md`** — PR review draft (created and consumed by `carl pr-review`)
- **`.agent/notes/*.md`** — Per-skill notes and reports
- **`.carl/events.jsonl`** — Per-skill timing and outcome metadata

## License

MIT
