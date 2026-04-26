# Carl

Opinionated AI development workflow. A four-phase loop with human approval gates, driven by skill files and run by the `carl` CLI.

## Install

### Using Homebrew (macOS)

```bash
brew tap dheater/carl https://github.com/dheater/carl
brew install carl-ai
carl start  # Prompt will be collected via your editor
```

### Building from source

```bash
git clone https://github.com/dheater/carl.git
cd carl
just install
```

`just install` builds the TypeScript and installs a `carl` shim to `~/.local/bin/`.

## Usage

```bash
carl start              # Begin a new run (prompt collected via editor)
carl run                # Resume; opens an editor at any approval gate
carl status             # Show current phase and status
carl reset              # Abandon the current run
```

State lives in `.agent/` (gitignored).

## Workflow

```
architect → developer → verifier → reviewer
```

- **architect** — Challenges scope, asks clarifying questions, produces the ticket list.
- **developer** — Implements tickets one at a time using TDD.
- **verifier** — Interprets deterministic lint/test results, performs subtract-first cleanup, surfaces recommendations.
- **reviewer** — Sprint-end gate; validates the right thing was built and pauses for sign-off.

`architect` and `reviewer` are human-approval gates. On a gate, `carl` opens an editor with the agent's output. How you close the editor is how you respond:

- Save unchanged, save an empty buffer, or save a single line containing `approve` or `approved` (case-insensitive, with optional surrounding whitespace) → **approve**
- Save any other content → **reply** (the agent reads your feedback and re-runs the phase)
- Save `reject: <reason>` → **reject** (fall back to the previous phase)

At the architect gate, approval only hands off to developer after the latest architect output looks like a real slice plan. If architect is still asking questions or running scope challenge, the current buffer is fed back to architect and the workflow stays in architect.

Cross-phase coordination is managed via:
- **`.agent/dev-tickets.md` and `.agent/test-tickets.md`** — Ticket lists created by architect, read by developer and TestWriter
- **`.agent/notes/*.md`** — Phase outputs (architect.md, reviewer.md, etc.)
- **`state.history`** — Deterministic run history with all phase outputs and status
- **Lint/test logs** — `.agent/lint.log`, `.agent/tests-summary.json`, `.agent/tests.log`

Developer reads architect tickets from disk; reviewer reads prior architecture from state history.

## Layout

```
src/       TypeScript source for the carl CLI and loop
skills/    Skill files loaded into each phase's agent session
rules/     Rules intended for ~/.augment/rules/ (copy manually)
experiments/  Empirical validation of design principles
```

## License

MIT
