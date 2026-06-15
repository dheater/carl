import * as path from "path";

export interface ReviewComment {
  type: "inline" | "overall";
  path?: string;
  startLine?: number;
  line?: number;
  body: string;
}

interface DiffHunk {
  newStart: number;
  newEnd: number;
  newSideLines: Set<number>;
}

function getCommentLabel(comment: ReviewComment, index: number): string {
  if (comment.type === "inline" && comment.path && comment.line != null) {
    const range =
      comment.startLine != null && comment.startLine !== comment.line
        ? `${comment.startLine}-${comment.line}`
        : `${comment.line}`;
    return `${comment.path}:${range}`;
  }
  return `overall comment ${index + 1}`;
}

function getInlineAnchorKey(comment: ReviewComment): string | null {
  if (comment.type !== "inline" || !comment.path || comment.line == null)
    return null;
  const start = comment.startLine != null ? comment.startLine : comment.line;
  return `${comment.path}:${start}-${comment.line}`;
}

export function parsePrReviewDraftComments(draft: string): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const lines = draft.split("\n");
  let current: ReviewComment | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    if (current) {
      if (line.trim() === "||| END") {
        current.body = currentBody.join("\n").trim();
        if (!current.body) {
          throw new Error(
            `Empty review comment body for ${getCommentLabel(current, comments.length)}.`,
          );
        }
        comments.push(current);
        current = null;
        currentBody = [];
        continue;
      }
      currentBody.push(line);
      continue;
    }

    const match = line.match(
      /^\|\|\| COMMENT (overall|inline)(?: (.+):(\d+)(?:-(\d+))?)?\s*$/,
    );
    if (!match) continue;
    const [, type, file, start, end] = match;
    if (type === "inline") {
      if (!file || !start) {
        throw new Error(`Malformed inline review comment header: ${line}`);
      }
      current = {
        type: "inline",
        path: file,
        startLine: end ? parseInt(start, 10) : undefined,
        line: parseInt(end ?? start, 10),
        body: "",
      };
    } else {
      current = { type: "overall", body: "" };
    }
  }

  if (current) {
    throw new Error(
      `Unterminated review comment block for ${getCommentLabel(current, comments.length)}.`,
    );
  }

  return comments;
}

export function buildPrReviewDraft(
  diff: string,
  prIdentity: string,
  headSha: string,
): string {
  const draftDiff = diff.endsWith("\n") ? diff.slice(0, -1) : diff;

  return [
    `# PR Review Draft`,
    `# PR: ${prIdentity} | HEAD: ${headSha.slice(0, 8)}`,
    `#`,
    `# Append \`||| COMMENT\` blocks below \`## Review comments\`. Two formats:`,
    `#`,
    `#   ||| COMMENT inline <path>:<line>`,
    `#   <what the problem is — then why it matters and how it happens>`,
    `#   ||| END`,
    `#`,
    `#   ||| COMMENT overall`,
    `#   <prose rationale>`,
    `#   ||| END`,
    `#`,
    `# Inline line numbers must reference new-side lines that appear in the PR diff hunks below.`,
    ``,
    `## PR Diff`,
    ``,
    "```diff",
    draftDiff,
    "```",
    ``,
    `## Review comments`,
    ``,
  ].join("\n");
}

export function getPrReviewDraftPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent", "pr-review.md");
}

export function parseDiffHunks(diff: string): Map<string, DiffHunk[]> {
  const hunks = new Map<string, DiffHunk[]>();
  const lines = diff.split("\n");
  let currentPath: string | null = null;
  let currentHunk: DiffHunk | null = null;
  let nextLineNo = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      currentPath = null;
      currentHunk = null;
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentPath = null;
      currentHunk = null;
      continue;
    }
    const plusPlus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusPlus) {
      currentPath = plusPlus[1];
      currentHunk = null;
      continue;
    }

    const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader && currentPath) {
      const start = parseInt(hunkHeader[1], 10);
      const len = hunkHeader[2] ? parseInt(hunkHeader[2], 10) : 1;
      currentHunk = {
        newStart: start,
        newEnd: start + len - 1,
        newSideLines: new Set(),
      };
      let list = hunks.get(currentPath);
      if (!list) {
        list = [];
        hunks.set(currentPath, list);
      }
      list.push(currentHunk);
      nextLineNo = start;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.newSideLines.add(nextLineNo);
      nextLineNo++;
    } else if (line.startsWith(" ")) {
      currentHunk.newSideLines.add(nextLineNo);
      nextLineNo++;
    }
  }
  return hunks;
}

export function validateCommentsInScope(
  comments: ReviewComment[],
  hunks: Map<string, DiffHunk[]>,
): string[] {
  const errors: string[] = [];
  comments.forEach((c, i) => {
    if (c.type !== "inline") return;
    const label = getCommentLabel(c, i);
    if (!c.path || c.line == null) {
      errors.push(`${label}: malformed inline comment (missing path or line)`);
      return;
    }
    const fileHunks = hunks.get(c.path);
    if (!fileHunks || fileHunks.length === 0) {
      errors.push(`${label}: ${c.path} is not in the PR diff`);
      return;
    }
    if (c.startLine != null) {
      const start = c.startLine;
      const end = c.line;
      if (start > end) {
        errors.push(`${label}: start line ${start} > end line ${end}`);
        return;
      }
      const containing = fileHunks.find(
        (h) => start >= h.newStart && end <= h.newEnd,
      );
      if (!containing) {
        errors.push(
          `${label}: range ${start}-${end} crosses a hunk boundary (GitHub requires a single hunk)`,
        );
        return;
      }
      for (let n = start; n <= end; n++) {
        if (!containing.newSideLines.has(n)) {
          errors.push(
            `${label}: line ${n} is not an added or context line in the hunk`,
          );
          return;
        }
      }
    } else {
      const found = fileHunks.some((h) => h.newSideLines.has(c.line!));
      if (!found) {
        errors.push(
          `${label}: line ${c.line} is not an added or context line in any hunk`,
        );
      }
    }
  });
  return errors;
}

export function validateNoDuplicateInlineComments(
  comments: ReviewComment[],
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  comments.forEach((comment, index) => {
    const key = getInlineAnchorKey(comment);
    if (!key) return;
    const label = getCommentLabel(comment, index);
    const first = seen.get(key);
    if (first) {
      errors.push(
        `${label}: duplicates inline anchor ${first} (GitHub review creation rejects multiple comments on the same exact range; merge them or move one)`,
      );
      return;
    }
    seen.set(key, label);
  });
  return errors;
}

export function validateInlineCommentsHaveRationale(
  comments: ReviewComment[],
): string[] {
  const errors: string[] = [];
  comments.forEach((c, i) => {
    if (c.type !== "inline") return;
    const label = getCommentLabel(c, i);
    const lines = c.body.split("\n");
    const fenceIdx = lines.findIndex((l) => /^\s*```/.test(l));
    const proseLines = fenceIdx === -1 ? lines : lines.slice(0, fenceIdx);
    const hasProse = proseLines.some((l) => l.trim().length > 0);
    if (!hasProse) {
      errors.push(
        `${label}: missing a rationale line — inline comment must open with a prose line naming the problem (WHAT is broken), then why it matters — do not start with a code fence`,
      );
    }
  });
  return errors;
}
