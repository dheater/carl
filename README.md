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
carl review        # Run reviewer (cleanup + verification)
carl chat          # Open editor; run the general-purpose agent
carl reset         # Clear .agent/
```

Phase artifacts live in `.agent/` (gitignored). Diagnostics in `.carl/events.jsonl`. Use `ls .agent/` to see what's in flight.

## Workflow

Typical flows:

```text
simple work:   code → review
complex work:  plan → code → review
```

Each command runs once and exits. There is no automatic kick-back between phases.

- **plan** — Architect writes `.agent/prd.md` for larger or ambiguous work. No code. No tickets. The PRD includes acceptance criteria.
- **code** — Developer runs the full implementation session: understand the request, write/update tests, change code, validate, and report. If `.agent/prd.md` exists, it is input context.
- **review** — Reviewer performs subtract-first cleanup and verification on the live git diff.
- **chat** — General-purpose agent for quick questions, research, and direct changes.

Indexing:
- **`plan` / `code` / `review`** index the repo by default.
- **`chat`** does not index the repo.

Artifacts:
- **`.agent/prd.md`** — Optional PRD for complex work
- **`.agent/notes/*.md`** — Per-phase notes and reports
- **`.carl/events.jsonl`** — Per-prompt timing and char counts

## License

MIT
