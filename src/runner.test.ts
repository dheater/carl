import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
    // Compound commands where the bare recursive listing is the final token
    // are still blocked — the $ anchor fires after the last arg.
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
    // Piped find — the recursive listing is not at the end of the string,
    // so the $ anchor does not fire; the pipe limits output anyway.
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
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-runner-"));
    runner = new TestableBedrockRunner("us-east-1");
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
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

  test("read_file returns file contents", () => {
    fs.writeFileSync(path.join(workspaceRoot, "hello.txt"), "world");
    const result = runner.exec(
      "read_file",
      { path: "hello.txt" },
      workspaceRoot,
    );
    expect(result).toBe("world");
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
    // Must not have read the real file
    expect(result).not.toContain("root:");
  });
});
