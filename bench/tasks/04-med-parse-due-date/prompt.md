Todos need due dates.

Add `src/due.ts` exporting `parseDueDate(input: string): number` — it takes a
calendar date and returns the epoch milliseconds of that date at UTC midnight.

Be strict about the format. Accept exactly `YYYY-MM-DD` and nothing else: reject
`2026-1-1`, `01/15/2026`, `2026-13-01`, `2026-02-30`, the empty string, and
anything with trailing text. Throw a `RangeError` whose message names the input
that was rejected.

Then give `Todo` an optional `dueDate?: number` field and let `TodoStore.add`
take an optional `due` string as its fourth argument, parsed through
`parseDueDate`. Omitting it leaves `dueDate` undefined.

Add tests, and keep the existing suite green.
