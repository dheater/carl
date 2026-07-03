import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  isBlockedBashCommand,
  BLOCKED_COMMAND_ERROR,
  BedrockRunner,
} from "./runner";

// ── isBlockedBashCommand ──────────────────────────────────────────────────────

describe("isBlockedBashCommand", () => {
  test.each([
    "find . -type f",
    "find ./ -type f",
    "find . -maxdepth 2 -type f",
    "ls -R",
    "ls -lR",
    "ls -R .",
    "echo 1 && find . -type f",
    "cat foo; find ./ -type f",
  ])("blocks: %s", (cmd) => {
    expect(isBlockedBashCommand(cmd)).toBe(true);
  });

  test.each([
    "find . -type f -name '*.ts'",
    "find . -type f -path '*/src/*'",
    "find . -name '*.md'",
    "ls -la",
    "grep -r foo .",
    "cat package.json",
    "find . -type f | head -50",
  ])("allows: %s", (cmd) => {
    expect(isBlockedBashCommand(cmd)).toBe(false);
  });
});

// ── BedrockRunner.executeTool (via run with mock client) ──────────────────────

// We test executeTool by reaching into the private method via a subclass.
class TestableBedrockRunner extends BedrockRunner {
  exec(toolName: string, toolInput: any, workspaceRoot: string): string {
    return (this as any).executeTool(
      toolName,
      toolInput,
      workspaceRoot,
      "code",
      "sonnet4",
    );
  }
}

