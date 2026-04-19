# Carl

Opinionated AI development workflow. A four-phase loop with human approval gates, driven by skill files and run by the `carl` CLI.

## Install

```bash
git clone https://github.com/carl-lang/carl.git
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
architect → developer → reviewer
```

- **architect** — Challenges scope, asks clarifying questions, produces the ticket list.
- **developer** — Implements tickets one at a time using TDD.
- **reviewer** — Sprint-end gate; validates the right thing was built and pauses for sign-off.

`architect` and `reviewer` are human-approval gates. On a gate, `carl` opens an editor with the agent's output. How you close the editor is how you respond:

- Save unchanged, save an empty buffer, or save the single word `approve` → **approve**
- Save any other content → **reply** (the agent reads your feedback and re-runs the phase)
- Save `reject: <reason>` → **reject** (fall back to the previous phase)

On architect approval, the architect's output is written verbatim to `.agent/tickets.md` and the developer picks up from there.

## Layout

```
src/       TypeScript source for the carl CLI and loop
skills/    Skill files loaded into each phase's agent session
rules/     Rules intended for ~/.augment/rules/ (copy manually)
experiments/  Empirical validation of design principles
```

## License

MIT
