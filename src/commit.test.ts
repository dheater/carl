import {
  handleReviewerCommit,
  promptForCommit,
  stageAndCommit,
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
      spawnSync.mockReturnValue({ status: 0 });

      await handleReviewerCommit(tmpDir, "Code review approved");

      // Should call git add -u
      expect(execSync).toHaveBeenCalledWith("git add -u", {
        cwd: tmpDir,
        stdio: "pipe",
      });

      // Should call git commit -e with message
      const spawnCalls = spawnSync.mock.calls;
      const commitCall = spawnCalls.find((call: any) => {
        return call[0] === "git" && call[1]?.includes("commit");
      });
      expect(commitCall).toBeDefined();
      expect(commitCall[1]).toContain("-e");
      expect(commitCall[1]).toContain("-m");
      expect(commitCall[1]).toContain("Code review approved");
    });

    test("commits without message flag when message is empty", async () => {
      mockGit.detectGit.mockReturnValue(true);
      mockGit.getGitStatus.mockReturnValue({
        isRepo: true,
        trackedChanged: ["file1.ts"],
        untracked: [],
      });
      spawnSync.mockReturnValue({ status: 0 });

      await handleReviewerCommit(tmpDir, "");

      // Should call git commit -e without -m flag
      const spawnCalls = spawnSync.mock.calls;
      const commitCall = spawnCalls.find((call: any) => {
        return call[0] === "git" && call[1]?.includes("commit");
      });
      expect(commitCall).toBeDefined();
      expect(commitCall[1]).toContain("-e");
      // Should NOT have -m flag for empty message
      const argString = commitCall[1].join(" ");
      const mIndex = argString.indexOf(" -m ");
      expect(mIndex).toBe(-1);
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
