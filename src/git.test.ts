import { detectGit, getGitStatus } from "./git";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("child_process");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("Git operations", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("detectGit", () => {
    test("returns true when git is available and in a repo", () => {
      mockExecSync.mockReturnValue("true" as any);
      expect(detectGit()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        "git rev-parse --is-inside-work-tree",
        expect.objectContaining({ stdio: "pipe" }),
      );
    });

    test("returns false when git fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git not found");
      });
      expect(detectGit()).toBe(false);
    });
  });

  describe("getGitStatus", () => {
    test("returns no repo when not in git repo", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      const status = getGitStatus("/tmp/test");
      expect(status.isRepo).toBe(false);
      expect(status.trackedChanged).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    test("classifies tracked and untracked files correctly", () => {
      mockExecSync.mockImplementation((cmd: string, opts?: any) => {
        if (cmd.includes("rev-parse")) return "true" as any;
        // Simulated porcelain output
        // M modified, A added, D deleted, ?? untracked
        return " M src/modified.ts\nA  src/new.ts\n?? build/\nD  src/deleted.ts" as any;
      });

      const status = getGitStatus("/tmp/test");
      expect(status.isRepo).toBe(true);
      expect(status.trackedChanged).toContain("src/modified.ts");
      expect(status.trackedChanged).toContain("src/new.ts");
      expect(status.trackedChanged).toContain("src/deleted.ts");
      expect(status.untracked).toContain("build/");
    });

    test("handles empty status", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("rev-parse")) return "true" as any;
        return "" as any;
      });

      const status = getGitStatus("/tmp/test");
      expect(status.isRepo).toBe(true);
      expect(status.trackedChanged).toEqual([]);
      expect(status.untracked).toEqual([]);
    });
  });
});
