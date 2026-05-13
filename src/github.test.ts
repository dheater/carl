import {
  parsePrUrl,
  checkGhCli,
  checkRepoMatch,
  fetchPrMetadata,
  fetchPrDiff,
  fetchPrHeadSha,
  submitPrReview,
} from "./github";
import {
  parsePrReviewOutput,
  parsePrReviewDraft,
  buildPrReviewDraft,
  getPrReviewDraftPath,
  getPrReviewPayloadPath,
} from "./pr-review-draft";
import { execSync } from "child_process";

jest.mock("child_process");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

afterEach(() => jest.clearAllMocks());

describe("parsePrUrl", () => {
  test("parses a standard GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/42");
    expect(result).toEqual({ owner: "owner", repo: "repo", number: 42 });
  });

  test("parses a URL with a trailing slash", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/42/");
    expect(result).toEqual({ owner: "owner", repo: "repo", number: 42 });
  });

  test("parses a URL with hyphens and dots in owner/repo names", () => {
    const result = parsePrUrl(
      "https://github.com/my-org/my.repo/pull/100",
    );
    expect(result).toEqual({ owner: "my-org", repo: "my.repo", number: 100 });
  });

  test("throws on a non-PR GitHub URL", () => {
    expect(() => parsePrUrl("https://github.com/owner/repo")).toThrow(
      /Invalid GitHub PR URL/,
    );
  });

  test("throws on an entirely wrong URL", () => {
    expect(() => parsePrUrl("https://gitlab.com/owner/repo/merge_requests/1")).toThrow(
      /Invalid GitHub PR URL/,
    );
  });
});

describe("checkGhCli", () => {
  test("does not throw when gh is installed", () => {
    mockExecSync.mockReturnValue("gh version 2.0.0\n" as any);
    expect(() => checkGhCli()).not.toThrow();
  });

  test("throws a helpful message when gh is missing", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found: gh");
    });
    expect(() => checkGhCli()).toThrow(/gh CLI is not installed/);
    expect(() => checkGhCli()).toThrow(/gh auth login/);
  });
});

describe("checkRepoMatch", () => {
  test("passes when an HTTPS remote matches", () => {
    mockExecSync.mockReturnValue(
      "origin\thttps://github.com/owner/repo.git (fetch)\n" as any,
    );
    expect(() => checkRepoMatch("/ws", "owner", "repo")).not.toThrow();
  });

  test("passes when an SSH remote matches", () => {
    mockExecSync.mockReturnValue(
      "origin\tgit@github.com:owner/repo.git (fetch)\n" as any,
    );
    expect(() => checkRepoMatch("/ws", "owner", "repo")).not.toThrow();
  });

  test("matching is case-insensitive", () => {
    mockExecSync.mockReturnValue(
      "origin\thttps://github.com/Owner/Repo.git (fetch)\n" as any,
    );
    expect(() => checkRepoMatch("/ws", "owner", "repo")).not.toThrow();
  });

  test("throws when no remote matches the PR repo", () => {
    mockExecSync.mockReturnValue(
      "origin\thttps://github.com/other/project.git (fetch)\n" as any,
    );
    expect(() => checkRepoMatch("/ws", "owner", "repo")).toThrow(
      /does not match PR repo owner\/repo/,
    );
  });

  test("throws when git remote fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    expect(() => checkRepoMatch("/ws", "owner", "repo")).toThrow(
      /Could not read git remotes/,
    );
  });
});

describe("fetchPrMetadata", () => {
  const prPayload = {
    number: 42,
    title: "Fix the bug",
    body: "Fixes #1",
    state: "open",
    head: { sha: "abc1234", ref: "fix-bug" },
    base: { sha: "def5678", ref: "main" },
  };

  const commitsPayload = [
    {
      sha: "abc1234",
      commit: { message: "Fix the bug", author: { name: "Alice" } },
      author: { login: "alice" },
    },
  ];

  test("returns structured metadata on success", () => {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(prPayload) as any)
      .mockReturnValueOnce(JSON.stringify(commitsPayload) as any);

    const meta = fetchPrMetadata("owner", "repo", 42);

    expect(meta.number).toBe(42);
    expect(meta.title).toBe("Fix the bug");
    expect(meta.headSha).toBe("abc1234");
    expect(meta.baseRef).toBe("main");
    expect(meta.commits).toHaveLength(1);
    expect(meta.commits[0].author).toBe("Alice");
  });

  test("throws a not-found error on 404", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 404: Not Found";
    mockExecSync.mockImplementation(() => { throw err; });

    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/not found/i);
    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/gh auth status/);
  });

  test("throws an auth error on 401", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 401: Must be authenticated";
    mockExecSync.mockImplementation(() => { throw err; });

    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/Not authorized/);
    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/gh auth login/);
  });
});

