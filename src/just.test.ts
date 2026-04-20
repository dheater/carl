import { runJust, runJustFormat, runJustLint } from "./just";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("child_process");

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe("runJust helper", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("calls spawnSync with correct arguments", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    // Use a non-existent workspace to avoid fs.existsSync returning true
    runJust("/nonexistent", "format");

    expect(mockSpawnSync).toHaveBeenCalled();
    const call = mockSpawnSync.mock.calls[0];
    expect(call[0]).toBe("just"); // plain just since no devbox.json
    expect(call[1]).toContain("format");
  });

  test("returns structured result with exitCode, stdout, stderr", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "output",
      stderr: "err",
    } as any);

    const result = runJust("/tmp", "format");

    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
  });

  test("handles spawn failures gracefully without crashing", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(() => runJust("/tmp", "format")).not.toThrow();
    const result = runJust("/tmp", "format");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/unavailable|not found/i);
  });
});

describe("runJustFormat", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("calls runJust with format target", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    runJustFormat("/tmp");
    expect(mockSpawnSync).toHaveBeenCalled();
    const call = mockSpawnSync.mock.calls[0];
    expect(call[1]).toContain("format");
  });

  test("does not throw on non-zero exit", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "error",
    } as any);

    expect(() => runJustFormat("/tmp")).not.toThrow();
  });
});

describe("runJustLint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-just-lint-test-"));
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates .agent/lint.log with command and output", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "lint output",
      stderr: "",
    } as any);

    runJustLint(tmpDir);

    const logPath = path.join(tmpDir, ".agent", "lint.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("lint output");
  });

  test("returns result without throwing on lint failure", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "lint failed",
    } as any);

    expect(() => runJustLint(tmpDir)).not.toThrow();
    const result = runJustLint(tmpDir);
    expect(result.exitCode).toBe(1);
  });
});

describe("runCanonicalTests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-tests-"));
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("with Justfile: runs 'just test' and returns usedJust=true", () => {
    // Create a Justfile in the temp directory
    fs.writeFileSync(path.join(tmpDir, "Justfile"), "test:\n  echo testing");

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "tests pass",
      stderr: "",
    } as any);

    const { runCanonicalTests } = require("./just");
    const result = runCanonicalTests(tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.usedJust).toBe(true);
    expect(result.command).toBe("just test");
  });

  test("without Justfile but with package.json test script: runs npm test and returns usedJust=false", () => {
    const packageJsonPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ scripts: { test: "jest" } }),
    );

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "tests pass",
      stderr: "",
    } as any);

    const { runCanonicalTests } = require("./just");
    const result = runCanonicalTests(tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.usedJust).toBe(false);
    expect(result.command).toBe("npm test");
  });

  test("without Justfile or test script: returns non-zero exit code with instructive error", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as any);

    const { runCanonicalTests } = require("./just");
    const result = runCanonicalTests(tmpDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.usedJust).toBe(false);
    expect(result.stderr).toMatch(/just test|npm test/i);
  });
});
