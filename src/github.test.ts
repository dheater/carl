import {
  parsePrUrl,
  checkGhCli,
  checkRepoMatch,
  fetchPrMetadata,
  fetchPrDiff,
  checkNotForkPr,
  createPendingReview,
  type PrMetadata,
} from "./github";
import { execSync } from "child_process";

jest.mock("child_process");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

afterEach(() => jest.clearAllMocks());

describe("parsePrUrl", () => {
  test("parses a URL with trailing slash and dotted names", () => {
    const result = parsePrUrl("https://github.com/my-org/my.repo/pull/100/");
    expect(result).toEqual({ owner: "my-org", repo: "my.repo", number: 100 });
  });

  test("throws on a non-PR GitHub URL", () => {
    expect(() => parsePrUrl("https://github.com/owner/repo")).toThrow(
      /Invalid GitHub PR URL/,
    );
  });

  test("throws on an entirely wrong URL", () => {
    expect(() =>
      parsePrUrl("https://gitlab.com/owner/repo/merge_requests/1"),
    ).toThrow(/Invalid GitHub PR URL/);
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

  test("passes when an SSH alias remote matches", () => {
    mockExecSync.mockReturnValue(
      "origin\tgit@github.com-daniel-heater-imprivata:owner/repo.git (fetch)\n" as any,
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
    head: { sha: "abc1234", ref: "fix-bug", repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };

  test("returns structured metadata on success", () => {
    mockExecSync.mockReturnValue(JSON.stringify(prPayload) as any);

    const meta = fetchPrMetadata("owner", "repo", 42);

    expect(meta.number).toBe(42);
    expect(meta.headSha).toBe("abc1234");
    expect(meta.headRepoFullName).toBe("owner/repo");
  });

  test("handles missing head repo (deleted fork) gracefully", () => {
    const forkPayload = {
      ...prPayload,
      head: { sha: "abc1234", ref: "fix-bug", repo: null },
    };
    mockExecSync.mockReturnValue(JSON.stringify(forkPayload) as any);
    const meta = fetchPrMetadata("owner", "repo", 42);
    expect(meta.headRepoFullName).toBe("");
  });

  test("throws a not-found error on 404", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 404: Not Found";
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/not found/i);
    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(
      /gh auth status/,
    );
  });

  test("throws an auth error on 401", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 401: Must be authenticated";
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(
      /Not authorized/,
    );
    expect(() => fetchPrMetadata("owner", "repo", 99)).toThrow(/gh auth login/);
  });
});

describe("checkNotForkPr", () => {
  function makeMetadata(headRepoFullName: string): PrMetadata {
    return {
      number: 1,
      headSha: "abc",
      headRepoFullName,
    };
  }

  test("does not throw when head repo matches owner/repo", () => {
    expect(() =>
      checkNotForkPr(makeMetadata("owner/repo"), "owner", "repo"),
    ).not.toThrow();
  });

  test("matching is case-insensitive", () => {
    expect(() =>
      checkNotForkPr(makeMetadata("Owner/Repo"), "owner", "repo"),
    ).not.toThrow();
  });

  test("throws for a fork PR with a different head repo", () => {
    expect(() =>
      checkNotForkPr(makeMetadata("fork-user/repo"), "owner", "repo"),
    ).toThrow(/Fork PRs are not supported/);
    expect(() =>
      checkNotForkPr(makeMetadata("fork-user/repo"), "owner", "repo"),
    ).toThrow(/fork-user\/repo/);
  });

  test("throws when head repo is empty (deleted fork)", () => {
    expect(() => checkNotForkPr(makeMetadata(""), "owner", "repo")).toThrow(
      /Fork PRs are not supported/,
    );
    expect(() => checkNotForkPr(makeMetadata(""), "owner", "repo")).toThrow(
      /unknown fork/,
    );
  });
});

describe("fetchPrDiff", () => {
  test("returns diff text on success", () => {
    mockExecSync.mockReturnValue("diff --git a/foo.ts b/foo.ts\n" as any);
    const diff = fetchPrDiff("owner", "repo", 42);
    expect(diff).toContain("diff --git");
  });

  test("throws with context on failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("network error");
    });
    expect(() => fetchPrDiff("owner", "repo", 42)).toThrow(
      /Failed to fetch diff for owner\/repo#42/,
    );
  });
});

