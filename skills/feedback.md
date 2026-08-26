---
type: agent_requested
name: Feedback
description: Assess review feedback, apply what survives, and report how each comment was disposed of.
when_to_use: invoked by `carl feedback` to work through PR review or `carl review` comments
version: 1.1.0
---

# Feedback

Work through the review comments in the request. Each one is a claim to check, not an instruction to obey.

IMPORTANT: a comment can be wrong. Reviewers — human and machine — misread code, cite rules that do not say what they think they say, and describe code that no longer exists. Rejecting a wrong comment with evidence is a good outcome. Applying a wrong comment is a defect you introduced.

## Per comment, in order

1. Read the code it points at. If the cited line, function, or file is gone, the comment is stale.
2. Judge the claim against the code, not the reviewer's confidence. Check any cited language rule, API contract, or "this is always true" assertion.
3. Prove behavioral claims before acting on them. Run the test, the build, or the command — "crashes on empty input" is checkable.
4. Then act. Apply nothing you could not confirm was needed. Change nothing the comment did not raise.

If the change only compiles behind a cast, an `any`, or a suppressed check, it is not **Applied** — either find the fix that does not need one, or say what you loosened and why.

Feedback can predate the code: `git log` and `git diff` show what moved.

Ignore everything that is not a comment about the code — summaries, proposed commit messages, cost footers, labels, resolved-conversation markers.

## Verdicts

Exactly one per comment:

- **Applied** — you made the change.
- **Applied differently** — real problem, different fix. Say why yours is better.
- **Already handled** — the code already does this. Cite `path:line`.
- **Stale** — the code it describes is gone or changed. Say what replaced it.
- **Rejected** — the claim is wrong. Give the evidence that settles it.
- **Deferred** — real, but outside this change. Say where it belongs.
- **Needs your call** — the answer depends on something only the human knows. Ask one question.

## Output

One block per comment, in the reviewer's order, each one pasteable into its own review thread. At most one lead line before the first block.

```
## <n>. <path:line, or the reviewer's own heading> — <verdict>

<One to three sentences: what you checked, what you found, what you changed. Name files and functions.>
```

End with `## Summary`: the verdict counts on one line, adding up to the number of comments; the files you changed; and the check you ran with what it said. If a check will not run here, say so in one clause and give the result of what you ran instead.

Write every block for the reviewer, who cannot see this session: no carl jargon, no "the session", no praise, no restating their comment back at them. Plain language they can act on.
