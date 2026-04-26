# Carl

Opinionated AI development workflow. A four-phase loop with human approval gates, driven by skill files and run by the `carl` CLI.

## Install

### Using Homebrew (macOS)

```bash
brew tap dheater/carl https://github.com/dheater/carl
brew install carl-ai
carl start "<prompt>"
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
carl start "<prompt>"   # Begin a new run
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

On architect approval, the architect's output is split into `.agent/dev-tickets.md` and `.agent/test-tickets.md` for developer and TestWriter execution, and indexed into a persistent workflow context. **Developer and TestWriter do not receive that context window** — they read disk artifacts only (`.agent/dev-tickets.md`, `.agent/test-tickets.md`, `.agent/notes/architect.md`, lint/test logs). **Reviewer reads from and writes to that same context window**, so it can validate what was planned against what was built, and architect picks up the reviewer's findings at the start of the next sprint.

## Layout

```
src/       TypeScript source for the carl CLI and loop
skills/    Skill files loaded into each phase's agent session
rules/     Rules intended for ~/.augment/rules/ (copy manually)
experiments/  Empirical validation of design principles
```

## License

MIT
