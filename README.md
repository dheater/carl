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

`carl chat` requires `auggie` on PATH (Augment CLI).

## Usage

```bash
carl [--model <model>] <command>
carl --version
```

```bash
carl code [<prompt-file>]        # Open editor (or read file) for a prompt; run implementation skill
carl review                      # Review staged/uncommitted local changes; open notes in editor
carl chat [<prompt-file>]        # Open editor (or read file) for a prompt; start interactive auggie session
carl reset                       # Clear .agent/

carl pr-review <github-pr-url>   # Review another developer's PR (requires gh CLI)
```

`code` writes `.agent/notes/code.md`; `review` writes `.agent/notes/review.md`. Both open in your editor when done. `pr-review` writes `.agent/notes/pr-review.md` and adds pending comments to the GitHub PR. `chat` is interactive and ephemeral — no notes written. Diagnostics in `.carl/events.jsonl`.

### Model override

`--model <model>` overrides the model for the run, ignoring config and defaults.

Default models (written to `.carl/config.json` on first run):

```json
{
  "models": {
    "code": "sonnet4.6",
    "chat": "gpt5.4",
    "review": "gpt5.4",
    "pr-review": "gpt5.4"
  }
}
```

Edit `.carl/config.json` to change defaults persistently.

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

## License

MIT
