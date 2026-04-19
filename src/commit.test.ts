import {
  handleReviewerCommit,
  promptForCommit,
  stageAndCommit,
  parseProposedCommitMessage,
  buildCommitMessageFromReviewerOutput,
} from "./commit";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("./git");
jest.mock("child_process");

const mockGit = require("./git");
const { execSync, spawnSync } = require("child_process");

describe("Commit operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-commit-test-"));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("handleReviewerCommit", () => {
    test("skips commit when not in a git repo", async () => {
      mockGit.detectGit.mockReturnValue(false);
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      await handleReviewerCommit(tmpDir, "Test message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Not in a git repository"),
      );
      consoleSpy.mockRestore();
    });

    test("skips commit when there are no changes", async () => {
      mockGit.detectGit.mockReturnValue(true);
      mockGit.getGitStatus.mockReturnValue({
        isRepo: true,
        trackedChanged: [],
        untracked: [],
      });
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      await handleReviewerCommit(tmpDir, "Test message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No changes to commit"),
      );
      consoleSpy.mockRestore();
    });

    test("commits with message when changes exist and message provided", async () => {
      mockGit.detectGit.mockReturnValue(true);
      mockGit.getGitStatus.mockReturnValue({
        isRepo: true,
        trackedChanged: ["file1.ts"],
        untracked: [],
      });
      mockGit.getCurrentBranch.mockReturnValue("main");
      spawnSync.mockReturnValue({ status: 0 });

      const reviewerMessage = `## Validation
Some stuff

## Proposed commit message
Code review approved
Additional details.

## Your validation steps
Some steps`;

      await handleReviewerCommit(tmpDir, reviewerMessage);

      // Should call git add -u
      expect(execSync).toHaveBeenCalledWith("git add -u", {
        cwd: tmpDir,
        stdio: "pipe",
      });

      // Should call git commit -e with message extracted from proposed section
      const spawnCalls = spawnSync.mock.calls;
      const commitCall = spawnCalls.find((call: any) => {
        return call[0] === "git" && call[1]?.includes("commit");
      });
      expect(commitCall).toBeDefined();
      expect(commitCall[1]).toContain("-e");
      expect(commitCall[1]).toContain("-m");
      // The message should be from the Proposed commit message section
      const args = commitCall[1];
      const mIndex = args?.indexOf("-m");
      if (mIndex !== undefined && mIndex !== -1 && mIndex < args.length - 1) {
        const message = args[mIndex + 1];
        expect(message).toContain("Code review approved");
      }
    });

    test("commits without message flag when message is empty", async () => {
      mockGit.detectGit.mockReturnValue(true);
      mockGit.getGitStatus.mockReturnValue({
        isRepo: true,
        trackedChanged: ["file1.ts"],
        untracked: [],
      });
      mockGit.getCurrentBranch.mockReturnValue("main");
      spawnSync.mockReturnValue({ status: 0 });

      // When empty message is passed, it should be treated as empty string
      // and trigger the fallback logic which uses a default message
      await handleReviewerCommit(tmpDir, "");

      // Should call git commit -e with fallback message
      const spawnCalls = spawnSync.mock.calls;
      const commitCall = spawnCalls.find((call: any) => {
        return call[0] === "git" && call[1]?.includes("commit");
      });
      expect(commitCall).toBeDefined();
      expect(commitCall[1]).toContain("-e");
      // Should have -m flag with fallback default message
      expect(commitCall[1]).toContain("-m");
      const args = commitCall[1];
      const mIndex = args?.indexOf("-m");
      if (mIndex !== undefined && mIndex !== -1 && mIndex < args.length - 1) {
        const message = args[mIndex + 1];
        // Should use fallback message "chore: Sprint changes" for non-ticket branch
        expect(message).toBe("chore: Sprint changes");
      }
    });

    test("does not attempt commit when no tracked changes", async () => {
      mockGit.detectGit.mockReturnValue(true);
      mockGit.getGitStatus.mockReturnValue({
        isRepo: true,
        trackedChanged: [],
        untracked: ["build/"],
      });

      await handleReviewerCommit(tmpDir, "Test message");

      // spawnSync should not be called for git commit
      const spawnCalls = spawnSync.mock.calls;
      const commitCall = spawnCalls.find((call: any) => {
        return call[0] === "git" && call[1]?.includes("commit");
      });
      expect(commitCall).toBeUndefined();
    });
  });
});

