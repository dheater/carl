import {
  apply,
  readWindowFrom,
  spliceBody,
  name,
  type PluginContext,
  type ReadLedgerConfig,
} from "./read-ledger-plugin";

type PostExecuteListener = Parameters<PluginContext["on"]>[1];
type Decision = {
  kind: string;
  content?: unknown;
  additionalContexts?: unknown;
};

/**
 * A fake cordis context that captures the listeners `apply` registers, plus the
 * two things a harness would do with them: dispatch a settled `read` outcome
 * through the post-execute waterfall, and announce a session event.
 */
class FakeContext {
  postExecute?: (
    exec: unknown,
    result: unknown,
    next: () => Promise<Decision>,
  ) => Promise<Decision>;
  sessionEvent?: (session: object, event: { type: string }) => void;
  teardownLabel?: string;

  on(event: string, listener: PostExecuteListener): void {
    if (event === "tools/post-execute") this.postExecute = listener as never;
    if (event === "session/event") this.sessionEvent = listener as never;
  }

  effect(setup: () => () => void, label: string): void {
    this.teardownLabel = label;
    setup();
  }
}

const SESSION = { id: "session-1" };

/** The `read` tool's canonical value for `count` lines of `path`. */
function value(
  path: string,
  offset: number,
  count: number,
  totalLines: number,
  text: (n: number) => string = (n) => `line ${n}`,
) {
  const lines = [];
  for (let n = offset; n < offset + count; n += 1) {
    lines.push({ number: n, text: text(n) });
  }
  return { path, offset, lines, totalLines };
}

/** The `read` tool's rendered envelope for that value. */
function content(read: ReturnType<typeof value>) {
  const body = read.lines
    .map((line) => `${line.number}: ${line.text}`)
    .join("\n");
  const footer = `(End of file - total ${read.totalLines} lines)`;
  return [
    {
      type: "text",
      text: `<path>${read.path}</path>\n<type>file</type>\n<content>\n${body}\n\n${footer}\n</content>`,
    },
  ];
}

function install(config?: ReadLedgerConfig): FakeContext {
  const ctx = new FakeContext();
  apply(ctx as unknown as PluginContext, config);
  return ctx;
}

/** Push one accepted `read` success through the registered waterfall. */
async function dispatchRead(
  ctx: FakeContext,
  read: ReturnType<typeof value>,
  exec: Record<string, unknown> = {},
): Promise<Decision> {
  const listener = ctx.postExecute;
  if (listener === undefined) throw new Error("no post-execute listener");
  return listener(
    { name: "read", agent: { session: SESSION }, ...exec },
    { isError: false, value: read, content: content(read) },
    async () => ({ kind: "accept" }),
  );
}

function textOf(decision: Decision): string {
  const blocks = decision.content as
    | { type: string; text: string }[]
    | undefined;
  if (blocks === undefined) throw new Error("decision replaced no content");
  return blocks[0].text;
}

