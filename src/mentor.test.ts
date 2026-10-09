import { Inbox } from "./mentor";

function content(result: IteratorResult<{ message: { content: string } }>) {
  return result.done ? "(done)" : result.value.message.content;
}

describe("Inbox", () => {
  test("a message pushed before anyone reads it waits in the queue", async () => {
    const inbox = new Inbox();
    inbox.push("first");
    inbox.push("second");
    const it = inbox[Symbol.asyncIterator]();
    expect(content(await it.next())).toBe("first");
    expect(content(await it.next())).toBe("second");
  });

  test("a reader waiting on an empty inbox gets the next push", async () => {
    const inbox = new Inbox();
    const it = inbox[Symbol.asyncIterator]();
    const pending = it.next();
    inbox.push("hello");
    const result = await pending;
    expect(result.done).toBe(false);
    expect(content(result)).toBe("hello");
  });

  test("close ends a waiting reader", async () => {
    const inbox = new Inbox();
    const it = inbox[Symbol.asyncIterator]();
    const pending = it.next();
    inbox.close();
    expect((await pending).done).toBe(true);
  });

  test("close still delivers what was queued, then ends", async () => {
    const inbox = new Inbox();
    inbox.push("last");
    inbox.close();
    const it = inbox[Symbol.asyncIterator]();
    expect(content(await it.next())).toBe("last");
    expect((await it.next()).done).toBe(true);
  });
});