describe("fetchPrDiff", () => {
  test("returns diff text on success", () => {
    mockExecSync.mockReturnValue("diff --git a/foo.ts b/foo.ts\n" as any);
    const diff = fetchPrDiff("owner", "repo", 42);
    expect(diff).toContain("diff --git");
  });

  test("throws with context on failure", () => {
    mockExecSync.mockImplementation(() => { throw new Error("network error"); });
    expect(() => fetchPrDiff("owner", "repo", 42)).toThrow(
      /Failed to fetch diff for owner\/repo#42/,
    );
  });
});


describe("parsePrReviewOutput", () => {
  const sampleOutput = `
## Summary

The PR is mostly clean. One dead variable.

## Issues

### [Dead] src/foo.ts line 42

Variable \`x\` is declared but never used. Delete it.

### [Correctness] src/bar.ts file-level

Missing null check before dereferencing \`result\`.

### [Complexity] overall

The helper functions could be unified.
`.trim();

  test("extracts summary as overall comment", () => {
    const comments = parsePrReviewOutput(sampleOutput);
    const overall = comments.filter((c) => c.type === "overall");
    expect(overall.length).toBeGreaterThanOrEqual(1);
    expect(overall[0].body).toMatch(/The PR is mostly clean/);
  });

  test("extracts inline comment with path and line", () => {
    const comments = parsePrReviewOutput(sampleOutput);
    const inline = comments.find((c) => c.type === "inline");
    expect(inline).toBeDefined();
    expect(inline!.path).toBe("src/foo.ts");
    expect(inline!.line).toBe(42);
    expect(inline!.body).toMatch(/never used/);
  });

  test("extracts file-level comment", () => {
    const comments = parsePrReviewOutput(sampleOutput);
    const file = comments.find((c) => c.type === "file");
    expect(file).toBeDefined();
    expect(file!.path).toBe("src/bar.ts");
    expect(file!.body).toMatch(/null check/);
  });

  test("returns a summary comment when no issues are present", () => {
    const comments = parsePrReviewOutput("## Summary\n\nNo issues found.");
    expect(comments).toHaveLength(1);
    expect(comments[0].type).toBe("overall");
  });

  test("ignores issues with empty bodies", () => {
    const output = "### [Dead] src/foo.ts line 1\n\n### [Dead] src/bar.ts line 2\n\nReal comment.";
    const comments = parsePrReviewOutput(output);
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe("src/bar.ts");
  });
});

describe("parsePrReviewDraft", () => {
  test("parses a single overall comment block", () => {
    const draft = "||| COMMENT overall\nThis is my review.\n||| END";
    const comments = parsePrReviewDraft(draft);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({ type: "overall", body: "This is my review." });
  });

  test("parses inline comment with path and line", () => {
    const draft = "||| COMMENT inline src/foo.ts:42\nDead code here.\n||| END";
    const comments = parsePrReviewDraft(draft);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      type: "inline",
      path: "src/foo.ts",
      line: 42,
      body: "Dead code here.",
    });
  });

  test("parses file-level comment", () => {
    const draft = "||| COMMENT file src/bar.ts\nMissing error handling.\n||| END";
    const comments = parsePrReviewDraft(draft);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      type: "file",
      path: "src/bar.ts",
      body: "Missing error handling.",
    });
  });

  test("ignores empty comment bodies", () => {
    const draft = "||| COMMENT overall\n   \n||| END";
    expect(parsePrReviewDraft(draft)).toHaveLength(0);
  });

  test("ignores header lines and non-block content", () => {
    const draft = "# This is a header\nSome diff line\n||| COMMENT overall\nReal comment.\n||| END\n+diff line";
    const comments = parsePrReviewDraft(draft);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Real comment.");
  });

  test("parses multiple blocks", () => {
    const draft = [
      "||| COMMENT overall",
      "Overall note.",
      "||| END",
      "||| COMMENT inline src/a.ts:10",
      "Inline note.",
      "||| END",
    ].join("\n");
    const comments = parsePrReviewDraft(draft);
    expect(comments).toHaveLength(2);
    expect(comments[0].type).toBe("overall");
    expect(comments[1].type).toBe("inline");
  });
});

