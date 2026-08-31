import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoStore } from "./store";

test("add returns the stored todo", () => {
  const store = new TodoStore();
  const todo = store.add("write the thing", "high", 100);

  assert.equal(todo.title, "write the thing");
  assert.equal(todo.priority, "high");
  assert.equal(todo.createdAt, 100);
  assert.equal(todo.done, false);
  assert.deepEqual(store.get(todo.id), todo);
});

test("add defaults priority to normal", () => {
  const store = new TodoStore();
  assert.equal(store.add("no priority given").priority, "normal");
});

test("ids are distinct and list preserves insertion order", () => {
  const store = new TodoStore();
  const first = store.add("first");
  const second = store.add("second");

  assert.notEqual(first.id, second.id);
  assert.deepEqual(
    store.list().map((todo) => todo.title),
    ["first", "second"],
  );
});

test("complete marks a known todo done", () => {
  const store = new TodoStore();
  const todo = store.add("finish it");
  store.complete(todo.id);

  assert.equal(store.get(todo.id)?.done, true);
});

test("remove drops a todo", () => {
  const store = new TodoStore();
  const todo = store.add("temporary");
  store.remove(todo.id);

  assert.equal(store.get(todo.id), undefined);
  assert.deepEqual(store.list(), []);
});

test("get answers undefined for an unknown id", () => {
  assert.equal(new TodoStore().get("nope"), undefined);
});
