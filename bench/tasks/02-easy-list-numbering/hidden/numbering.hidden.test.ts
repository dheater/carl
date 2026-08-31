import { test } from "node:test";
import assert from "node:assert/strict";

import { formatList } from "./format";
import { TodoStore } from "./store";

test("formatList numbers the first todo 1", () => {
  const store = new TodoStore();
  store.add("first");

  assert.match(formatList(store.list()), /^1\. \[ \] first$/);
});

test("formatList numbers consecutively from 1", () => {
  const store = new TodoStore();
  store.add("a");
  store.add("b");
  store.add("c");

  assert.deepEqual(
    formatList(store.list())
      .split("\n")
      .map((line) => line.split(".")[0]),
    ["1", "2", "3"],
  );
});

test("formatList keeps the checkbox alongside the new numbering", () => {
  const store = new TodoStore();
  store.add("open one");
  const done = store.add("closed one");
  store.complete(done.id);

  assert.match(formatList(store.list()).split("\n")[1], /^2\. \[x\] closed one$/);
});