describe("BedrockRunner.executeTool", () => {
  let workspaceRoot: string;
  let runner: TestableBedrockRunner;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-runner-"));
    runner = new TestableBedrockRunner("us-east-1");
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("bash blocks unfiltered find", () => {
    const result = runner.exec(
      "bash",
      { command: "find . -type f" },
      workspaceRoot,
    );
    expect(result).toBe(BLOCKED_COMMAND_ERROR);
  });

  test("bash allows filtered find", () => {
    fs.writeFileSync(path.join(workspaceRoot, "hello.ts"), "export {};");
    const result = runner.exec(
      "bash",
      { command: "find . -type f -name '*.ts'" },
      workspaceRoot,
    );
    expect(result).toContain("hello.ts");
  });

  test("write_file creates a new file with content", () => {
    const result = runner.exec(
      "write_file",
      { path: "new.ts", content: "export const x = 1;" },
      workspaceRoot,
    );
    expect(result).toContain("new.ts");
    expect(fs.readFileSync(path.join(workspaceRoot, "new.ts"), "utf-8")).toBe(
      "export const x = 1;",
    );
  });

  test("write_file creates parent directories", () => {
    const result = runner.exec(
      "write_file",
      { path: "deep/nested/file.ts", content: "hi" },
      workspaceRoot,
    );
    expect(result).toContain("deep/nested/file.ts");
    expect(
      fs.readFileSync(path.join(workspaceRoot, "deep/nested/file.ts"), "utf-8"),
    ).toBe("hi");
  });

  test("write_file rejects path outside workspace", () => {
    const result = runner.exec(
      "write_file",
      { path: "../../../etc/evil", content: "bad" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
    expect(fs.existsSync("/etc/evil")).toBe(false);
  });

  test("str_replace replaces exact text in a file", () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "code.ts"),
      "const x = 1;\nconst y = 2;\n",
    );
    const result = runner.exec(
      "str_replace",
      { path: "code.ts", old_str: "const x = 1;", new_str: "const x = 42;" },
      workspaceRoot,
    );
    expect(result).toContain("code.ts");
    expect(fs.readFileSync(path.join(workspaceRoot, "code.ts"), "utf-8")).toBe(
      "const x = 42;\nconst y = 2;\n",
    );
  });

  test("str_replace returns error when old_str not found", () => {
    fs.writeFileSync(path.join(workspaceRoot, "code.ts"), "hello");
    const result = runner.exec(
      "str_replace",
      { path: "code.ts", old_str: "missing text", new_str: "replacement" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("str_replace returns error when file does not exist", () => {
    const result = runner.exec(
      "str_replace",
      { path: "ghost.ts", old_str: "x", new_str: "y" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("str_replace rejects path outside workspace", () => {
    const result = runner.exec(
      "str_replace",
      { path: "../../../etc/passwd", old_str: "root", new_str: "evil" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("create_directory creates a new directory", () => {
    const result = runner.exec(
      "create_directory",
      { path: "src/new-dir" },
      workspaceRoot,
    );
    expect(result).toContain("src/new-dir");
    expect(fs.existsSync(path.join(workspaceRoot, "src/new-dir"))).toBe(true);
  });

  test("create_directory is idempotent on an existing directory", () => {
    fs.mkdirSync(path.join(workspaceRoot, "already"), { recursive: true });
    const result = runner.exec(
      "create_directory",
      { path: "already" },
      workspaceRoot,
    );
    expect(result).toContain("already");
    expect(fs.existsSync(path.join(workspaceRoot, "already"))).toBe(true);
  });

  test("create_directory rejects path outside workspace", () => {
    const result = runner.exec(
      "create_directory",
      { path: "../../../tmp/evil" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("list_files returns files in directory", () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "");
    fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "");
    const result = runner.exec("list_files", {}, workspaceRoot);
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });

  test("list_files filters by pattern", () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "");
    fs.writeFileSync(path.join(workspaceRoot, "b.md"), "");
    const result = runner.exec(
      "list_files",
      { pattern: "*.ts" },
      workspaceRoot,
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.md");
  });

  test("list_files pattern matches on relative path not just basename", () => {
    const sub = path.join(workspaceRoot, "src");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "foo.ts"), "");
    fs.writeFileSync(path.join(workspaceRoot, "root.ts"), "");
    // Pattern that qualifies by directory — should match src/foo.ts only
    const result = runner.exec(
      "list_files",
      { pattern: "src/**/*.ts", recursive: true },
      workspaceRoot,
    );
    expect(result).toContain("src/foo.ts");
    expect(result).not.toContain("root.ts");
  });

  test("list_files recursive finds nested files", () => {
    const sub = path.join(workspaceRoot, "src");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "deep.ts"), "");
    const result = runner.exec(
      "list_files",
      { recursive: true },
      workspaceRoot,
    );
    expect(result).toContain("src/deep.ts");
  });

  test("list_files excludes directories listed in .gitignore", () => {
    const devbox = path.join(workspaceRoot, ".devbox", "nix");
    fs.mkdirSync(devbox, { recursive: true });
    fs.writeFileSync(path.join(devbox, "heavy.json"), "{}");
    fs.writeFileSync(
      path.join(workspaceRoot, ".gitignore"),
      ".devbox/\n.agent/\n",
    );
    fs.writeFileSync(path.join(workspaceRoot, "keep.ts"), "");
    const result = runner.exec(
      "list_files",
      { recursive: true },
      workspaceRoot,
    );
    expect(result).toContain("keep.ts");
    expect(result).not.toContain(".devbox");
    expect(result).not.toContain("heavy.json");
  });

  test("list_files excludes node_modules", () => {
    const nm = path.join(workspaceRoot, "node_modules", "pkg");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "index.js"), "");
    const result = runner.exec(
      "list_files",
      { recursive: true },
      workspaceRoot,
    );
    expect(result).not.toContain("node_modules");
  });

  test("list_files rejects path outside workspace", () => {
    const result = runner.exec(
      "list_files",
      { directory: "../../../etc" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("list_files returns message when no files found", () => {
    const result = runner.exec(
      "list_files",
      { pattern: "*.nope" },
      workspaceRoot,
    );
    expect(result).toBe("No files found.");
  });

  test("list_files truncates output when it exceeds the size limit", () => {
    // Create enough files to exceed LIST_FILES_MAX_BYTES (200KB).
    // Each filename is "file-NNNNN.ts\n" = ~16 chars; need ~12500 files.
    // Use 15000 to be safely over the limit.
    for (let i = 0; i < 15000; i++) {
      fs.writeFileSync(
        path.join(workspaceRoot, `file-${String(i).padStart(5, "0")}.ts`),
        "",
      );
    }
    const result = runner.exec(
      "list_files",
      { recursive: false },
      workspaceRoot,
    );
    expect(result).toContain("[Output truncated");
    expect(result.length).toBeLessThanOrEqual(200 * 1024 + 200); // at most cap + truncation message
  });

  test("read_file returns file contents", () => {
    fs.writeFileSync(path.join(workspaceRoot, "hello.txt"), "world");
    const result = runner.exec(
      "read_file",
      { path: "hello.txt" },
      workspaceRoot,
    );
    expect(result).toBe("world");
  });

  test("read_file truncates oversized output with head+tail elision", () => {
    // Write 60KB where the first 10KB is 'a', the last 10KB is 'b', middle is 'x'.
    const head = "a".repeat(10 * 1024);
    const mid = "x".repeat(40 * 1024);
    const tail = "b".repeat(10 * 1024);
    fs.writeFileSync(path.join(workspaceRoot, "big.txt"), head + mid + tail);
    const result = runner.exec("read_file", { path: "big.txt" }, workspaceRoot);
    expect(result).toContain("bytes omitted");
    // Head bytes kept (first 20% of 50KB = 10KB)
    expect(result.startsWith("a")).toBe(true);
    // Tail bytes kept (last 80% of 50KB = 40KB) — our tail starts with 'b'
    // but tail region also overlaps mid 'x'; just confirm 'b' chars are present
    expect(result.endsWith("b")).toBe(true);
    expect(result.length).toBeLessThan(60 * 1024);
  });

  test("bash truncates oversized output with head+tail elision", () => {
    // Generate 60KB: first 10KB 'a', last 10KB 'b', middle 'x'
    // Use POSIX-portable commands (brace expansion is bash-only; /bin/sh on Linux is dash)
    const cmd = [
      `head -c 10240 /dev/zero | tr '\\0' 'a'`,
      `head -c 40960 /dev/zero | tr '\\0' 'x'`,
      `head -c 10240 /dev/zero | tr '\\0' 'b'`,
    ].join("; ");
    const result = runner.exec("bash", { command: cmd }, workspaceRoot);
    expect(result).toContain("bytes omitted");
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("b")).toBe(true);
    expect(result.length).toBeLessThan(60 * 1024);
  });

  test("read_file returns error for missing file", () => {
    const result = runner.exec(
      "read_file",
      { path: "ghost.txt" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("read_file rejects path traversal outside workspace", () => {
    const result = runner.exec(
      "read_file",
      { path: "../../../etc/passwd" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
    expect(result).not.toContain("root:");
  });

  test("find_symbol returns 'No matches found.' for unknown symbol", () => {
    const result = runner.exec(
      "find_symbol",
      { symbol: "neverExistsAnywhere" },
      workspaceRoot,
    );
    expect(result).toBe("No matches found.");
  });

  test("find_symbol filters by include_pattern", () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "function bar() {}\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "notes.md"),
      "bar is documented here\n",
    );
    const result = runner.exec(
      "find_symbol",
      { symbol: "bar", include_pattern: "*.ts" },
      workspaceRoot,
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("notes.md");
  });

  test("find_symbol restricts search to given path", () => {
    const sub = path.join(workspaceRoot, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "in.ts"), "baz();\n");
    fs.writeFileSync(path.join(workspaceRoot, "out.ts"), "baz();\n");
    const result = runner.exec(
      "find_symbol",
      { symbol: "baz", path: "sub" },
      workspaceRoot,
    );
    expect(result).toContain("sub/in.ts");
    expect(result).not.toContain("out.ts");
  });

  test("find_symbol excludes node_modules", () => {
    const nm = path.join(workspaceRoot, "node_modules", "pkg");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "index.js"), "function qux() {}\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "main.ts"),
      "function qux() {}\n",
    );
    const result = runner.exec("find_symbol", { symbol: "qux" }, workspaceRoot);
    expect(result).toContain("main.ts");
    expect(result).not.toContain("node_modules");
  });

  test("find_symbol rejects path outside workspace", () => {
    const result = runner.exec(
      "find_symbol",
      { symbol: "root", path: "../../../etc" },
      workspaceRoot,
    );
    expect(result).toContain("Error");
  });

  test("find_symbol returns error for missing symbol", () => {
    const result = runner.exec("find_symbol", { symbol: "" }, workspaceRoot);
    expect(result).toContain("Error");
  });

  test("find_symbol treats symbol as fixed string, not regex", () => {
    // A regex metachar like '.*' should match literally, not as a pattern.
    fs.writeFileSync(
      path.join(workspaceRoot, "literal.ts"),
      "const re = /a.*b/;\n",
    );
    const result = runner.exec(
      "find_symbol",
      { symbol: "a.*b" },
      workspaceRoot,
    );
    expect(result).toContain("literal.ts");
  });
});

// ── withTrailingCachePoint (via BedrockRunner.run mock) ───────────────────────
describe("BedrockRunner.run — trailing cachePoint on every ConverseCommand", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-cache-"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("every ConverseCommand has a trailing cachePoint and stored messages never accumulate them", async () => {
    // Captured inputs from each ConverseCommand send() call.
    const capturedMessages: any[][] = [];

    // Two-turn conversation: turn 1 → tool_use (bash), turn 2 → end_turn.
    const mockSend = jest
      .fn()
      // Turn 1: model requests a bash tool call.
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        output: {
          message: {
            content: [
              {
                toolUse: {
                  toolUseId: "tool-1",
                  name: "bash",
                  input: { command: "echo hello" },
                },
              },
            ],
          },
        },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 50,
        },
      })
      // Turn 2: model returns a final answer.
      .mockResolvedValueOnce({
        stopReason: "end_turn",
        output: {
          message: {
            content: [{ text: "done" }],
          },
        },
        usage: {
          inputTokens: 200,
          outputTokens: 10,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 30,
        },
      });

    // Intercept BedrockRuntimeClient.send to capture the ConverseCommand input.
    jest
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockImplementation(async (cmd: any) => {
        capturedMessages.push(cmd.input.messages);
        return mockSend();
      });

    const runner = new BedrockRunner("us-east-1");
    const result = await runner.run({
      workspaceRoot,
      skill: "code",
      model: "sonnet4",
      instruction: "do the thing",
    });

    // Sanity: we got two ConverseCommand calls.
    expect(capturedMessages).toHaveLength(2);

    // ── Assertion 1: every outbound messages array ends with a cachePoint ──
    for (const msgs of capturedMessages) {
      const lastMsg = msgs[msgs.length - 1];
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      expect(lastBlock).toHaveProperty(
        "cachePoint",
        expect.objectContaining({ type: "default" }),
      );
    }

    // ── Assertion 2: no stale cachePoints accumulate across turns ──
    // Turn 2's outbound messages has 3 entries: initial user, assistant,
    // tool-result user. Only the very last content block of the last message
    // should be a cachePoint; all earlier messages must be clean.
    const turn2 = capturedMessages[1];
    expect(turn2).toHaveLength(3); // user + assistant + tool-result
    for (const msg of turn2.slice(0, -1)) {
      const hasCachePoint = (msg.content ?? []).some(
        (b: any) => "cachePoint" in b,
      );
      expect(hasCachePoint).toBe(false);
    }

    // ── Assertion 3: non-cachePoint content is intact ──
    // Turn 1 outbound: single user message with instruction text.
    const turn1UserContent = capturedMessages[0][0].content.filter(
      (b: any) => !("cachePoint" in b),
    );
    expect(turn1UserContent).toEqual([{ text: "do the thing" }]);

    // Turn 2 outbound: assistant message must contain the toolUse block.
    const turn2Assistant = turn2[1];
    const toolUseBlocks = (turn2Assistant.content ?? []).filter(
      (b: any) => "toolUse" in b,
    );
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0].toolUse.name).toBe("bash");

    // Turn 2 outbound: tool-result message must contain the bash output.
    const turn2ToolResult = turn2[2];
    const toolResultBlocks = (turn2ToolResult.content ?? []).filter(
      (b: any) => !("cachePoint" in b),
    );
    expect(toolResultBlocks).toHaveLength(1);
    expect(toolResultBlocks[0]).toHaveProperty("toolResult");

    // Final response text is correctly extracted from the end_turn message.
    expect(result.text).toBe("done");
    expect(result.usage?.cacheReadTokens).toBe(80);
    expect(result.usage?.cacheWriteTokens).toBe(80); // 50 + 30
  });
});
