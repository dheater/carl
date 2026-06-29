import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

jest.mock("./skill", () => {
  const actual = jest.requireActual("./skill") as typeof import("./skill");
  return {
    ...actual,
    runSkill: jest.fn(),
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

  describe("chat", () => {
    test("cancels without calling auggie when the editor prompt is blank", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-chat-cancel-"),
      );
      const editor = require("./editor") as typeof import("./editor");
      (
        editor.collectPrompt as jest.MockedFunction<typeof editor.collectPrompt>
      ).mockReturnValueOnce(null);

      const childProcess =
        require("child_process") as typeof import("child_process");
      const mockSpawnSync = childProcess.spawnSync as jest.MockedFunction<
        typeof childProcess.spawnSync
      >;

      try {
        await expectCliSuccess(["chat"], tmpDir);
        expect(mockSpawnSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test.each([
      [
        "auggie not on PATH",
        { error: new Error("spawn auggie ENOENT"), status: null, signal: null },
        "auggie",
      ],
      [
        "auggie exits via signal",
        { status: null, signal: "SIGTERM" },
        "SIGTERM",
      ],
      [
        "auggie exits with non-zero status",
        { status: 2, signal: null },
        "status 2",
      ],
    ])(
      "exits with error when %s",
      async (_label, mockResult, expectedMessage) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-chat-err-"));
        const childProcess =
          require("child_process") as typeof import("child_process");
        (
          childProcess.spawnSync as jest.MockedFunction<
            typeof childProcess.spawnSync
          >
        ).mockReturnValueOnce(mockResult as any);

        process.argv = ["node", "carl", "chat", path.join(tmpDir, "p.md")];
        fs.writeFileSync(path.join(tmpDir, "p.md"), "hello\n", "utf-8");
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
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining(expectedMessage as string),
          );
        } finally {
          cwdSpy.mockRestore();
          exitSpy.mockRestore();
          errorSpy.mockRestore();
          logSpy.mockRestore();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );
  });

  describe("code", () => {
    test("runs the code skill with prompt from file", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-code-cli-"));
      const skill = require("./skill") as typeof import("./skill");

      try {
        await expectCliSuccess(["code", promptFile], tmpDir);
        expect(skill.runSkill).toHaveBeenCalledWith(
          tmpDir,
          "code",
          "ship it",
          undefined,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("cancels without running code when the editor prompt is blank", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-code-cancel-"),
      );
      const editor = require("./editor") as typeof import("./editor");
      const skill = require("./skill") as typeof import("./skill");
      (
        editor.collectPrompt as jest.MockedFunction<typeof editor.collectPrompt>
      ).mockReturnValueOnce(null);

      try {
        await expectCliSuccess(["code"], tmpDir);
        expect(skill.runSkill).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
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

    test("seeds .agent/notes/pr-review.md with PR identity, invokes pr-review, and creates pending review", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-rev-seed-"));
      const skill = require("./skill") as typeof import("./skill");
      const draftPath = path.join(tmpWs, ".agent/notes", "pr-review.md");

      (skill.runSkill as jest.MockedFunction<any>).mockImplementationOnce(
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
        expect(skill.runSkill).toHaveBeenCalledWith(
          tmpWs,
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

    test("reruns the skill once when scope errors are found, then creates review", async () => {
      const tmpWs = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-pr-rev-rerun-"),
      );
      const skill = require("./skill") as typeof import("./skill");
      const draftPath = path.join(tmpWs, ".agent/notes", "pr-review.md");

      (skill.runSkill as jest.MockedFunction<any>)
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
      const skill = require("./skill") as typeof import("./skill");
      const draftPath = path.join(tmpWs, ".agent/notes", "pr-review.md");

      const writeBad = () => {
        appendComments(draftPath, [
          "||| COMMENT inline src/f.ts:999",
          "Out of scope.",
          "||| END",
        ]);
      };
      (skill.runSkill as jest.MockedFunction<any>)
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
