import { test } from "node:test";
import assert from "node:assert/strict";

import { sortTodos } from "./filter";
import { Todo } from "./types";

function todo(over: Partial<Todo> & { id: string }): Todo {
  return {
    title: "t",
    done: false,
    priority: "normal",
    createdAt: 0,
    ...over,
  } as Todo;
}

test("priority still dominates every other key", () => {
  const rows = [
    todo({ id: "1", priority: "low", createdAt: 0, title: "a" }),
    todo({ id: "2", priority: "high", createdAt: 99, title: "z" }),
    todo({ id: "3", priority: "normal", createdAt: 50, title: "m" }),
  ];

  assert.deepEqual(
    sortTodos(rows).map((row) => row.priority),
    ["high", "normal", "low"],
  );
});

test("createdAt breaks a priority tie, ascending", () => {
  const rows = [
    todo({ id: "1", createdAt: 300 }),
    todo({ id: "2", createdAt: 100 }),
    todo({ id: "3", createdAt: 200 }),
  ];

  assert.deepEqual(
    sortTodos(rows).map((row) => row.createdAt),
    [100, 200, 300],
  );
});

test("title breaks a createdAt tie", () => {
  const rows = [
    todo({ id: "1", createdAt: 5, title: "cherry" }),
    todo({ id: "2", createdAt: 5, title: "apple" }),
    todo({ id: "3", createdAt: 5, title: "banana" }),
  ];

  assert.deepEqual(
    sortTodos(rows).map((row) => row.title),
    ["apple", "banana", "cherry"],
  );
});

test("id breaks a title tie", () => {
  const rows = [
    todo({ id: "3", createdAt: 5, title: "same" }),
    todo({ id: "1", createdAt: 5, title: "same" }),
    todo({ id: "2", createdAt: 5, title: "same" }),
  ];

  assert.deepEqual(
    sortTodos(rows).map((row) => row.id),
    ["1", "2", "3"],
  );
});

test("the order does not depend on the order it was handed", () => {
  const rows = [
    todo({ id: "1", createdAt: 5, title: "same" }),
    todo({ id: "2", createdAt: 5, title: "same" }),
    todo({ id: "3", createdAt: 5, title: "same" }),
  ];
  const forwards = sortTodos(rows).map((row) => row.id);
  const backwards = sortTodos([...rows].reverse()).map((row) => row.id);

  assert.deepEqual(forwards, backwards);
});

test("sortTodos leaves its input alone", () => {
  const rows = [
    todo({ id: "1", priority: "low" }),
    todo({ id: "2", priority: "high" }),
  ];
  sortTodos(rows);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["1", "2"],
  );
});
