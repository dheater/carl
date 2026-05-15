import {
  detectGit,
  getGitStatus,
  getCurrentBranch,
  getHeadSha,
} from "./git";
import { execSync } from "child_process";

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

  describe("getCurrentBranch", () => {
    test("returns branch name when in a git repo", () => {
      mockExecSync.mockReturnValue("main\n" as any);
      expect(getCurrentBranch("/tmp/test")).toBe("main");
      expect(mockExecSync).toHaveBeenCalledWith(
        "git rev-parse --abbrev-ref HEAD",
        expect.objectContaining({ cwd: "/tmp/test", stdio: "pipe" }),
      );
    });

    test("returns null when git fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      expect(getCurrentBranch("/tmp/test")).toBeNull();
    });
  });

  describe("getHeadSha", () => {
    test("returns trimmed sha", () => {
      mockExecSync.mockReturnValue("abc1234deadbeef\n" as any);
      expect(getHeadSha("/ws")).toBe("abc1234deadbeef");
      expect(mockExecSync).toHaveBeenCalledWith(
        "git rev-parse HEAD",
        expect.objectContaining({ cwd: "/ws", stdio: "pipe" }),
      );
    });

    test("throws when git fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("fatal: not a git repository");
      });
      expect(() => getHeadSha("/ws")).toThrow(/Could not resolve HEAD/);
    });
  });
});
