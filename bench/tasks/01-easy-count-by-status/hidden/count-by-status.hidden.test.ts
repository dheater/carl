import { test } from "node:test";
import assert from "node:assert/strict";

import { countByStatus } from "./filter";
import { TodoStore } from "./store";

test("countByStatus counts an empty list as zero of each", () => {
  assert.deepEqual(countByStatus([]), { open: 0, done: 0 });
});

test("countByStatus splits open from done", () => {
  const store = new TodoStore();
  store.add("a");
  const second = store.add("b");
  const third = store.add("c");
  store.complete(second.id);
  store.complete(third.id);

  assert.deepEqual(countByStatus(store.list()), { open: 1, done: 2 });
});

test("countByStatus counts an all-open list", () => {
  const store = new TodoStore();
  store.add("a");
  store.add("b");

  assert.deepEqual(countByStatus(store.list()), { open: 2, done: 0 });
});
