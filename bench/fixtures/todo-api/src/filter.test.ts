import { test } from "node:test";
import assert from "node:assert/strict";

import { byPriority, openTodos, sortTodos } from "./filter";
import { TodoStore } from "./store";
import { Todo } from "./types";

function seeded(): { store: TodoStore; todos: Todo[] } {
  const store = new TodoStore();
  const todos = [
    store.add("low one", "low", 1),
    store.add("high one", "high", 2),
    store.add("normal one", "normal", 3),
  ];
  return { store, todos };
}

test("openTodos drops the completed ones", () => {
  const { store, todos } = seeded();
  store.complete(todos[1].id);

  assert.deepEqual(
    openTodos(store.list()).map((todo) => todo.title),
    ["low one", "normal one"],
  );
});

test("byPriority selects one band", () => {
  const { store } = seeded();

  assert.deepEqual(
    byPriority(store.list(), "high").map((todo) => todo.title),
    ["high one"],
  );
  assert.deepEqual(byPriority(store.list(), "low").length, 1);
});

test("sortTodos puts high priority first and low last", () => {
  const { store } = seeded();

  assert.deepEqual(
    sortTodos(store.list()).map((todo) => todo.priority),
    ["high", "normal", "low"],
  );
});

test("sortTodos does not modify its input", () => {
  const { store } = seeded();
  const original = store.list();
  const before = original.map((todo) => todo.id);
  sortTodos(original);

  assert.deepEqual(
    original.map((todo) => todo.id),
    before,
  );
});
