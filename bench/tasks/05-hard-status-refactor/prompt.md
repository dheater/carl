`Todo.done` is a boolean, and we are about to need a third state ("blocked").
Before that lands, widen the representation.

Replace `done: boolean` with `status: TodoStatus`, where
`export type TodoStatus = "open" | "done"` lives in `src/types.ts`. A new todo
starts `"open"`, and `complete` sets it to `"done"`.

Update every call site — `src/store.ts`, `src/filter.ts`, `src/format.ts` — and
the existing tests along with them. Nothing should reference `.done` when you are
finished, and the suite must be green. Do not add the `"blocked"` state; this
change is only about the representation.
