export type Priority = "low" | "normal" | "high";

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  /** Epoch milliseconds. Supplied by the caller so tests are not tied to a clock. */
  createdAt: number;
}
