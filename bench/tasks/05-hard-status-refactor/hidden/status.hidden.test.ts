import { test } from "node:test";
import assert from "node:assert/strict";

import { openTodos } from "./filter";
import { formatList } from "./format";
import { TodoStore } from "./store";
import { TodoStatus } from "./types";

test("a new todo starts open and completing it sets done", () => {
  const store = new TodoStore();
  const todo = store.add("a thing");

  assert.equal(todo.status, "open");
  store.complete(todo.id);
  assert.equal(store.get(todo.id)?.status, "done");
});

test("the status type admits exactly the two states", () => {
  const open: TodoStatus = "open";
  const done: TodoStatus = "done";

  assert.deepEqual([open, done], ["open", "done"]);
});

test("openTodos reads the new field", () => {
  const store = new TodoStore();
  store.add("still going");
  const finished = store.add("finished");
  store.complete(finished.id);

  assert.deepEqual(
    openTodos(store.list()).map((todo) => todo.title),
    ["still going"],
  );
});

test("formatList still renders a checkbox from the new field", () => {
  const store = new TodoStore();
  store.add("open one");
  const done = store.add("closed one");
  store.complete(done.id);

  const lines = formatList(store.list()).split("\n");
  assert.match(lines[0], /\[ \] open one$/);
  assert.match(lines[1], /\[x\] closed one$/);
});
