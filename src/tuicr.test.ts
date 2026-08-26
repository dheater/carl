jest.mock("child_process", () => ({
  execFileSync: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

import { execFileSync } from "child_process";
import { buildAddCommentPayload, findPrSession } from "./tuicr";

const mockExecFileSync = execFileSync as jest.MockedFunction<
  typeof execFileSync
>;

describe("buildAddCommentPayload", () => {
  test("maps a single-line inline comment to a new-side line comment", () => {
    expect(
      buildAddCommentPayload({
        type: "inline",
        path: "src/f.ts",
        line: 12,
        body: "Nulls reach here.",
      }),
    ).toEqual({
      content: "Nulls reach here.",
      file: "src/f.ts",
      side: "new",
      line: 12,
    });
  });

  test("maps a range to start_line/end_line, not line", () => {
    expect(
      buildAddCommentPayload({
        type: "inline",
        path: "src/f.ts",
        startLine: 10,
        line: 14,
        body: "This loop repeats the block above.",
      }),
    ).toEqual({
      content: "This loop repeats the block above.",
      file: "src/f.ts",
      side: "new",
      start_line: 10,
      end_line: 14,
    });
  });

  test("maps an overall comment to a review-level comment with no target", () => {
    expect(
      buildAddCommentPayload({ type: "overall", body: "Looks good overall." }),
    ).toEqual({ content: "Looks good overall." });
  });
});

describe("findPrSession", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  test("picks the PR session for this number and ignores others", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([
        { slug: "owner/repo@main/worktree", kind: "local" },
        { slug: "gh:Owner/Repo/pr/420", kind: "pr" },
        { slug: "gh:Owner/Repo/pr/42", kind: "pr" },
      ]) as any,
    );

    expect(findPrSession("/ws", 42)).toBe("gh:Owner/Repo/pr/42");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tuicr",
      ["review", "list", "--repo", "/ws"],
      expect.any(Object),
    );
  });

  test("returns null while the session does not exist yet", () => {
    mockExecFileSync.mockReturnValue("[]" as any);
    expect(findPrSession("/ws", 42)).toBeNull();
  });

  test("explains itself when tuicr prints something that is not JSON", () => {
    mockExecFileSync.mockReturnValue("tuicr: unknown subcommand\n" as any);
    expect(() => findPrSession("/ws", 42)).toThrow(/not JSON|as JSON/);
  });
});