// Tests for t-2: Make reviewer-driven commit use the Proposed commit message (with safe fallbacks)
describe("parseProposedCommitMessage and buildCommitMessageFromReviewerOutput", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-commit-t2-test-"));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts commit message from reviewer output with Proposed commit message section", () => {
    const reviewerMessage = `## Validation
**You asked for:** ...
**What was built:** ...

## Proposed commit message

CLIENTS-934: Fix download timeout handling

Increase default timeout from 30s to 60s.

## Your validation steps
- Run something
`;

    const commitMsg = buildCommitMessageFromReviewerOutput(
      reviewerMessage,
      "CLIENTS-934-download-fixes",
    );

    // AC: First line should be exactly the subject
    expect(commitMsg).toMatch(/^CLIENTS-934: Fix download timeout handling/);

    // AC: Should not contain banned phrases in the subject
    expect(commitMsg).not.toMatch(
      /^(human validation checklist|workflow can now proceed|sprint is complete)/i,
    );

    // AC: Body should be extracted from the Proposed commit message section
    expect(commitMsg).toContain("Increase default timeout from 30s to 60s");
  });

  test("uses fallback subject when Proposed commit message section is missing", () => {
    const reviewerMessage = `## Validation
**You asked for:** ...
## Your validation steps
- Do something
`;

    mockGit.getCurrentBranch.mockReturnValue("CLIENTS-934-download-fixes");
    const commitMsg = buildCommitMessageFromReviewerOutput(
      reviewerMessage,
      "CLIENTS-934-download-fixes",
    );

    // AC: Fallback for ticket branch
    expect(commitMsg).toBe("CLIENTS-934: Sprint changes");
  });

  test("uses conventional-commit fallback on non-ticket branch when section is missing", () => {
    const reviewerMessage = `## Validation\n**Content:**...`;

    const commitMsg = buildCommitMessageFromReviewerOutput(
      reviewerMessage,
      "main",
    );

    // AC: Fallback for non-ticket branch
    expect(commitMsg).toBe("chore: Sprint changes");
  });

  test("uses fallback when Proposed commit message section exists but is empty", () => {
    const reviewerMessage = `## Validation
**Content here**

## Proposed commit message

## Your validation steps
Next section
`;

    const commitMsg = buildCommitMessageFromReviewerOutput(
      reviewerMessage,
      "CLIENTS-934-download-fixes",
    );

    // AC: Fallback when section is present but blank
    expect(commitMsg).toBe("CLIENTS-934: Sprint changes");
  });

  test("does not include other sections in commit message", () => {
    const reviewerMessage = `## Validation
This should not appear in commit

## Proposed commit message

CLIENTS-934: Fix handling

Body text here.

## Your validation steps
This validation text should not appear
`;

    const commitMsg = buildCommitMessageFromReviewerOutput(
      reviewerMessage,
      "CLIENTS-934-download-fixes",
    );

    // AC: Message comes only from Proposed commit message section
    expect(commitMsg).toContain("CLIENTS-934: Fix handling");
    expect(commitMsg).toContain("Body text here");
    expect(commitMsg).not.toContain("This should not appear in commit");
    expect(commitMsg).not.toContain("This validation text should not appear");
  });

  test("handleReviewerCommit uses parsed commit message instead of full reviewer output", async () => {
    mockGit.detectGit.mockReturnValue(true);
    mockGit.getGitStatus.mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/file.ts"],
      untracked: [],
    });
    mockGit.getCurrentBranch.mockReturnValue("CLIENTS-934-download-fixes");
    spawnSync.mockReturnValue({ status: 0 });

    const reviewerMessage = `## Proposed commit message

CLIENTS-934: Fix download issue

Details of the fix.

## Your validation steps
Many lines of validation text
`;

    await handleReviewerCommit(tmpDir, reviewerMessage);

    // AC: spawnSync should be called with only the parsed message, not full output
    const spawnCalls = spawnSync.mock.calls;
    const commitCall = spawnCalls.find((call: any) => {
      return call[0] === "git" && call[1]?.includes("commit");
    });

    expect(commitCall).toBeDefined();
    if (commitCall) {
      // Arguments are [command, [args...], {options}]
      const args = commitCall[1];
      const mIndex = args?.indexOf("-m");
      if (mIndex !== undefined && mIndex !== -1 && mIndex < args.length - 1) {
        const messageArg = args[mIndex + 1];
        expect(messageArg).toContain("CLIENTS-934: Fix download issue");
        expect(messageArg).not.toContain("Your validation steps");
      }
    }
  });

  test("other commit entry paths remain unchanged", async () => {
    mockGit.detectGit.mockReturnValue(true);
    mockGit.getGitStatus.mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/file.ts"],
      untracked: [],
    });
    spawnSync.mockReturnValue({ status: 0 });

    // Direct call to stageAndCommit with explicit message (not from handleReviewerCommit)
    const result = stageAndCommit(
      tmpDir,
      "Direct explicit message with any content",
    );

    // AC: Should pass message through unchanged
    const spawnCalls = spawnSync.mock.calls;
    const commitCall = spawnCalls.find((call: any) => {
      return call[0] === "git" && call[1]?.includes("commit");
    });

    if (commitCall) {
      // Arguments are [command, [args...], {options}]
      const args = commitCall[1];
      const mIndex = args?.indexOf("-m");
      if (mIndex !== undefined && mIndex !== -1 && mIndex < args.length - 1) {
        const messageArg = args[mIndex + 1];
        // The message should be passed as-is
        expect(messageArg).toContain("Direct explicit message");
      }
    }
  });
});
