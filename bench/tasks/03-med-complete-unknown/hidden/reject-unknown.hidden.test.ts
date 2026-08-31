import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoStore } from "./store";

test("remove rejects an id the store does not hold", () => {
  const store = new TodoStore();
  store.add("a real one");

  assert.throws(() => store.remove("ghost"), {
    message: "no such todo: ghost",
  });
});

test("a rejected complete leaves the store untouched", () => {
  const store = new TodoStore();
  const todo = store.add("a real one");

  assert.throws(() => store.complete("ghost"));
  assert.equal(store.get(todo.id)?.done, false);
  assert.equal(store.list().length, 1);
});

test("a removed id is rejected the second time", () => {
  const store = new TodoStore();
  const todo = store.add("temporary");
  store.remove(todo.id);

  assert.throws(() => store.remove(todo.id), {
    message: `no such todo: ${todo.id}`,
  });
});
