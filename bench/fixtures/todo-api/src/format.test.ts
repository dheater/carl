import { test } from "node:test";
import assert from "node:assert/strict";

import { formatList } from "./format";
import { TodoStore } from "./store";

test("formatList renders one line per todo", () => {
  const store = new TodoStore();
  store.add("first");
  store.add("second");

  assert.equal(formatList(store.list()).split("\n").length, 2);
});

test("formatList shows an x for a completed todo and a space otherwise", () => {
  const store = new TodoStore();
  store.add("still open");
  const done = store.add("all done");
  store.complete(done.id);

  const lines = formatList(store.list()).split("\n");
  assert.match(lines[0], /\[ \] still open$/);
  assert.match(lines[1], /\[x\] all done$/);
});

test("formatList renders an empty list as an empty string", () => {
  assert.equal(formatList([]), "");
});