describe("buildPrReviewDraft", () => {
  const metadata = {
    number: 7,
    title: "Add feature",
    headSha: "abc12345def",
    baseSha: "000",
    baseRef: "main",
    headRef: "feat",
    state: "open",
    commits: [],
    body: "",
  };

  const simpleDiff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 000..111 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,2 +1,3 @@",
    " line1",
    "+added",
    " line2",
  ].join("\n");

  test("inserts overall comment block before diff", () => {
    const comments = [{ type: "overall" as const, body: "General concern." }];
    const draft = buildPrReviewDraft(simpleDiff, comments, metadata, "owner", "repo");
    const diffIdx = draft.indexOf("diff --git");
    const overallIdx = draft.indexOf("||| COMMENT overall");
    expect(overallIdx).toBeGreaterThan(-1);
    expect(overallIdx).toBeLessThan(diffIdx);
  });

  test("inserts inline comment after matching diff line", () => {
    const comments = [{ type: "inline" as const, path: "src/foo.ts", line: 2, body: "Issue on added line." }];
    const draft = buildPrReviewDraft(simpleDiff, comments, metadata, "owner", "repo");
    const addedLineIdx = draft.indexOf("+added");
    const commentIdx = draft.indexOf("||| COMMENT inline src/foo.ts:2");
    expect(commentIdx).toBeGreaterThan(addedLineIdx);
  });

  test("appends file-level comment after file diff section", () => {
    const comments = [{ type: "file" as const, path: "src/foo.ts", body: "File-level note." }];
    const draft = buildPrReviewDraft(simpleDiff, comments, metadata, "owner", "repo");
    expect(draft).toContain("||| COMMENT file src/foo.ts");
    expect(draft).toContain("File-level note.");
  });

  test("preserves unmatched inline comments instead of dropping them", () => {
    const comments = [
      {
        type: "inline" as const,
        path: "src/missing.ts",
        line: 99,
        body: "Still needs review.",
      },
    ];
    const draft = buildPrReviewDraft(simpleDiff, comments, metadata, "owner", "repo");
    expect(draft).toContain("||| COMMENT inline src/missing.ts:99");
    expect(draft).toContain("Still needs review.");
  });
});

describe("getPrReviewDraftPath / getPrReviewPayloadPath", () => {
  test("draft path is stable and under .agent/", () => {
    const p = getPrReviewDraftPath("/ws", "owner", "repo", 42);
    expect(p).toBe("/ws/.agent/pr-review-owner-repo-42.md");
  });

  test("payload path is stable and under .agent/", () => {
    const p = getPrReviewPayloadPath("/ws", "owner", "repo", 42);
    expect(p).toBe("/ws/.agent/pr-review-owner-repo-42-payload.json");
  });
});

describe("fetchPrHeadSha", () => {
  test("returns trimmed head SHA on success", () => {
    mockExecSync.mockReturnValue("abc1234def5678\n" as any);
    const sha = fetchPrHeadSha("owner", "repo", 42);
    expect(sha).toBe("abc1234def5678");
  });

  test("throws with context on failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("network error");
    });
    expect(() => fetchPrHeadSha("owner", "repo", 42)).toThrow(
      /Failed to fetch current head SHA for owner\/repo#42/,
    );
  });
});

describe("submitPrReview", () => {
  test("calls reviews endpoint with overall body and inline comments", () => {
    mockExecSync.mockReturnValue("" as any);
    submitPrReview("owner", "repo", 42, "abc1234", [
      { type: "overall", body: "Looks good overall." },
      { type: "inline", path: "src/foo.ts", line: 10, body: "Dead code." },
    ]);

    const call = mockExecSync.mock.calls[0];
    expect(call[0]).toContain("repos/owner/repo/pulls/42/reviews");
    expect(call[0]).toContain("-X POST");
    const payload = JSON.parse((call[1] as any).input as string);
    expect(payload.body).toBe("Looks good overall.");
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe("abc1234");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      path: "src/foo.ts",
      line: 10,
      side: "RIGHT",
      body: "Dead code.",
    });
  });

  test("posts file-level comment via separate comments endpoint", () => {
    mockExecSync.mockReturnValue("" as any);
    submitPrReview("owner", "repo", 42, "abc1234", [
      { type: "file", path: "src/bar.ts", body: "File-level note." },
    ]);

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const fileCall = mockExecSync.mock.calls[0];
    expect(fileCall[0]).toContain("repos/owner/repo/pulls/42/comments");
    const payload = JSON.parse((fileCall[1] as any).input as string);
    expect(payload.path).toBe("src/bar.ts");
    expect(payload.subject_type).toBe("file");
    expect(payload.body).toBe("File-level note.");
    expect(payload.commit_id).toBe("abc1234");
  });

  test("skips reviews endpoint when there is no overall body and no inline comments", () => {
    mockExecSync.mockReturnValue("" as any);
    submitPrReview("owner", "repo", 42, "abc1234", [
      { type: "file", path: "src/bar.ts", body: "File-level note." },
    ]);

    const calls = mockExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.every((cmd) => !cmd.includes("/reviews"))).toBe(true);
  });

  test("throws with context when review submission fails", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 422: Unprocessable Entity";
    mockExecSync.mockImplementation(() => {
      throw err;
    });
    expect(() =>
      submitPrReview("owner", "repo", 42, "abc1234", [
        { type: "overall", body: "note" },
      ]),
    ).toThrow(/Failed to submit review for owner\/repo#42/);
  });

  test("throws when file-level comment submission fails", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("file comment failed");
    });

    expect(() =>
      submitPrReview("owner", "repo", 42, "abc1234", [
        { type: "file", path: "src/baz.ts", body: "A note." },
      ]),
    ).toThrow(/Failed to submit file-level comment\(s\) for owner\/repo#42: src\/baz.ts: file comment failed/);
  });

  test("omits inline comments not in the diff (no path or line) and skips review POST", () => {
    mockExecSync.mockReturnValue("" as any);
    submitPrReview("owner", "repo", 42, "sha", [
      { type: "inline", body: "no path or line" },
    ]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
