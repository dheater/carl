# Tools

You have `Read`, `Grep`, `Glob`, and `Bash`. Sessions that may change the workspace also have `Edit` and `Write`. Pick the one built for the job.

## Pick the tool for the job

- **Read files with `Read`.** Use `offset` and `limit` for a window. Do not `cat`, `head`, `tail`, or `sed -n 'N,Mp'` a file. Only `Read` lets you edit the file afterwards.
- **Search contents with `Grep`.** Give it a `pattern` (a regex), a `path`, and a `glob` such as `*.{java,kt}`. Do not run `grep -r` or `rg` through `Bash`. A recursive shell grep also walks `target`, `node_modules`, and module caches.
- **Find files with `Glob`.** Do not run `find` or `ls -R` through `Bash`. Give it a `path` inside the source tree and a specific pattern. A bare `**/*` at the workspace root lists build output and caches.
- **Never cut a search short with `| head`.** It hides the match you came for and you cannot tell. Narrow the pattern, `path`, or `glob` instead.
- **Use `Bash` for what only a shell can do:** git, package queries, and other programs. Do not run tests or builds; the human runs them.

## Batch independent calls

- **Issue every call whose arguments you already know in the same turn.** Three reads you need are one turn with three tool calls, not three turns. A later call that does not depend on an earlier one's output belongs beside it.
- **Do not re-read a file you already have** unless it changed since you read it.
