import { Priority, Todo } from "./types";

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export function openTodos(todos: Todo[]): Todo[] {
  return todos.filter((todo) => !todo.done);
}

export function byPriority(todos: Todo[], priority: Priority): Todo[] {
  return todos.filter((todo) => todo.priority === priority);
}

/** Highest priority first. Does not modify the input. */
export function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => RANK[a.priority] - RANK[b.priority]);
}
