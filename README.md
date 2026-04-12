# Carl

Opinionated AI development workflow. Named personas for each phase of work. Rules that load into your AI assistant. A linter for the principles that matter.

---

## Install

```bash
git clone https://github.com/carl-lang/carl.git
cd carl
just install
```

Builds the `carl` binary, copies rules to `~/.augment/rules/`, and installs persona scripts to `~/.local/bin/`.

---

## Personas

Carl ships four named agents. Each has a defined role, a scope it won't leave, and a skill file that tells the AI how to behave.

### Dani — planner

Challenges scope before writing any tickets. Default answer is no. Slices work into thin vertical tickets that Grey can commit one at a time.

```bash
dani        # Start a planning session
dani-grill  # Stress-test a design decision before planning
dani-prd    # Write a PRD from a clarified problem
```

### Grey — executor

Implements one ticket at a time using TDD. Reads `.agent/tickets.md`, picks the first unchecked ticket, writes a failing test, makes it pass, stops.

```bash
grey         # Execute the next ticket
grey-qa      # Run verification checks before sign-off
grey-commit  # Draft a commit message for approval
```

### Lewis — reviewer

Sprint-end. Generates a behavioral QA plan from completed tickets, stress-tests the diff, handles housekeeping when the human signs off.

```bash
lewis       # Sprint-end review
lewis-pr    # Draft PR for approval
lewis-jira  # Draft Jira updates for approval
```

### Vera — challenger

Simulates a panel of domain experts to stress-test an idea. Produces a verdict (kill / proceed / investigate) and saves findings to `.agent/notes/vera-<topic>.md`.

```bash
vera            # Run a focus group on an idea
vera-prototype  # Build a minimal throw-away version to validate a direction
```

---

## Workflow

```
vera          → validate the idea before investing
dani          → challenge scope, slice into tickets → .agent/tickets.md
grey          → implement tickets one at a time (TDD)
grey-commit   → draft commit message, wait for approval
lewis         → QA plan, diff review, housekeeping
lewis-pr      → draft PR, wait for approval
```

Discovery during execution is expected. When Grey hits a blocker, Dani inserts prerequisite tickets and Grey resumes.

---

## Automated Checks

The `carl` binary enforces principles mechanically:

```bash
carl check_deps      # Dependency budget (≤5 runtime deps)
carl check_abi       # ABI stability
carl check_commits   # Conventional commits
carl check_exports   # Symbol visibility
carl check_comments  # Narration detection
carl check_docs      # Unsolicited .md files
carl check_logs      # Structured logging format
carl check_all       # Run all checks
```

Output is JSON. Exit code is always 0 — advisory, not blocking.

---

## Rules

Rules are loaded into `~/.augment/rules/` and apply to every AI session automatically. They cover: subtract-first, API stability, dependency budget, error messages, logging, comments, documentation, testing, git policy, and more.

Skills are loaded alongside rules and tell the AI how to execute each persona.

```bash
just sync-augment   # Re-sync rules and skills after pulling
```

---

## License

MIT
