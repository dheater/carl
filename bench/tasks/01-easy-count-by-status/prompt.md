Add a `countByStatus` function to `src/filter.ts`.

It takes a `Todo[]` and returns `{ open: number; done: number }` — how many todos
are not yet done, and how many are. An empty list gives `{ open: 0, done: 0 }`.

Export it, keep the existing tests passing, and add a test for it in
`src/filter.test.ts`.
