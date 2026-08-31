import { Priority, Todo } from "./types";

/** An in-memory collection of todos, keyed by a sequential id. */
export class TodoStore {
  private todos = new Map<string, Todo>();
  private nextId = 1;

  add(title: string, priority: Priority = "normal", createdAt = 0): Todo {
    const todo: Todo = {
      id: String(this.nextId++),
      title,
      done: false,
      priority,
      createdAt,
    };
    this.todos.set(todo.id, todo);
    return todo;
  }

  get(id: string): Todo | undefined {
    return this.todos.get(id);
  }

  /** Insertion order, which is also id order. */
  list(): Todo[] {
    return [...this.todos.values()];
  }

  complete(id: string): void {
    const todo = this.todos.get(id);
    if (todo) todo.done = true;
  }

  remove(id: string): void {
    this.todos.delete(id);
  }
}
