import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoStore } from "./store";

// Reported by a caller who had been silently completing todos that were already
// gone and only noticed weeks later. Currently red.
test("complete rejects an id the store does not hold", () => {
  const store = new TodoStore();
  store.add("a real one");

  assert.throws(() => store.complete("does-not-exist"), {
    message: "no such todo: does-not-exist",
  });
});

test("complete still marks a real todo done", () => {
  const store = new TodoStore();
  const todo = store.add("a real one");
  store.complete(todo.id);

  assert.equal(store.get(todo.id)?.done, true);
});
