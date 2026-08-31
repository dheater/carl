import {
  buildPrReviewDraft,
  parsePrReviewDraftComments,
  parseDiffHunks,
  annotateDiffWithLineNumbers,
  validateCommentsInScope,
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

describe("annotateDiffWithLineNumbers", () => {
  test("prepends new-side line numbers; deleted lines get blank prefix", () => {
    const diff = [
      "diff --git a/src/f.ts b/src/f.ts",
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -10,3 +10,3 @@",
      " context",
      "-removed",
      "+added",
      " after",
    ].join("\n");
    const out = annotateDiffWithLineNumbers(diff).split("\n");
    // Header lines unchanged
    expect(out[0]).toBe("diff --git a/src/f.ts b/src/f.ts");
    expect(out[3]).toBe("@@ -10,3 +10,3 @@");
    // context line at new-side 10
    expect(out[4]).toBe("   10  context");
    // deleted line — blank prefix, no line number advance
    expect(out[5]).toBe("       -removed");
    // added line at new-side 11 (10 was context, removed didn't advance)
    expect(out[6]).toBe("   11 +added");
    // context line at new-side 12
    expect(out[7]).toBe("   12  after");
  });

  test("handles multiple hunks resetting line counter", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "+first",
      "@@ -100,1 +200,1 @@",
      "+second",
    ].join("\n");
    const out = annotateDiffWithLineNumbers(diff).split("\n");
    expect(out[3]).toBe("    1 +first");
    expect(out[5]).toBe("  200 +second");
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

  test("rejects a line outside any hunk", () => {
    const errors = validateCommentsInScope([inline(50)], hunks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 50/);
  });
});

describe("buildPrReviewDraft", () => {
  test("names the review-comments heading exactly once", () => {
    // The instruction header used to quote the heading, so the model's append —
    // an `edit` with the heading as `old_string` — matched twice and failed on
    // every pr-review run.
    const draft = buildPrReviewDraft(
      "diff --git a/src/f.ts b/src/f.ts\n+++ b/src/f.ts\n@@ -1,1 +1,1 @@\n+added\n",
      "owner/repo#1",
      "0123456789abcdef",
    );
    const occurrences = draft.split("## Review comments").length - 1;
    expect(occurrences).toBe(1);
  });
});
