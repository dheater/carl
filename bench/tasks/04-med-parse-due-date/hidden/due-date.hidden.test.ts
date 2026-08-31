import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDueDate } from "./due";
import { TodoStore } from "./store";

test("parseDueDate returns UTC midnight of the named day", () => {
  assert.equal(parseDueDate("2026-01-15"), Date.UTC(2026, 0, 15));
  assert.equal(parseDueDate("2026-12-31"), Date.UTC(2026, 11, 31));
  assert.equal(parseDueDate("2024-02-29"), Date.UTC(2024, 1, 29));
});

test("parseDueDate rejects a loose format", () => {
  for (const input of ["2026-1-1", "01/15/2026", "20260115", "2026-01-15T00:00:00Z", "2026-01-15 "]) {
    assert.throws(() => parseDueDate(input), RangeError, `should reject ${JSON.stringify(input)}`);
  }
});

test("parseDueDate rejects a date that is not on the calendar", () => {
  for (const input of ["2026-13-01", "2026-00-10", "2026-02-30", "2026-04-31", "2025-02-29"]) {
    assert.throws(() => parseDueDate(input), RangeError, `should reject ${JSON.stringify(input)}`);
  }
});

test("parseDueDate rejects an empty string", () => {
  assert.throws(() => parseDueDate(""), RangeError);
});

test("the rejection message names the offending input", () => {
  assert.throws(() => parseDueDate("nonsense"), (error: unknown) => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /nonsense/);
    return true;
  });
});

test("add stores a parsed due date and leaves it undefined when omitted", () => {
  const store = new TodoStore();
  const withDue = store.add("has a deadline", "high", 0, "2026-03-04");
  const without = store.add("no deadline");

  assert.equal(withDue.dueDate, Date.UTC(2026, 2, 4));
  assert.equal(without.dueDate, undefined);
});

test("add propagates the rejection rather than storing a bad date", () => {
  const store = new TodoStore();

  assert.throws(() => store.add("bad deadline", "normal", 0, "2026-02-30"), RangeError);
});
