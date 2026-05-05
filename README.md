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
carl plan          # Open editor; run architect (writes decisions.md and tickets)
carl write-tests   # Run test-writer against open test-tickets
carl code          # Run developer against open dev-tickets
carl review        # Run reviewer (cleanup + verification)
carl reset         # Clear .agent/
```

Phase artifacts live in `.agent/` (gitignored). Diagnostics in `.carl/events.jsonl`. Use `ls .agent/` to see what's in flight.

## Workflow

```
plan → write-tests → code → review
```

Each command runs once and exits. There is no automatic kick-back between phases — the human invokes the next command.

- **plan** — Architect challenges scope, asks clarifying questions, writes `.agent/decisions.md` and the ticket lists. Always opens an empty editor buffer; user types either a fresh goal or notes refining the existing plan.
- **write-tests** — TestWriter writes durable regression tests against open `.agent/test-tickets.md`.
- **code** — Developer implements `.agent/dev-tickets.md` via TDD. Run your own `just format` / `just lint` / `just test` afterward.
- **review** — Reviewer performs subtract-first cleanup and verification on the live git diff; refuses to run while tickets are still open.

Cross-phase coordination via files:
- **`.agent/decisions.md`** — Architect's plan and decisions (read by all downstream phases)
- **`.agent/dev-tickets.md` / `.agent/test-tickets.md`** — Ticket lists
- **`.carl/events.jsonl`** — Per-prompt timing and char counts

## License

MIT
