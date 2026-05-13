import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("./github", () => ({
  parsePrUrl: jest.fn().mockReturnValue({ owner: "owner", repo: "repo", number: 42 }),
  checkGhCli: jest.fn(),
  checkRepoMatch: jest.fn(),
  fetchPrMetadata: jest.fn().mockReturnValue({
    number: 42,
    title: "Fix it",
    body: "",
    headSha: "abc1234",
    baseSha: "def5678",
    baseRef: "main",
    headRef: "fix",
    state: "open",
    commits: [{ sha: "abc1234", message: "Fix it", author: "Alice" }],
  }),
  fetchPrDiff: jest.fn().mockReturnValue("diff --git a/f.ts b/f.ts\n"),
  fetchPrHeadSha: jest.fn().mockReturnValue("abc1234"),
  submitPrReview: jest.fn(),
}));

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
  const VALID_PRD =
    "## Goal\n\nShip it\n\n## Non-goals\n\nNone\n\n## Constraints\n\nKeep it simple\n\n## Acceptance criteria\n\n- [ ] Works\n\n## Risks/open questions\n\nNone";
  let promptDir: string;
  let promptFile: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prompt-"));
    promptFile = path.join(promptDir, "prompt.md");
    fs.writeFileSync(promptFile, "ship it\n", "utf-8");
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
    if (fs.existsSync(promptDir)) {
      fs.rmSync(promptDir, { recursive: true, force: true });
    }
  });

  async function runLoadedCli(): Promise<void> {
    const carl = require("./carl") as typeof import("./carl");
    await carl.cliPromise;
  }

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
      await runLoadedCli();
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

  async function expectCliSuccess(args: string[], cwd: string): Promise<void> {
    process.argv = ["node", "carl", ...args];
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(cwd);
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runLoadedCli();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  }

  test("--version prints version and exits 0", async () => {
    process.argv = ["node", "carl", "--version"];
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runLoadedCli();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^carl \d+\.\d+\.\d+/),
      );
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

      const mockRunPhase = await runCli(["plan", promptFile], {
        cwd: tmpDir,
        runPhaseResult: {
          status: "success",
          response: VALID_PRD,
        },
      });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "architect",
        "plan",
        "ship it",
        undefined,
      );
      expect(fs.existsSync(staleFile)).toBe(false);
    });

    test("opens .agent/prd.md after a valid plan run", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase.mockImplementationOnce(async () => {
        fs.mkdirSync(path.dirname(prdPath), { recursive: true });
        fs.writeFileSync(prdPath, VALID_PRD, "utf-8");
        return { status: "success", response: VALID_PRD };
      });
      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;

      await expectCliSuccess(["plan", promptFile], tmpDir);

      expect(mockRunPhase).toHaveBeenCalledTimes(1);
      expect(mockOpenFileInEditor).toHaveBeenCalledWith(prdPath);
    });

    test("accepts a valid .agent/prd.md even when architect returns a summary", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase.mockImplementationOnce(async () => {
        fs.mkdirSync(path.dirname(prdPath), { recursive: true });
        fs.writeFileSync(prdPath, VALID_PRD, "utf-8");
        return {
          status: "success",
          response: "I replaced `.agent/prd.md` with the full PRD.",
        };
      });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;

      await expectCliSuccess(["plan", promptFile], tmpDir);

      expect(mockRunPhase).toHaveBeenCalledTimes(1);
      expect(mockOpenFileInEditor).toHaveBeenCalledWith(prdPath);
    });

    test("keeps interviewing through .agent/notes/architect.md and does not open the PRD", async () => {
      const notesPath = path.join(tmpDir, ".agent", "notes", "architect.md");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.dirname(notesPath), { recursive: true });
          fs.writeFileSync(
            notesPath,
            "# Interview\n\n1. **Question one?**\n",
            "utf-8",
          );
          return {
            status: "blocked",
            response: "# Interview\n\n1. **Question one?**\n",
          };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(
            notesPath,
            "# Interview\n\n1. **Question two?**\n",
            "utf-8",
          );
          return {
            status: "blocked",
            response: "# Interview\n\n1. **Question two?**\n",
          };
        })
        .mockResolvedValueOnce({
          status: "success",
          response: VALID_PRD,
        });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor
        .mockImplementationOnce((filePath: string) => {
          fs.writeFileSync(
            filePath,
            "# Interview\n\n1. **Question one?**\n\n   > 1. Option A\n",
            "utf-8",
          );
        })
        .mockImplementationOnce((filePath: string) => {
          fs.writeFileSync(
            filePath,
            "# Interview\n\n1. **Question two?**\n\n   > 2. Option B\n",
            "utf-8",
          );
        });

      await expectCliSuccess(["plan", promptFile], tmpDir);

      expect(mockRunPhase).toHaveBeenNthCalledWith(
        1,
        tmpDir,
        "architect",
        "plan",
        "ship it",
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "architect",
        "plan",
        expect.stringContaining("# Original planning request\n\nship it"),
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "architect",
        "plan",
        expect.stringContaining("1. Option A"),
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        3,
        tmpDir,
        "architect",
        "plan",
        expect.stringContaining("1. Option A"),
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        3,
        tmpDir,
        "architect",
        "plan",
        expect.stringContaining("2. Option B"),
        undefined,
      );
      expect(mockOpenFileInEditor).toHaveBeenCalledTimes(2);
    });

    test("saves pending plan prompt if the follow-up PRD run hits a network failure", async () => {
      const pendingPath = path.join(tmpDir, ".agent", "pending-plan-prompt.md");
      const notesPath = path.join(tmpDir, ".agent", "notes", "architect.md");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.dirname(notesPath), { recursive: true });
          fs.writeFileSync(
            notesPath,
            "# Interview\n\n1. **Question?**\n",
            "utf-8",
          );
          return {
            status: "blocked",
            response: "# Interview\n\n1. **Question?**\n",
          };
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
        fs.writeFileSync(
          filePath,
          "# Interview\n\n1. **Question?**\n\n   > 1. Option A\n",
          "utf-8",
        );
      });

      process.argv = ["node", "carl", "plan", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
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
      fs.writeFileSync(
        notesPath,
        "# Interview\n\n1. **Question?**\n\n   >\n",
        "utf-8",
      );

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockResolvedValueOnce({
          status: "blocked",
          response: "BLOCKED: need input",
        })
        .mockResolvedValueOnce({ status: "success", response: "implemented" });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor.mockImplementationOnce((filePath: string) => {
        fs.writeFileSync(
          filePath,
          "# Interview\n\n1. **Question?**\n\n   > answered\n",
          "utf-8",
        );
      });

      await expectCliSuccess(["code", promptFile], tmpDir);

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
        "# Interview\n\n1. **Question?**\n\n   > answered\n",
        undefined,
      );
      expect(mockOpenFileInEditor).toHaveBeenCalledTimes(2);
    });

    test("reruns chat after the user edits .agent/notes/chat.md", async () => {
      const notesPath = path.join(tmpDir, ".agent", "notes", "chat.md");
      fs.mkdirSync(path.dirname(notesPath), { recursive: true });
      fs.writeFileSync(notesPath, "initial reply\n", "utf-8");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockResolvedValueOnce({ status: "success", response: "initial reply" })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(notesPath, "edited follow-up\n", "utf-8");
          return { status: "success", response: "edited follow-up" };
        });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor
        .mockImplementationOnce((filePath: string) => {
          fs.writeFileSync(filePath, "edited follow-up\n", "utf-8");
        })
        .mockImplementationOnce(() => {});

      await expectCliSuccess(["chat", promptFile], tmpDir);

      expect(mockRunPhase).toHaveBeenNthCalledWith(
        1,
        tmpDir,
        "chat",
        "chat",
        "ship it",
        undefined,
      );
      expect(mockRunPhase).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "chat",
        "chat",
        "edited follow-up\n",
        undefined,
      );
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
        await runLoadedCli();
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

    test("reruns a blocked PRD phase after the user edits .agent/notes/developer.md", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      const notesPath = path.join(tmpDir, ".agent", "notes", "developer.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [ ] Phase 1: Setup\n");

      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<
        typeof phase.runPhase
      >;
      mockRunPhase
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.dirname(notesPath), { recursive: true });
          fs.writeFileSync(
            notesPath,
            "# Interview\n\n1. **Question?**\n\n   >\n",
            "utf-8",
          );
          return {
            status: "blocked",
            response: "# Interview\n\n1. **Question?**\n\n   >\n",
          };
        })
        .mockResolvedValueOnce({ status: "success", response: "implemented" });

      const editor = require("./editor") as typeof import("./editor");
      const mockOpenFileInEditor =
        editor.openFileInEditor as jest.MockedFunction<
          typeof editor.openFileInEditor
        >;
      mockOpenFileInEditor.mockImplementationOnce((filePath: string) => {
        fs.writeFileSync(
          filePath,
          "# Interview\n\n1. **Question?**\n\n   > answered\n",
          "utf-8",
        );
      });

      await expectCliSuccess(["code"], tmpDir);

      expect(mockRunPhase).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "developer",
        "code",
        "# Interview\n\n1. **Question?**\n\n   > answered\n",
        undefined,
      );
      expect(fs.readFileSync(prdPath, "utf-8")).toContain(
        "- [x] Phase 1: Setup",
      );
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
        await runLoadedCli();
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

  describe("pr-review", () => {
    test("rejects missing URL with a command-specific error", async () => {
      process.argv = ["node", "carl", "pr-review"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/ws");
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("pr-review [--no-pub] <github-pr-url>"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    test("calls gh helpers, submits review, and logs success", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-ws-"));
      const github = require("./github") as typeof import("./github");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
      mockRunPhase.mockResolvedValue({ status: "success", response: "## Summary\n\nLooks good.\n" });

      process.argv = [
        "node",
        "carl",
        "pr-review",
        "https://github.com/owner/repo/pull/42",
      ];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(github.checkGhCli).toHaveBeenCalled();
        expect(github.parsePrUrl).toHaveBeenCalledWith(
          "https://github.com/owner/repo/pull/42",
        );
        expect(github.checkRepoMatch).toHaveBeenCalledWith(tmpWs, "owner", "repo");
        expect(github.fetchPrMetadata).toHaveBeenCalledWith("owner", "repo", 42);
        expect(github.fetchPrDiff).toHaveBeenCalledWith("owner", "repo", 42);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("PR #42"));
        expect(fs.existsSync(path.join(tmpWs, ".agent", "pr-review-owner-repo-42.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpWs, ".agent", "pr-review-owner-repo-42-payload.json"))).toBe(true);
        // Stale check and submission
        expect(github.fetchPrHeadSha).toHaveBeenCalledWith("owner", "repo", 42);
        expect(github.submitPrReview).toHaveBeenCalledWith(
          "owner", "repo", 42, "abc1234", expect.any(Array),
        );
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("submitted successfully"));
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("aborts submission and throws when PR head SHA changed", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-stale-"));
      const github = require("./github") as typeof import("./github");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
      mockRunPhase.mockResolvedValue({ status: "success", response: "## Summary\n\nConcern.\n" });
      (github.fetchPrHeadSha as jest.MockedFunction<any>).mockReturnValue("newsha999");

      process.argv = [
        "node",
        "carl",
        "pr-review",
        "https://github.com/owner/repo/pull/42",
      ];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("changed after review was generated"),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("abc1234"),
        );
        // currentHeadSha.slice(0,8) of "newsha999" = "newsha99"
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("newsha99"),
        );
        expect(github.submitPrReview).not.toHaveBeenCalled();
        // Payload still on disk for recovery
        expect(fs.existsSync(path.join(tmpWs, ".agent", "pr-review-owner-repo-42-payload.json"))).toBe(true);
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("leaves payload on disk and throws with recovery instructions on submission failure", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-fail-"));
      const github = require("./github") as typeof import("./github");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
      mockRunPhase.mockResolvedValue({ status: "success", response: "## Summary\n\nNote.\n" });
      (github.submitPrReview as jest.MockedFunction<any>).mockImplementation(() => {
        throw new Error("Failed to submit review for owner/repo#42: HTTP 422");
      });

      process.argv = [
        "node",
        "carl",
        "pr-review",
        "https://github.com/owner/repo/pull/42",
      ];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("remain saved at"),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("To retry: carl pr-review-submit"),
        );
        // Payload still on disk
        expect(fs.existsSync(path.join(tmpWs, ".agent", "pr-review-owner-repo-42-payload.json"))).toBe(true);
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("skips stale check and submission when --no-pub is set", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-nopub-"));
      const github = require("./github") as typeof import("./github");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
      mockRunPhase.mockResolvedValue({ status: "success", response: "## Summary\n\nLooks good.\n" });

      process.argv = [
        "node",
        "carl",
        "pr-review",
        "--no-pub",
        "https://github.com/owner/repo/pull/42",
      ];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(github.fetchPrHeadSha).not.toHaveBeenCalled();
        expect(github.submitPrReview).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("--no-pub"));
        expect(fs.existsSync(path.join(tmpWs, ".agent", "pr-review-owner-repo-42-payload.json"))).toBe(true);
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("skips stale check and submission when no comments are extracted", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-none-"));
      const github = require("./github") as typeof import("./github");
      const phase = require("./phase") as typeof import("./phase");
      const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
      // Response with no parseable comment blocks
      mockRunPhase.mockResolvedValue({ status: "success", response: "" });

      process.argv = [
        "node",
        "carl",
        "pr-review",
        "https://github.com/owner/repo/pull/42",
      ];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(github.fetchPrHeadSha).not.toHaveBeenCalled();
        expect(github.submitPrReview).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No comments extracted"));
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });
  });
});