describe("read ledger plugin", () => {
  test("names itself for loader diagnostics", () => {
    expect(name).toBe("carl-read-ledger");
  });

  test("passes a first read through untouched", async () => {
    const ctx = install();
    const decision = await dispatchRead(ctx, value("src/a.ts", 1, 40, 40));
    expect(decision).toEqual({ kind: "accept" });
  });

  test("rewrites only the numbered lines of a repeat, keeping the envelope", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);
    const text = textOf(await dispatchRead(ctx, read));

    expect(text).toContain("<path>src/a.ts</path>");
    expect(text).toContain("<type>file</type>");
    expect(text).toContain("(End of file - total 40 lines)");
    expect(text).toContain("[read ledger] lines 1-40 unchanged");
    expect(text).not.toContain("1: line 1");
    expect(text.length).toBeLessThan(
      textOf({ kind: "accept", content: content(read) }).length,
    );
  });

  test("leaves the canonical value alone so a program still gets every line", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);
    const decision = await dispatchRead(ctx, read);

    expect(Object.hasOwn(decision, "value")).toBe(false);
  });

  test("ignores a Code Mode sub-dispatch, whose result the model never sees", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read, { parent: Symbol("outer-run_code") });
    // The sub-dispatch was not recorded, so this direct read is still a first one.
    expect(await dispatchRead(ctx, read)).toEqual({ kind: "accept" });
  });

  test("ignores tools other than read", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read, { name: "grep" });
    expect(await dispatchRead(ctx, read, { name: "grep" })).toEqual({
      kind: "accept",
    });
  });

  test("ignores a call with no session to key on", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read, { agent: undefined });
    expect(await dispatchRead(ctx, read, { agent: undefined })).toEqual({
      kind: "accept",
    });
  });

  test("defers to a listener that already replaced the content", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);

    const listener = ctx.postExecute;
    if (listener === undefined) throw new Error("no post-execute listener");
    const replaced = {
      kind: "accept",
      content: [{ type: "text", text: "spilled" }],
    };
    const decision = await listener(
      { name: "read", agent: { session: SESSION } },
      { isError: false, value: read, content: content(read) },
      async () => replaced,
    );
    expect(decision).toBe(replaced);
  });

  test("carries additional contexts through a rewrite", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);

    const listener = ctx.postExecute;
    if (listener === undefined) throw new Error("no post-execute listener");
    const contexts = [{ role: "user" }];
    const decision = await listener(
      { name: "read", agent: { session: SESSION } },
      { isError: false, value: read, content: content(read) },
      async () => ({ kind: "accept", additionalContexts: contexts }),
    );
    expect(decision.additionalContexts).toBe(contexts);
    expect(decision.content).toBeDefined();
  });

  test("passes through content it cannot identify", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);

    const listener = ctx.postExecute;
    if (listener === undefined) throw new Error("no post-execute listener");
    const decision = await listener(
      { name: "read", agent: { session: SESSION } },
      {
        isError: false,
        value: read,
        // A future upstream format the exact-match splice cannot find.
        content: [{ type: "text", text: "reformatted upstream" }],
      },
      async () => ({ kind: "accept" }),
    );
    expect(decision).toEqual({ kind: "accept" });
  });

  test("stops eliding once compaction has evicted the earlier copy", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);

    ctx.sessionEvent?.(SESSION, { type: "compaction/start" });

    expect(await dispatchRead(ctx, read)).toEqual({ kind: "accept" });
  });

  test("keeps eliding across unrelated session events", async () => {
    const ctx = install();
    const read = value("src/a.ts", 1, 40, 40);
    await dispatchRead(ctx, read);

    ctx.sessionEvent?.(SESSION, { type: "tool/result" });

    expect(textOf(await dispatchRead(ctx, read))).toContain("[read ledger]");
  });

  test("registers nothing when disabled", () => {
    const ctx = install({ enabled: false });
    expect(ctx.postExecute).toBeUndefined();
    expect(ctx.sessionEvent).toBeUndefined();
  });

  test("honors a configured threshold", async () => {
    const ctx = install({ minElidedLines: 2 });
    const read = value(
      "src/a.ts",
      1,
      3,
      3,
      (n) => `line ${n} ${"padding ".repeat(10)}`,
    );
    await dispatchRead(ctx, read);
    expect(textOf(await dispatchRead(ctx, read))).toContain("[read ledger]");
  });
});

describe("readWindowFrom", () => {
  test("accepts the read tool's value", () => {
    expect(readWindowFrom(value("src/a.ts", 1, 2, 2))).toEqual({
      path: "src/a.ts",
      offset: 1,
      totalLines: 2,
      lines: [
        { number: 1, text: "line 1" },
        { number: 2, text: "line 2" },
      ],
    });
  });

  test.each([
    ["a non-object", 42],
    ["a missing path", { offset: 1, lines: [], totalLines: 0 }],
    ["an empty path", { path: "", offset: 1, lines: [], totalLines: 0 }],
    ["a zero offset", { path: "a", offset: 0, lines: [], totalLines: 0 }],
    [
      "a fractional total",
      { path: "a", offset: 1, lines: [], totalLines: 1.5 },
    ],
    [
      "lines that are not an array",
      { path: "a", offset: 1, lines: 3, totalLines: 0 },
    ],
    [
      "a line with no text",
      { path: "a", offset: 1, lines: [{ number: 1 }], totalLines: 1 },
    ],
    [
      "a line with no number",
      { path: "a", offset: 1, lines: [{ text: "x" }], totalLines: 1 },
    ],
  ])("declines %s", (_label, candidate) => {
    expect(readWindowFrom(candidate)).toBeUndefined();
  });
});

describe("spliceBody", () => {
  test("replaces the body literally, without regex expansion", () => {
    expect(spliceBody("a<BODY>b", "<BODY>", "$& $1 $$")).toBe("a$& $1 $$b");
  });

  test("declines when the body is absent", () => {
    expect(spliceBody("abc", "xyz", "!")).toBeUndefined();
  });
});
