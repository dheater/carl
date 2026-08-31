import { Todo } from "./types";

/** One numbered line per todo, for showing a list to a human. */
export function formatList(todos: Todo[]): string {
  return todos
    .map((todo, index) => `${index}. [${todo.done ? "x" : " "}] ${todo.title}`)
    .join("\n");
}
