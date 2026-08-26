import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runValidation,
  tailOutput,
  describeValidation,
  buildValidationRetryPrompt,
  VALIDATION_OUTPUT_LIMIT,
  type ValidationResult,
} from "./validate";

describe("runValidation", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-validate-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("passes on exit 0 and reports the command", () => {
    const result = runValidation(workspaceRoot, "exit 0");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.command).toBe("exit 0");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("fails on a non-zero exit and keeps the real exit code", () => {
    const result = runValidation(workspaceRoot, "exit 3");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test("runs in the workspace, not carl's cwd", () => {
    const result = runValidation(workspaceRoot, "pwd");
    // macOS resolves /var through a symlink to /private/var.
    expect(fs.realpathSync(result.output.trim())).toBe(
      fs.realpathSync(workspaceRoot),
    );
  });

  test("labels both streams when the command writes to each", () => {
    const result = runValidation(
      workspaceRoot,
      "echo to-stdout; echo to-stderr >&2; exit 1",
    );
    expect(result.output).toContain("--- stdout ---");
    expect(result.output).toContain("to-stdout");
    expect(result.output).toContain("--- stderr ---");
    expect(result.output).toContain("to-stderr");
  });

  test("does not label a single stream", () => {
    const result = runValidation(workspaceRoot, "echo only-stdout");
    expect(result.output).toBe("only-stdout");
  });

  test("fails with the shell's message when the command does not exist", () => {
    const result = runValidation(
      workspaceRoot,
      "carl-no-such-command-xyz --check",
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("carl-no-such-command-xyz");
  });

  test("reports a timeout as a timeout, not as a failing check", () => {
    const result = runValidation(workspaceRoot, "sleep 5", 100);
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // A killed process has no exit status, and spawnSync discards its output.
    // This is exactly why a timeout is never handed to a repair session.
    expect(result.exitCode).toBeNull();
  });

  test("truncates a huge log to the output limit", () => {
    const result = runValidation(
      workspaceRoot,
      `node -e 'for (let i = 0; i < 20000; i++) console.log("line " + i)'; exit 1`,
    );
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(
      VALIDATION_OUTPUT_LIMIT + 100,
    );
    // The tail is what a test runner puts the failure in.
    expect(result.output).toContain("line 19999");
    expect(result.output).toContain("earlier characters omitted");
  });
});

describe("tailOutput", () => {
  test("returns short text unchanged", () => {
    expect(tailOutput("all good\n", 100)).toBe("all good\n");
  });

  test("returns text exactly at the limit unchanged", () => {
    const text = "x".repeat(50);
    expect(tailOutput(text, 50)).toBe(text);
  });

  test("keeps the tail and notes how much was dropped", () => {
    const text = ["one", "two", "three", "four"].join("\n");
    const trimmed = tailOutput(text, 11);
    expect(trimmed).toContain("four");
    expect(trimmed).toContain("earlier characters omitted");
  });

  test("cuts on a line boundary so no half line survives", () => {
    const text = "aaaaaaaa\nbbbbbbbb\ncccccccc";
    const trimmed = tailOutput(text, 14);
    const body = trimmed.split("\n").slice(1).join("\n");
    expect(body).toBe("cccccccc");
  });

  test("keeps the tail even when the text has no newline to cut on", () => {
    const trimmed = tailOutput("y".repeat(100), 10);
    expect(trimmed).toContain("y".repeat(10));
    expect(trimmed).toContain("omitted");
  });
});

describe("describeValidation", () => {
  function result(over: Partial<ValidationResult> = {}): ValidationResult {
    return {
      command: "npm test",
      ok: false,
      exitCode: 1,
      timedOut: false,
      output: "",
      durationMs: 2500,
      ...over,
    };
  }

  test("reports a pass with the command and duration", () => {
    const line = describeValidation(result({ ok: true, exitCode: 0 }));
    expect(line).toContain("Validation passed");
    expect(line).toContain("2.5s");
    expect(line).toContain("npm test");
  });

  test("reports a failure with the exit code", () => {
    const line = describeValidation(result({ exitCode: 7 }));
    expect(line).toContain("Validation failed");
    expect(line).toContain("exit 7");
  });

  test("explains that a timeout lost its output and is not retried", () => {
    const line = describeValidation(
      result({ timedOut: true, exitCode: null, durationMs: 900_000 }),
    );
    expect(line).toContain("timed out");
    expect(line).toContain("output was lost");
    expect(line).toContain("does not retry");
    expect(line).toContain("15 minutes");
  });
});

describe("buildValidationRetryPrompt", () => {
  const failure: ValidationResult = {
    command: "just test",
    ok: false,
    exitCode: 2,
    timedOut: false,
    output: "FAIL src/thing.test.ts: expected 2, got 3",
    durationMs: 1000,
  };

  const firstRepair = { attempt: 1, total: 2 };

  test("restates the request, the previous summary, and the failure", () => {
    const prompt = buildValidationRetryPrompt(
      "Add a retry to the uploader",
      "# Summary\n\nAdded a retry loop to upload().",
      failure,
      firstRepair,
    );
    expect(prompt).toContain("# Original request");
    expect(prompt).toContain("Add a retry to the uploader");
    expect(prompt).toContain("# Previous attempt");
    expect(prompt).toContain("Added a retry loop to upload()");
    expect(prompt).toContain("# Validation failure");
    expect(prompt).toContain("just test");
    expect(prompt).toContain("exited 2");
    expect(prompt).toContain("expected 2, got 3");
  });

  test("tells the repair session it does not share the previous memory", () => {
    const prompt = buildValidationRetryPrompt(
      "req",
      "summary",
      failure,
      firstRepair,
    );
    expect(prompt).toContain("not share its memory");
  });

  test("forbids weakening the check and asks for a whole-change summary", () => {
    const prompt = buildValidationRetryPrompt(
      "req",
      "summary",
      failure,
      firstRepair,
    );
    expect(prompt).toContain("Do not weaken, skip, or delete a check");
    expect(prompt).toContain("pre-dates the change");
    expect(prompt).toContain("summary replaces the previous attempt's");
  });

  test("says so plainly when the previous attempt reported nothing", () => {
    const prompt = buildValidationRetryPrompt(
      "req",
      "   ",
      failure,
      firstRepair,
    );
    expect(prompt).toContain("(it reported nothing)");
  });

  test("says so plainly when the failure produced no output", () => {
    const prompt = buildValidationRetryPrompt(
      "req",
      "summary",
      { ...failure, output: "" },
      firstRepair,
    );
    expect(prompt).toContain("(no output)");
  });

  test("the first repair is not told that anything was already tried", () => {
    const prompt = buildValidationRetryPrompt(
      "req",
      "summary",
      failure,
      firstRepair,
    );
    expect(prompt).not.toContain("repair attempt");
    expect(prompt).not.toContain("already saw this failure");
  });

  test("a later repair is told how many repairs already failed", () => {
    // Without this, the third session has no reason not to try the second
    // session's fix again — it cannot tell it is not the first repair.
    const prompt = buildValidationRetryPrompt("req", "summary", failure, {
      attempt: 2,
      total: 2,
    });
    expect(prompt).toContain("repair attempt 2 of 2");
    expect(prompt).toContain("1 earlier repair session already saw this");
    expect(prompt).toContain("do not guess again");
  });

  test("pluralizes the count of earlier repairs", () => {
    const prompt = buildValidationRetryPrompt("req", "summary", failure, {
      attempt: 3,
      total: 4,
    });
    expect(prompt).toContain("repair attempt 3 of 4");
    expect(prompt).toContain("2 earlier repair sessions already saw this");
  });
});