describe("createPendingReview", () => {
  test("creates PENDING review — no event field in payload", () => {
    mockExecSync.mockReturnValue(JSON.stringify({ id: 999 }) as any);
    createPendingReview("owner", "repo", 42, "abc1234", [
      { type: "overall", body: "Looks good overall." },
      {
        type: "inline",
        path: "src/foo.ts",
        line: 10,
        body: "Why:\nKeep the tested branch behavior intact.\n\n```suggestion\nfixed\n```",
      },
    ]);

    const call = mockExecSync.mock.calls[0];
    expect(call[0]).toContain("repos/owner/repo/pulls/42/reviews");
    expect(call[0]).toContain("-X POST");
    const payload = JSON.parse((call[1] as any).input as string);
    expect(payload.event).toBeUndefined();
    expect(payload.commit_id).toBe("abc1234");
    expect(payload.body).toBe("Looks good overall.");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      path: "src/foo.ts",
      line: 10,
      side: "RIGHT",
    });
    expect(payload.comments[0].body).toContain(
      "Why:\nKeep the tested branch behavior intact.",
    );
  });

  test("returns review id from API response", () => {
    mockExecSync.mockReturnValue(JSON.stringify({ id: 42001 }) as any);
    const id = createPendingReview("owner", "repo", 42, "abc1234", [
      { type: "overall", body: "note" },
    ]);
    expect(id).toBe("42001");
  });

  test("includes start_line for multi-line suggestions", () => {
    mockExecSync.mockReturnValue(JSON.stringify({ id: 1 }) as any);
    createPendingReview("owner", "repo", 42, "abc1234", [
      {
        type: "inline",
        path: "src/foo.ts",
        startLine: 5,
        line: 8,
        body: "```suggestion\nfixed\n```",
      },
    ]);

    const call = mockExecSync.mock.calls[0];
    const payload = JSON.parse((call[1] as any).input as string);
    expect(payload.comments[0].start_line).toBe(5);
    expect(payload.comments[0].start_side).toBe("RIGHT");
    expect(payload.comments[0].line).toBe(8);
  });

  test("throws with context on API failure", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 422: Unprocessable Entity";
    mockExecSync
      .mockImplementationOnce(() => {
        throw err;
      })
      .mockReturnValueOnce(JSON.stringify({ login: "me" }) as any)
      .mockReturnValueOnce(JSON.stringify([]) as any);
    expect(() =>
      createPendingReview("owner", "repo", 42, "abc1234", [
        { type: "overall", body: "note" },
      ]),
    ).toThrow(/Failed to create pending review for owner\/repo#42/);
  });

  test("throws a direct error when a pending review already exists for the viewer", () => {
    const err: any = new Error("gh api failed");
    err.stderr = "HTTP 422: Unprocessable Entity";
    mockExecSync
      .mockImplementationOnce(() => {
        throw err;
      })
      .mockReturnValueOnce(JSON.stringify({ login: "me" }) as any)
      .mockReturnValueOnce(
        JSON.stringify([
          { id: 77, state: "PENDING", user: { login: "me" } },
        ]) as any,
      );

    let message = "";
    try {
      createPendingReview("owner", "repo", 42, "abc1234", [
        { type: "overall", body: "note" },
      ]);
    } catch (caught: any) {
      message = String(caught.message || caught);
    }

    expect(message).toMatch(/Pending review already exists for owner\/repo#42/);
    expect(message).toMatch(/review 77/);
  });
});
