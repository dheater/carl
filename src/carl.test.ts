import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_MODELS } from "./phase";

jest.mock("child_process", () => ({
  spawnSync: jest.fn(),
}));

const SAMPLE_DIFF = [
  "diff --git a/src/f.ts b/src/f.ts",
  "--- a/src/f.ts",
  "+++ b/src/f.ts",
  "@@ -1,2 +1,3 @@",
  " line1",
  "+added line",
  " line2",
].join("\n");

jest.mock("./github", () => ({
  parsePrUrl: jest
    .fn()
    .mockReturnValue({ owner: "owner", repo: "repo", number: 42 }),
  checkGhCli: jest.fn(),
  checkRepoMatch: jest.fn(),
  checkNotForkPr: jest.fn(),
  fetchPrMetadata: jest.fn().mockReturnValue({
    number: 42,
    headSha: "abc1234",
    headRepoFullName: "owner/repo",
  }),
  fetchPrDiff: jest.fn().mockReturnValue(SAMPLE_DIFF),
  createPendingReview: jest.fn().mockReturnValue("77001"),
}));

jest.mock("./git", () => ({
  getHeadSha: jest.fn().mockReturnValue("abc1234"),
  getGitStatus: jest.fn().mockReturnValue({
    isRepo: true,
    trackedChanged: [],
    untracked: [],
  }),
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
    collectPrompt: jest.fn(),
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
    const childProcess =
      require("child_process") as typeof import("child_process");
    (
      childProcess.spawnSync as jest.MockedFunction<
        typeof childProcess.spawnSync
      >
    ).mockReturnValue({ status: 0, signal: null } as any);
    const editor = require("./editor") as typeof import("./editor");
    (
      editor.collectPrompt as jest.MockedFunction<typeof editor.collectPrompt>
    ).mockReturnValue("ship it");
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

  test("--version prints version", async () => {
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

  test("unknown commands print generic usage", async () => {
    process.argv = ["node", "carl", "bogus"];
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/ws");
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runLoadedCli();
      expect(exitSpy).toHaveBeenCalledWith(1);
      const allErrors = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(allErrors).toContain("Usage: carl [--model <model>] <command>");
      expect(allErrors).toContain("verify        Run verifier once");
      expect(allErrors).toContain("pr-review <github-pr-url>");
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
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

  test("dispatches verify to the verify phase", async () => {
    const mockRunPhase = await runCli(["verify"]);
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "verify",
      "verify",
      undefined,
      undefined,
    );
  });

  test("chat shells out to auggie with Carl rules and the configured model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-chat-cli-"));
    const reviewPromptFile = path.join(tmpDir, "review.md");
    const configDir = path.join(tmpDir, ".carl");
    let rulesContent = "";

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ models: { chat: "configured-chat-model" } }),
      "utf-8",
    );
    fs.writeFileSync(reviewPromptFile, "review code in this repo\n", "utf-8");

    const childProcess =
      require("child_process") as typeof import("child_process");
    const mockSpawnSync = childProcess.spawnSync as jest.MockedFunction<
      typeof childProcess.spawnSync
    >;
    mockSpawnSync.mockImplementationOnce((command, args) => {
      const argList = args as string[];
      const rulesPath = argList[argList.indexOf("--rules") + 1];
      rulesContent = fs.readFileSync(rulesPath, "utf-8");
      return { status: 0, signal: null } as any;
    });

    const mockRunPhase = await runCli(["chat", reviewPromptFile], {
      cwd: tmpDir,
    });

    expect(mockRunPhase).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "auggie",
      [
        "--workspace-root",
        tmpDir,
        "--model",
        "configured-chat-model",
        "--rules",
        expect.any(String),
        "--instruction-file",
        reviewPromptFile,
      ],
      expect.objectContaining({ cwd: tmpDir, stdio: "inherit" }),
    );
    expect(rulesContent).toContain("# Chat");
    expect(rulesContent).toContain("# Code Review");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("chat captures the initial prompt in $EDITOR before starting auggie", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "carl-chat-interactive-"),
    );
    const childProcess =
      require("child_process") as typeof import("child_process");
    const mockSpawnSync = childProcess.spawnSync as jest.MockedFunction<
      typeof childProcess.spawnSync
    >;
    const editor = require("./editor") as typeof import("./editor");
    const mockCollectPrompt = editor.collectPrompt as jest.MockedFunction<
      typeof editor.collectPrompt
    >;
    const mockOpenFileInEditor = editor.openFileInEditor as jest.MockedFunction<
      typeof editor.openFileInEditor
    >;
    let capturedInstruction = "";

    mockCollectPrompt.mockReturnValueOnce("review code in this repo");
    mockSpawnSync.mockImplementationOnce((command, args) => {
      const argList = args as string[];
      const instructionPath =
        argList[argList.indexOf("--instruction-file") + 1];
      capturedInstruction = fs.readFileSync(instructionPath, "utf-8");
      return { status: 0, signal: null } as any;
    });

    const mockRunPhase = await runCli(["chat"], { cwd: tmpDir });

    expect(mockRunPhase).not.toHaveBeenCalled();
    expect(mockCollectPrompt).toHaveBeenCalled();
    expect(mockOpenFileInEditor).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "auggie",
      [
        "--workspace-root",
        tmpDir,
        "--model",
        DEFAULT_MODELS.chat,
        "--rules",
        expect.any(String),
        "--instruction-file",
        expect.any(String),
      ],
      expect.objectContaining({ cwd: tmpDir, stdio: "inherit" }),
    );
    expect(capturedInstruction).toBe("review code in this repo\n");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("chat cancels when the editor prompt is blank", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-chat-cancel-"));
    const childProcess =
      require("child_process") as typeof import("child_process");
    const mockSpawnSync = childProcess.spawnSync as jest.MockedFunction<
      typeof childProcess.spawnSync
    >;
    const editor = require("./editor") as typeof import("./editor");
    const mockCollectPrompt = editor.collectPrompt as jest.MockedFunction<
      typeof editor.collectPrompt
    >;

    mockCollectPrompt.mockReturnValueOnce(null);

    try {
      const mockRunPhase = await runCli(["chat"], { cwd: tmpDir });

      expect(mockRunPhase).not.toHaveBeenCalled();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
    const PR_URL = "https://github.com/owner/repo/pull/42";

    function appendComments(draftPath: string, blocks: string[]): void {
      const existing = fs.readFileSync(draftPath, "utf-8");
      const sep = existing.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(
        draftPath,
        existing + sep + blocks.join("\n") + "\n",
        "utf-8",
      );
    }

    function writeValidComment(draftPath: string): void {
      appendComments(draftPath, [
        "||| COMMENT inline src/f.ts:2",
        "Caller sees undefined here because the function never returns.",
        "||| END",
      ]);
    }

    test("rejects missing URL with a command-specific error", async () => {
      process.argv = ["node", "carl", "pr-review"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/ws");
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("carl pr-review <github-pr-url>"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    test("rejects an old-style branch-name argument with an actionable error", async () => {
      process.argv = ["node", "carl", "pr-review", "main"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/ws");
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
        const allErrors = errorSpy.mock.calls
          .map((c) => String(c[0]))
          .join("\n");
        expect(allErrors).toMatch(
          /carl pr-review.*now requires a GitHub PR URL/,
        );
        expect(allErrors).toContain(
          "https://github.com/owner/repo/pull/NUMBER",
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    test("seeds .agent/pr-review.md with PR identity, invokes pr-reviewer, and creates pending review", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-rev-seed-"));
      const phase = require("./phase") as typeof import("./phase");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");

      (phase.runPhase as jest.MockedFunction<any>).mockImplementationOnce(
        async () => {
          writeValidComment(draftPath);
          return { status: "success", response: "done" };
        },
      );

      const github = require("./github") as typeof import("./github");

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(phase.runPhase).toHaveBeenCalledTimes(1);
        expect(phase.runPhase).toHaveBeenCalledWith(
          tmpWs,
          "pr-reviewer",
          "pr-review",
          expect.stringContaining("||| COMMENT"),
          undefined,
        );
        const draft = fs.readFileSync(draftPath, "utf-8");
        expect(draft).toContain("## PR Diff");
        expect(draft).toContain("## Review comments");
        expect(draft).toContain("+added line");
        expect(draft).toContain("PR: owner/repo#42");
        expect(github.createPendingReview).toHaveBeenCalledWith(
          "owner",
          "repo",
          42,
          "abc1234",
          expect.arrayContaining([
            expect.objectContaining({
              type: "inline",
              path: "src/f.ts",
              line: 2,
            }),
          ]),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("does not modify tracked workspace files — only .agent/pr-review.md changes", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-immutable-"),
      );
      const srcFile = path.join(tmpWs, "src", "f.ts");
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      fs.writeFileSync(srcFile, "original\n", "utf-8");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");

      const phase = require("./phase") as typeof import("./phase");
      (phase.runPhase as jest.MockedFunction<any>).mockImplementationOnce(
        async () => {
          writeValidComment(draftPath);
          return { status: "success", response: "done" };
        },
      );

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(srcFile, "utf-8")).toBe("original\n");
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("errors when local HEAD does not match PR head", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-drift-"),
      );
      const git = require("./git") as typeof import("./git");
      (git.getHeadSha as jest.MockedFunction<any>).mockReturnValueOnce(
        "deadbeef00000000",
      );

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("does not match PR head"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("errors when tracked files outside .agent have drifted", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-dirty-"),
      );
      const git = require("./git") as typeof import("./git");
      (git.getGitStatus as jest.MockedFunction<any>).mockReturnValueOnce({
        isRepo: true,
        trackedChanged: ["src/f.ts", ".agent/pr-review.md"],
        untracked: [],
      });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("tracked changes outside .agent"),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("src/f.ts"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("errors when the draft has no ||| COMMENT blocks after skill run", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-nocomm-"),
      );
      const phase = require("./phase") as typeof import("./phase");
      (phase.runPhase as jest.MockedFunction<any>).mockResolvedValue({
        status: "success",
        response: "done",
      });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("No `||| COMMENT` blocks"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("errors when the draft disappears before validation", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-missing-draft-"),
      );
      const phase = require("./phase") as typeof import("./phase");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");
      (phase.runPhase as jest.MockedFunction<any>).mockImplementationOnce(
        async () => {
          fs.rmSync(draftPath, { force: true });
          return { status: "success", response: "done" };
        },
      );

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Draft .agent/pr-review.md is missing"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("rejects a fork PR with a help message", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-rev-fork-"));
      const github = require("./github") as typeof import("./github");
      (
        github.checkNotForkPr as jest.MockedFunction<any>
      ).mockImplementationOnce(() => {
        throw new Error("Fork PRs are not supported.");
      });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
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
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Fork PRs are not supported"),
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("reruns the skill once when scope errors are found, then creates review", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-rerun-"),
      );
      const phase = require("./phase") as typeof import("./phase");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");

      (phase.runPhase as jest.MockedFunction<any>)
        .mockImplementationOnce(async () => {
          appendComments(draftPath, [
            "||| COMMENT inline src/f.ts:999",
            "Out of scope.",
            "||| END",
          ]);
          return { status: "success", response: "done" };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(
            draftPath,
            [
              "## Review comments",
              "",
              "||| COMMENT inline src/f.ts:2",
              "Valid rationale.",
              "||| END",
            ].join("\n"),
            "utf-8",
          );
          return { status: "success", response: "done" };
        });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(phase.runPhase).toHaveBeenCalledTimes(2);
        expect((phase.runPhase as jest.Mock).mock.calls[1][3]).toMatch(
          /Errors:/,
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("reruns the skill once when draft blocks are malformed, then creates review", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-parse-rerun-"),
      );
      const phase = require("./phase") as typeof import("./phase");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");

      (phase.runPhase as jest.MockedFunction<any>)
        .mockImplementationOnce(async () => {
          fs.writeFileSync(
            draftPath,
            [
              "## Review comments",
              "",
              "||| COMMENT inline src/f.ts:2",
              "Broken block.",
            ].join("\n"),
            "utf-8",
          );
          return { status: "success", response: "done" };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(
            draftPath,
            [
              "## Review comments",
              "",
              "||| COMMENT inline src/f.ts:2",
              "Valid rationale.",
              "||| END",
            ].join("\n"),
            "utf-8",
          );
          return { status: "success", response: "done" };
        });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(phase.runPhase).toHaveBeenCalledTimes(2);
        expect((phase.runPhase as jest.Mock).mock.calls[1][3]).toMatch(
          /Unterminated review comment block/,
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("fails hard when scope errors remain after a rerun", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-hardfail-"),
      );
      const phase = require("./phase") as typeof import("./phase");
      const draftPath = path.join(tmpWs, ".agent", "pr-review.md");

      const writeBad = () => {
        appendComments(draftPath, [
          "||| COMMENT inline src/f.ts:999",
          "Out of scope.",
          "||| END",
        ]);
      };
      (phase.runPhase as jest.MockedFunction<any>)
        .mockImplementationOnce(async () => {
          writeBad();
          return { status: "success", response: "done" };
        })
        .mockImplementationOnce(async () => {
          writeBad();
          return { status: "success", response: "done" };
        });

      process.argv = ["node", "carl", "pr-review", PR_URL];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpWs);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(phase.runPhase).toHaveBeenCalledTimes(2);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid review comments remain"),
        );
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
