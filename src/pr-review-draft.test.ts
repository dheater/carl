import {
  buildPrReviewDraft,
  parsePrReviewDraftComments,
  parseDiffHunks,
  validateCommentsInScope,
  validateNoDuplicateInlineComments,
  validateInlineCommentsHaveRationale,
  type ReviewComment,
} from "./pr-review-draft";

describe("pr-review draft parsing", () => {
  test("parses inline and overall comment blocks from an editable draft", () => {
    const draft = [
      "# Draft header",
      "",
      "||| COMMENT overall",
      "Why:",
      "Top-level rationale.",
      "",
      "Overall body.",
      "||| END",
      "",
      "diff --git a/src/f.ts b/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -1,1 +1,1 @@",
      "+added",
      "||| COMMENT inline src/f.ts:2-3",
      "Why:",
      "Inline rationale.",
      "",
      "```suggestion",
      "fixed",
      "```",
      "||| END",
    ].join("\n");

    expect(parsePrReviewDraftComments(draft)).toEqual([
      { type: "overall", body: "Why:\nTop-level rationale.\n\nOverall body." },
      {
        type: "inline",
        path: "src/f.ts",
        startLine: 2,
        line: 3,
        body: "Why:\nInline rationale.\n\n```suggestion\nfixed\n```",
      },
    ]);
  });
});

describe("buildPrReviewDraft", () => {
  test("preserves the diff text and uses PR identity in header", () => {
    const diff = [
      "diff --git a/src/f.ts b/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -1 +1 @@",
      "+value   ",
      " line2   ",
      "",
    ].join("\n");

    const draft = buildPrReviewDraft(diff, "owner/repo#42", "abc12345def");

    expect(draft).toContain("# PR: owner/repo#42 | HEAD: abc12345");
    expect(draft).toContain("+value   \n line2   \n```");
    expect(draft).toContain("## Review comments");
  });
});

describe("parseDiffHunks", () => {
  test("maps file paths to hunks with new-side line numbers", () => {
    const diff = [
      "diff --git a/src/f.ts b/src/f.ts",
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added",
      " line2",
      "@@ -10,1 +11,2 @@",
      " ctx",
      "+more",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    const fileHunks = hunks.get("src/f.ts")!;
    expect(fileHunks).toHaveLength(2);
    expect([...fileHunks[0].newSideLines]).toEqual([1, 2, 3]);
    expect(fileHunks[0].newStart).toBe(1);
    expect(fileHunks[0].newEnd).toBe(3);
    expect([...fileHunks[1].newSideLines]).toEqual([11, 12]);
  });

  test("skips deleted-only files (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-deleted",
    ].join("\n");
    expect(parseDiffHunks(diff).size).toBe(0);
  });

  test("does not count deletion lines as new-side lines", () => {
    const diff = [
      "diff --git a/f b/f",
      "+++ b/f",
      "@@ -1,3 +1,2 @@",
      " a",
      "-b",
      " c",
    ].join("\n");
    const fileHunks = parseDiffHunks(diff).get("f")!;
    expect([...fileHunks[0].newSideLines]).toEqual([1, 2]);
  });
});

describe("validateCommentsInScope", () => {
  const diff = [
    "diff --git a/src/f.ts b/src/f.ts",
    "+++ b/src/f.ts",
    "@@ -1,2 +1,3 @@",
    " line1",
    "+added",
    " line2",
    "@@ -10,1 +11,3 @@",
    " ctx",
    "+x",
    "+y",
  ].join("\n");
  const hunks = parseDiffHunks(diff);

  function inline(
    line: number,
    startLine?: number,
    path = "src/f.ts",
  ): ReviewComment {
    return { type: "inline", path, line, startLine, body: "b" };
  }

  test("accepts a single-line comment on an added line", () => {
    expect(validateCommentsInScope([inline(2)], hunks)).toEqual([]);
  });

  test("accepts a multi-line comment within a single hunk", () => {
    expect(validateCommentsInScope([inline(13, 11)], hunks)).toEqual([]);
  });

  test("rejects a line outside any hunk", () => {
    const errors = validateCommentsInScope([inline(50)], hunks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 50/);
  });

  test("rejects a range crossing two hunks", () => {
    const errors = validateCommentsInScope([inline(12, 2)], hunks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/single hunk/);
  });

  test("rejects a file not in the diff", () => {
    const errors = validateCommentsInScope(
      [inline(1, undefined, "other.ts")],
      hunks,
    );
    expect(errors[0]).toMatch(/not in the PR diff/);
  });

  test("ignores overall comments", () => {
    const c: ReviewComment = { type: "overall", body: "note" };
    expect(validateCommentsInScope([c], hunks)).toEqual([]);
  });

  test("rejects start > end", () => {
    const errors = validateCommentsInScope([inline(1, 3)], hunks);
    expect(errors[0]).toMatch(/start line 3 > end line 1/);
  });
});

describe("validateNoDuplicateInlineComments", () => {
  test("rejects duplicate exact inline anchors", () => {
    const comments: ReviewComment[] = [
      {
        type: "inline",
        path: "src/f.ts",
        startLine: 10,
        line: 12,
        body: "first",
      },
      {
        type: "inline",
        path: "src/f.ts",
        startLine: 10,
        line: 12,
        body: "second",
      },
    ];
    const errors = validateNoDuplicateInlineComments(comments);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicates inline anchor/);
  });

  test("allows different inline anchors", () => {
    const comments: ReviewComment[] = [
      { type: "inline", path: "src/f.ts", line: 10, body: "first" },
      { type: "inline", path: "src/f.ts", line: 11, body: "second" },
    ];
    expect(validateNoDuplicateInlineComments(comments)).toEqual([]);
  });
});

describe("validateInlineCommentsHaveRationale", () => {
  function inline(body: string): ReviewComment {
    return { type: "inline", path: "src/f.ts", line: 2, body };
  }

  test("accepts an inline comment with prose and no suggestion", () => {
    expect(
      validateInlineCommentsHaveRationale([
        inline("Caller will see undefined here."),
      ]),
    ).toEqual([]);
  });

  test("accepts an inline comment with a rationale line above a suggestion", () => {
    const body = [
      "Caller will see undefined here.",
      "",
      "```suggestion",
      "return value;",
      "```",
    ].join("\n");
    expect(validateInlineCommentsHaveRationale([inline(body)])).toEqual([]);
  });

  test("rejects an inline comment whose body is only a suggestion block", () => {
    const body = ["```suggestion", "return value;", "```"].join("\n");
    const errors = validateInlineCommentsHaveRationale([inline(body)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing a rationale line/);
  });

  test("rejects an inline comment with only blank lines before the suggestion fence", () => {
    const body = ["", "   ", "```suggestion", "return value;", "```"].join(
      "\n",
    );
    const errors = validateInlineCommentsHaveRationale([inline(body)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing a rationale line/);
  });

  test("ignores overall comments", () => {
    const c: ReviewComment = { type: "overall", body: "```suggestion\nx\n```" };
    expect(validateInlineCommentsHaveRationale([c])).toEqual([]);
  });
});
