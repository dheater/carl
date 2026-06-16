import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

  describe("interview follow-up", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-follow-up-"));
      fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("keeps interviewing through .agent/notes/duck.md until duck summarizes", async () => {
      const notesPath = path.join(tmpDir, ".agent", "notes", "duck.md");
      const skill = require("./skill") as typeof import("./skill");
      const mockRunSkill = skill.runSkill as jest.MockedFunction<
        typeof skill.runSkill
      >;
      mockRunSkill
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
          response: "# Summary\n\nFound it.",
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

      await expectCliSuccess(["duck", promptFile], tmpDir);

      expect(mockRunSkill).toHaveBeenNthCalledWith(
        1,
        tmpDir,
        "duck",
        "ship it",
        undefined,
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "duck",
        expect.stringContaining("# Original request\n\nship it"),
        undefined,
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(
        2,
        tmpDir,
        "duck",
        expect.stringContaining("1. Option A"),
        undefined,
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(
        3,
        tmpDir,
        "duck",
        expect.stringContaining("1. Option A"),
        undefined,
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(
        3,
        tmpDir,
        "duck",
        expect.stringContaining("2. Option B"),
        undefined,
      );
      expect(mockOpenFileInEditor).toHaveBeenCalledTimes(3);
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
        expect(skill.runSkill).toHaveBeenCalledTimes(1);
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
        expect(skill.runSkill).toHaveBeenCalledTimes(2);
        expect((skill.runSkill as jest.Mock).mock.calls[1][2]).toMatch(
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
        expect(skill.runSkill).toHaveBeenCalledTimes(2);
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
