import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("./phase", () => {
  const actual = jest.requireActual("./phase") as typeof import("./phase");
  return {
    ...actual,
    runPhase: jest.fn(),
  };
});

jest.mock("./editor", () => {
  const actual = jest.requireActual("./editor") as typeof import("./editor");
  return {
    ...actual,
    openFileInEditor: jest.fn(),
  };
});

describe("carl CLI", () => {
  const originalArgv = process.argv;
  const NETWORK_FAILURE_MESSAGE =
    "Network unavailable after 3 attempts — run `carl code` to retry.";
  let promptFile: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    promptFile = path.join(os.tmpdir(), `carl-prompt-${Date.now()}.md`);
    fs.writeFileSync(promptFile, "ship it\n", "utf-8");
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
    if (fs.existsSync(promptFile)) {
      fs.unlinkSync(promptFile);
    }
  });

  async function runCli(
    args: string[],
    opts: {
      cwd?: string;
      runPhaseResult?: { status: "success" | "blocked"; response: string };
    } = {},
  ): Promise<jest.MockedFunction<typeof import("./phase").runPhase>> {
    const cwd = opts.cwd ?? "/tmp/carl-workspace";
    const phase = require("./phase") as typeof import("./phase");
    const mockRunPhase = phase.runPhase as jest.MockedFunction<
      typeof phase.runPhase
    >;
    mockRunPhase.mockResolvedValue(
      opts.runPhaseResult ?? { status: "success", response: "done" },
    );

    process.argv = ["node", "carl", ...args];
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(cwd);
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      require("./carl");
      await new Promise((resolve) => setImmediate(resolve));
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    return mockRunPhase;
  }

  test("--version prints version and exits 0", async () => {
    process.argv = ["node", "carl", "--version"];
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      require("./carl");
      await new Promise((resolve) => setImmediate(resolve));
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^carl \d+\.\d+\.\d+/));
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("passes prompt file content to code", async () => {
    const mockRunPhase = await runCli(["code", promptFile]);
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "developer",
      "code",
      "ship it",
      undefined,
    );
  });

  test("passes prompt file content to chat", async () => {
    const mockRunPhase = await runCli(["chat", promptFile]);
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "chat",
      "chat",
      "ship it",
      undefined,
    );
  });

  describe("interview follow-up", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-follow-up-"));
      fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("plan deletes .agent before running", async () => {
      const staleFile = path.join(tmpDir, ".agent", "notes", "stale.md");
      fs.mkdirSync(path.dirname(staleFile), { recursive: true });
      fs.writeFileSync(staleFile, "stale content", "utf-8");

      const mockRunPhase = await runCli(["plan", promptFile], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "architect",
        "plan",
        "ship it",
        undefined,
      );
      expect(fs.existsSync(staleFile)).toBe(false);
    });

    test("reruns plan after the user edits .agent/prd.md", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
          fs.writeFileSync(prdPath, "# Interview\n\n1. **Question?**\n\n   >\n", "utf-8");
          return { status: "success", response: "interview" };
        })
        .mockResolvedValueOnce({ status: "success", response: "final prd" });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor.mockImplementationOnce((filePath: string) => {
        fs.writeFileSync(filePath, "# Interview\n\n1. **Question?**\n\n   > answered\n", "utf-8");
      });

      process.argv = ["node", "carl", "plan", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        require("./carl");
        await new Promise((resolve) => setImmediate(resolve));
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      expect(mockRunPhase).toHaveBeenNthCalledWith(
        1,
        tmpDir,
        "architect",
        "plan",
        "ship it",
        undefined,
      );
      expect(mockOpenFileInEditor).toHaveBeenCalledTimes(2);
    });

    test("saves pending plan prompt if the follow-up PRD run hits a network failure", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      const pendingPath = path.join(tmpDir, ".agent", "pending-plan-prompt.md");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
          fs.writeFileSync(prdPath, "# Interview\n\n1. **Question?**\n\n   >\n", "utf-8");
          return { status: "success", response: "interview" };
        })
        .mockRejectedValueOnce(
          new phase.NetworkUnavailableError(
            "Network unavailable after 3 attempts — run `carl plan` to retry.",
          ),
        );

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor.mockImplementationOnce((filePath: string) => {
        fs.writeFileSync(filePath, "# Interview\n\n1. **Question?**\n\n   > answered\n", "utf-8");
      });

      process.argv = ["node", "carl", "plan", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        require("./carl");
        await new Promise((resolve) => setImmediate(resolve));
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      expect(fs.readFileSync(pendingPath, "utf-8")).toBe("ship it");
    });

    test("reruns code after the user edits .agent/notes/developer.md", async () => {
      const notesPath = path.join(tmpDir, ".agent", "notes", "developer.md");
      fs.mkdirSync(path.dirname(notesPath), { recursive: true });
      fs.writeFileSync(notesPath, "# Interview\n\n1. **Question?**\n\n   >\n", "utf-8");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockResolvedValueOnce({ status: "blocked", response: "BLOCKED: need input" })
        .mockResolvedValueOnce({ status: "success", response: "implemented" });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor.mockImplementationOnce((filePath: string) => {
        fs.writeFileSync(filePath, "# Interview\n\n1. **Question?**\n\n   > answered\n", "utf-8");
      });

      process.argv = ["node", "carl", "code", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        require("./carl");
        await new Promise((resolve) => setImmediate(resolve));
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      expect(mockRunPhase).toHaveBeenNthCalledWith(
        1,
        tmpDir,
        "developer",
        "code",
        "ship it",
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "developer",
        "code",
        "The user has answered the interview questions by editing .agent/notes/developer.md. Proceed with implementation. Do not ask any more questions.",
        undefined,
      );
      expect(mockOpenFileInEditor).toHaveBeenCalledTimes(2);
    });
  });

  describe("pending prompt", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pending-"));
      fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("explicit prompt file overrides stale pending prompt", async () => {
      const pendingPath = path.join(tmpDir, ".agent", "pending-code-prompt.md");
      fs.writeFileSync(pendingPath, "stale prompt", "utf-8");

      const freshPromptFile = path.join(tmpDir, "fresh.md");
      fs.writeFileSync(freshPromptFile, "fresh prompt\n", "utf-8");

      const mockRunPhase = await runCli(["code", freshPromptFile], {
        cwd: tmpDir,
      });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        "fresh prompt",
        undefined,
      );
      expect(fs.existsSync(pendingPath)).toBe(false);
    });

    test("resumes pending prompt when it exists (network failure recovery)", async () => {
      const pendingPath = path.join(tmpDir, ".agent", "pending-code-prompt.md");
      fs.writeFileSync(pendingPath, "network failure prompt", "utf-8");

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        "network failure prompt",
        undefined,
      );
      expect(fs.existsSync(pendingPath)).toBe(false);
    });

    test("saves pending prompt when runPhase throws a network failure", async () => {
      const pendingPath = path.join(tmpDir, ".agent", "pending-code-prompt.md");
      const freshPromptFile = path.join(tmpDir, "fresh.md");
      fs.writeFileSync(freshPromptFile, "my prompt\n", "utf-8");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase.mockRejectedValue(
        new phase.NetworkUnavailableError(NETWORK_FAILURE_MESSAGE),
      );

      process.argv = ["node", "carl", "code", freshPromptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        require("./carl");
        await new Promise((resolve) => setImmediate(resolve));
      } catch {
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      expect(fs.existsSync(pendingPath)).toBe(true);
      expect(fs.readFileSync(pendingPath, "utf-8")).toBe("my prompt");
    });
  });

  describe("code with PRD phases", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prd-cli-"));
      fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("runs first incomplete phase and marks it complete", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(
        prdPath,
        "## Phases\n\n- [ ] Phase 1: Setup\n- [ ] Phase 2: Impl\n",
      );

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        expect.stringContaining("Phase 1: Setup"),
        undefined,
      );
      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [x] Phase 1: Setup");
      expect(prd).toContain("- [ ] Phase 2: Impl");
    });

    test("skips already-complete phases and runs the next one", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(
        prdPath,
        "## Phases\n\n- [x] Phase 1: Setup\n- [ ] Phase 2: Impl\n",
      );

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        expect.stringContaining("Phase 2: Impl"),
        undefined,
      );
      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [x] Phase 2: Impl");
    });

    test("does not mark phase complete when developer is blocked", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [ ] Phase 1: Setup\n");

      await runCli(["code"], {
        cwd: tmpDir,
        runPhaseResult: {
          status: "blocked",
          response: "BLOCKED: missing info",
        },
      });

      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [ ] Phase 1: Setup");
    });

    test("does nothing when all phases are complete", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(
        prdPath,
        "## Phases\n\n- [x] Phase 1: Setup\n- [x] Phase 2: Impl\n",
      );

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).not.toHaveBeenCalled();
    });

    test("logs phase-specific diagnostic and rethrows on network failure in PRD path", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(
        prdPath,
        "## Phases\n\n- [ ] Phase 1: Setup\n- [ ] Phase 2: Impl\n",
      );

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase.mockRejectedValue(
        new phase.NetworkUnavailableError(NETWORK_FAILURE_MESSAGE),
      );

      process.argv = ["node", "carl", "code"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        require("./carl");
        await new Promise((resolve) => setImmediate(resolve));
      } catch {
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }

      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [ ] Phase 1: Setup");

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Phase "Phase 1: Setup" interrupted by network failure',
        ),
      );

      logSpy.mockRestore();
    });
  });
});
