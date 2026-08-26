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
  checkGhCli: jest.fn(),
  fetchPrMetadata: jest.fn().mockReturnValue({
    number: 42,
    headSha: "abc1234",
    url: "https://github.com/owner/repo/pull/42",
  }),
  fetchPrDiff: jest.fn().mockReturnValue(SAMPLE_DIFF),
}));

jest.mock("./tuicr", () => ({
  checkTuicrCli: jest.fn(),
  openPrReviewInTuicr: jest.fn().mockResolvedValue(undefined),
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
    runSkillWithValidation: jest.fn(),
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
  let configDir: string;

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
    const skill = require("./skill") as typeof import("./skill");
    (skill.runSkill as jest.MockedFunction<any>).mockResolvedValue({
      response: "done",
      runId: "run-1",
    });
    (
      skill.runSkillWithValidation as jest.MockedFunction<any>
    ).mockResolvedValue({ response: "done", runId: "run-1" });
    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prompt-"));
    promptFile = path.join(promptDir, "prompt.md");
    fs.writeFileSync(promptFile, "ship it\n", "utf-8");
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-cli-config-"));
    process.env.CARL_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ models: { code: "sonnet4.6" } }),
      "utf-8",
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
    delete process.env.CARL_CONFIG_DIR;
    if (fs.existsSync(promptDir)) {
      fs.rmSync(promptDir, { recursive: true, force: true });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, { recursive: true, force: true });
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

  describe("code", () => {
    test("runs the code skill with prompt from file", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-code-cli-"));
      const skill = require("./skill") as typeof import("./skill");

      try {
        await expectCliSuccess(["code", promptFile], tmpDir);
        expect(skill.runSkillWithValidation).toHaveBeenCalledWith(
          tmpDir,
          "code",
          "ship it",
          skill.DEFAULT_MODELS.code,
          skill.DEFAULT_EFFORTS.code,
          expect.any(Object),
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
        expect(skill.runSkillWithValidation).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("passes the configured validation contract through to the skill", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-code-val-"));
      const skill = require("./skill") as typeof import("./skill");
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ validate: "npm test", maxRetries: 3 }),
        "utf-8",
      );

      try {
        await expectCliSuccess(["code", promptFile], tmpDir);
        expect(skill.runSkillWithValidation).toHaveBeenCalledWith(
          tmpDir,
          "code",
          "ship it",
          skill.DEFAULT_MODELS.code,
          skill.DEFAULT_EFFORTS.code,
          expect.any(Object),
          { command: "npm test", maxRetries: 3 },
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("exits non-zero and prints the failure when validation never passes", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-code-fail-"));
      const skill = require("./skill") as typeof import("./skill");
      (
        skill.runSkillWithValidation as jest.MockedFunction<any>
      ).mockResolvedValue({
        response: "done",
        runId: "run-1",
        validation: {
          ok: false,
          runs: 2,
          stopped: "budget",
          result: {
            command: "npm test",
            ok: false,
            exitCode: 1,
            timedOut: false,
            output: "1 test failed: expected 2, got 3",
            durationMs: 1200,
          },
        },
      });

      process.argv = ["node", "carl", "code", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const originalExitCode = process.exitCode;

      try {
        await runLoadedCli();
        expect(process.exitCode).toBe(1);
        const printed = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).toContain("Validation is still failing after 2 runs");
        expect(printed).toContain("npm test");
        // The human never saw the suite's own output, so carl has to show it.
        expect(printed).toContain("expected 2, got 3");
      } finally {
        process.exitCode = originalExitCode;
        cwdSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("says raising maxRetries will not help a stalled run", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-code-stall-"));
      const skill = require("./skill") as typeof import("./skill");
      (
        skill.runSkillWithValidation as jest.MockedFunction<any>
      ).mockResolvedValue({
        response: "done",
        runId: "run-1",
        validation: {
          ok: false,
          runs: 2,
          stopped: "stalled",
          result: {
            command: "npm test",
            ok: false,
            exitCode: 1,
            timedOut: false,
            output: "1 test failed",
            durationMs: 1200,
          },
        },
      });

      process.argv = ["node", "carl", "code", promptFile];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const originalExitCode = process.exitCode;

      try {
        await runLoadedCli();
        expect(process.exitCode).toBe(1);
        const printed = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).toContain("the last session changed no files");
        // Offering more budget here would be advice that cannot work.
        expect(printed).not.toContain("maxRetries");
      } finally {
        process.exitCode = originalExitCode;
        cwdSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("ask", () => {
    test("runs the ask skill and never validates", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-ask-cli-"));
      const skill = require("./skill") as typeof import("./skill");
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ validate: "npm test" }),
        "utf-8",
      );

      try {
        await expectCliSuccess(["ask", promptFile], tmpDir);
        expect(skill.runSkill).toHaveBeenCalledWith(
          tmpDir,
          "ask",
          "ship it",
          skill.DEFAULT_MODELS.ask,
          skill.DEFAULT_EFFORTS.ask,
          expect.any(Object),
        );
        // A configured `validate` is about changed files, and ask changes none.
        expect(skill.runSkillWithValidation).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("cancels without a session when the editor prompt is blank", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-ask-cancel-"));
      const editor = require("./editor") as typeof import("./editor");
      const skill = require("./skill") as typeof import("./skill");
      (
        editor.collectPrompt as jest.MockedFunction<typeof editor.collectPrompt>
      ).mockReturnValueOnce(null);

      try {
        await expectCliSuccess(["ask"], tmpDir);
        expect(skill.runSkill).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("plan", () => {
    test("runs the plan skill and says how to implement the plan", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-plan-cli-"));
      const skill = require("./skill") as typeof import("./skill");
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        process.argv = ["node", "carl", "plan", promptFile];
        const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
        try {
          await runLoadedCli();
        } finally {
          cwdSpy.mockRestore();
        }

        expect(skill.runSkill).toHaveBeenCalledWith(
          tmpDir,
          "plan",
          "ship it",
          skill.DEFAULT_MODELS.plan,
          skill.DEFAULT_EFFORTS.plan,
          expect.any(Object),
        );
        // The plan is worthless if the human does not know what consumes it.
        const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).toContain(".agent/notes/plan.md");
        expect(printed).toContain("carl code --plan");
      } finally {
        logSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("says nothing about implementing when the prompt was blank", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "carl-plan-cancel-"),
      );
      const editor = require("./editor") as typeof import("./editor");
      const skill = require("./skill") as typeof import("./skill");
      (
        editor.collectPrompt as jest.MockedFunction<typeof editor.collectPrompt>
      ).mockReturnValueOnce(null);
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        process.argv = ["node", "carl", "plan"];
        const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
        try {
          await runLoadedCli();
        } finally {
          cwdSpy.mockRestore();
        }

        expect(skill.runSkill).not.toHaveBeenCalled();
        const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).not.toContain("carl code --plan");
      } finally {
        logSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("code --plan", () => {
    test("implements the saved plan, verbatim, as the prompt", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-fromplan-"));
      const skill = require("./skill") as typeof import("./skill");
      const planPath = path.join(tmpDir, ".agent/notes/plan.md");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      // Including the human's edits: the file is the handoff, not the response
      // the plan session happened to return.
      fs.writeFileSync(planPath, "# Plan\n\nStep 1: do it.\n", "utf-8");

      try {
        await expectCliSuccess(["code", "--plan"], tmpDir);
        expect(skill.runSkillWithValidation).toHaveBeenCalledWith(
          tmpDir,
          "code",
          "# Plan\n\nStep 1: do it.",
          skill.DEFAULT_MODELS.code,
          skill.DEFAULT_EFFORTS.code,
          expect.any(Object),
          undefined,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("names the command that writes a plan when there is none", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-noplan-"));
      const skill = require("./skill") as typeof import("./skill");
      process.argv = ["node", "carl", "code", "--plan"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(skill.runSkillWithValidation).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        const printed = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).toContain(".agent/notes/plan.md");
        expect(printed).toContain("carl plan");
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("feedback", () => {
    test("runs the feedback skill on a pasted review, and validates the result", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-feedback-"));
      const skill = require("./skill") as typeof import("./skill");
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ validate: "npm test", maxRetries: 3 }),
        "utf-8",
      );

      try {
        await expectCliSuccess(["feedback", promptFile], tmpDir);
        // Applying a comment edits code, so the check command decides whether it
        // worked — the same contract `carl code` gets.
        expect(skill.runSkillWithValidation).toHaveBeenCalledWith(
          tmpDir,
          "feedback",
          "ship it",
          skill.DEFAULT_MODELS.feedback,
          skill.DEFAULT_EFFORTS.feedback,
          expect.any(Object),
          { command: "npm test", maxRetries: 3 },
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("--review assesses the saved review notes, edits included", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-fb-review-"));
      const skill = require("./skill") as typeof import("./skill");
      const reviewPath = path.join(tmpDir, ".agent/notes/review.md");
      fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
      fs.writeFileSync(reviewPath, "1. src/a.ts:3 — delete this\n", "utf-8");

      try {
        await expectCliSuccess(["feedback", "--review"], tmpDir);
        expect(skill.runSkillWithValidation).toHaveBeenCalledWith(
          tmpDir,
          "feedback",
          "1. src/a.ts:3 — delete this",
          skill.DEFAULT_MODELS.feedback,
          skill.DEFAULT_EFFORTS.feedback,
          expect.any(Object),
          undefined,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("names the command that writes a review when there is none", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-fb-none-"));
      const skill = require("./skill") as typeof import("./skill");
      process.argv = ["node", "carl", "feedback", "--review"];
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
      const exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(skill.runSkillWithValidation).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        const printed = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(printed).toContain(".agent/notes/review.md");
        expect(printed).toContain("carl review");
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("pr-review", () => {
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

    test("seeds .agent/notes/pr-review.md with PR identity, invokes pr-review, and opens the comments in tuicr", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-rev-seed-"));
      const skill = require("./skill") as typeof import("./skill");
      const draftPath = path.join(tmpWs, ".agent/notes", "pr-review.md");

      (skill.runSkill as jest.MockedFunction<any>).mockImplementationOnce(
        async () => {
          writeValidComment(draftPath);
          return { response: "done" };
        },
      );

      const tuicr = require("./tuicr") as typeof import("./tuicr");

      process.argv = ["node", "carl", "pr-review", "42"];
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
          skill.DEFAULT_MODELS["pr-review"],
          skill.DEFAULT_EFFORTS["pr-review"],
          expect.any(Object),
        );
        const draft = fs.readFileSync(draftPath, "utf-8");
        expect(draft).toContain("## PR Diff");
        expect(draft).toContain("## Review comments");
        expect(draft).toContain("+added line");
        expect(draft).toContain("PR: https://github.com/owner/repo/pull/42");
        expect(tuicr.openPrReviewInTuicr).toHaveBeenCalledWith(
          tmpWs,
          42,
          expect.arrayContaining([
            expect.objectContaining({
              type: "inline",
              path: "src/f.ts",
              line: 2,
            }),
          ]),
          `carl (${skill.DEFAULT_MODELS["pr-review"]})`,
        );
      } finally {
        cwdSpy.mockRestore();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    test("reruns the skill once when scope errors are found, then opens tuicr", async () => {
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
          return { response: "done" };
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
          return { response: "done" };
        });

      process.argv = ["node", "carl", "pr-review", "42"];
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
          return { response: "done" };
        })
        .mockImplementationOnce(async () => {
          writeBad();
          return { response: "done" };
        });

      process.argv = ["node", "carl", "pr-review", "42"];
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

    test("rejects the old PR-URL form with the number-based usage", async () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-rev-url-"));
      const skill = require("./skill") as typeof import("./skill");
      const tuicr = require("./tuicr") as typeof import("./tuicr");

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
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      try {
        await runLoadedCli();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("carl pr-review <pr-number>"),
        );
        expect(skill.runSkill).not.toHaveBeenCalled();
        expect(tuicr.openPrReviewInTuicr).not.toHaveBeenCalled();
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
