`formatList` in `src/format.ts` numbers the list starting at 0, so the first todo
shows as `0.`. Humans count from 1. Fix it, and cover the numbering in
`src/format.test.ts` so it does not regress.
