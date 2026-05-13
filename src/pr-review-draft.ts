import * as path from "path";
import type { PrMetadata } from "./github";

export interface ReviewComment {
  type: "inline" | "file" | "overall";
  path?: string;
  line?: number;
  body: string;
}

export interface PrReviewPayload {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  comments: ReviewComment[];
}

function formatCommentBlock(comment: ReviewComment): string {
  let header = `||| COMMENT ${comment.type}`;
  if (comment.type === "inline" && comment.path && comment.line != null) {
    header += ` ${comment.path}:${comment.line}`;
  } else if (comment.type === "file" && comment.path) {
    header += ` ${comment.path}`;
  }
  return `${header}\n${comment.body}\n||| END`;
}

export function parsePrReviewOutput(llmOutput: string): ReviewComment[] {
  const comments: ReviewComment[] = [];

  const summaryHeader = llmOutput.match(/^##\s+Summary\s*$/m);
  if (summaryHeader?.index != null) {
    const bodyStart = summaryHeader.index + summaryHeader[0].length;
    const nextHeaderOffset = llmOutput.slice(bodyStart).search(/\n##\s+/);
    const bodyEnd =
      nextHeaderOffset === -1 ? llmOutput.length : bodyStart + nextHeaderOffset;
    const body = llmOutput.slice(bodyStart, bodyEnd).trim();
    if (body) comments.push({ type: "overall", body });
  }

  const matches = [...llmOutput.matchAll(/^###\s+\[[^\]]+\]\s+(.+)$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const location = match[1].trim();
    const bodyStart = match.index! + match[0].length;
    const bodyEnd =
      i + 1 < matches.length ? matches[i + 1].index! : llmOutput.length;
    const body = llmOutput.slice(bodyStart, bodyEnd).trim();
    if (!body) continue;

    if (/^overall$/i.test(location)) {
      comments.push({ type: "overall", body });
      continue;
    }
    const fileLevelMatch = location.match(/^(.+?)\s+file-level$/i);
    if (fileLevelMatch) {
      comments.push({ type: "file", path: fileLevelMatch[1].trim(), body });
      continue;
    }
    const inlineMatch = location.match(/^(.+?)\s+line\s+(\d+)$/i);
    if (inlineMatch) {
      comments.push({
        type: "inline",
        path: inlineMatch[1].trim(),
        line: parseInt(inlineMatch[2], 10),
        body,
      });
      continue;
    }

    comments.push({ type: "file", path: location, body });
  }

  return comments;
}

export function parsePrReviewDraft(content: string): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const OPEN = /^\|\|\| COMMENT (inline|file|overall)(?:\s+(.+))?$/;
  const CLOSE = /^\|\|\| END\s*$/;

  let inBlock = false;
  let blockType: ReviewComment["type"] = "overall";
  let blockPath: string | undefined;
  let blockLine: number | undefined;
  const bodyLines: string[] = [];

  for (const line of content.split("\n")) {
    if (!inBlock) {
      const m = line.match(OPEN);
      if (!m) continue;
      inBlock = true;
      blockType = m[1] as ReviewComment["type"];
      blockPath = undefined;
      blockLine = undefined;
      bodyLines.length = 0;
      const loc = m[2]?.trim();
      if (blockType === "inline" && loc) {
        const colon = loc.lastIndexOf(":");
        blockPath = colon !== -1 ? loc.slice(0, colon) : loc;
        blockLine =
          colon !== -1 ? parseInt(loc.slice(colon + 1), 10) || undefined : undefined;
      } else if (blockType === "file" && loc) {
        blockPath = loc;
      }
    } else {
      if (CLOSE.test(line)) {
        const body = bodyLines.join("\n").trim();
        if (body) {
          const comment: ReviewComment = { type: blockType, body };
          if (blockPath) comment.path = blockPath;
          if (blockLine != null) comment.line = blockLine;
          comments.push(comment);
        }
        inBlock = false;
      } else {
        bodyLines.push(line);
      }
    }
  }

  return comments;
}

function insertCommentsIntoDiff(diff: string, comments: ReviewComment[]): string {
  const inlineIndex = new Map<string, Map<number, ReviewComment[]>>();
  const fileIndex = new Map<string, ReviewComment[]>();
  const renderedComments = new Set<ReviewComment>();

  for (const c of comments) {
    if (c.type === "inline" && c.path && c.line != null) {
      if (!inlineIndex.has(c.path)) inlineIndex.set(c.path, new Map());
      const lm = inlineIndex.get(c.path)!;
      if (!lm.has(c.line)) lm.set(c.line, []);
      lm.get(c.line)!.push(c);
    } else if (c.type === "file" && c.path) {
      if (!fileIndex.has(c.path)) fileIndex.set(c.path, []);
      fileIndex.get(c.path)!.push(c);
    }
  }

  const out: string[] = [];
  let currentFile: string | null = null;
  let newLineNum = 0;

  const flushFile = () => {
    if (!currentFile) return;
    const fc = fileIndex.get(currentFile);
    if (fc) {
      for (const c of fc) {
        out.push(formatCommentBlock(c));
        renderedComments.add(c);
      }
    }
  };

  const checkInline = () => {
    if (!currentFile) return;
    const lm = inlineIndex.get(currentFile);
    if (!lm) return;
    const cs = lm.get(newLineNum);
    if (cs) {
      for (const c of cs) {
        out.push(formatCommentBlock(c));
        renderedComments.add(c);
      }
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      currentFile = null;
      newLineNum = 0;
      out.push(line);
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      out.push(line);
    } else if (line.startsWith("@@ ")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLineNum = parseInt(m[1], 10) - 1;
      out.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      newLineNum++;
      out.push(line);
      checkInline();
    } else if (line.startsWith(" ")) {
      newLineNum++;
      out.push(line);
      checkInline();
    } else {
      out.push(line);
    }
  }
  flushFile();

  const unmatchedComments = comments.filter((c) => !renderedComments.has(c));
  if (unmatchedComments.length > 0) {
    out.push("");
    for (const c of unmatchedComments) {
      out.push(formatCommentBlock(c));
    }
  }

  return out.join("\n");
}

export function buildPrReviewDraft(
  diff: string,
  comments: ReviewComment[],
  metadata: PrMetadata,
  owner: string,
  repo: string,
): string {
  const header = [
    `# PR Review Draft: ${owner}/${repo}#${metadata.number} — ${metadata.title}`,
    `# Head: ${metadata.headSha.slice(0, 8)} | ${metadata.headRef} → ${metadata.baseRef}`,
    `#`,
    `# Edit or delete comment blocks. Empty bodies are ignored on submission.`,
    `# Add a block: ||| COMMENT <type> [path[:line]]`,
    `# Types:  inline <path>:<line>   file <path>   overall`,
    `# Close:  ||| END`,
    ``,
  ].join("\n");

  const overallComments = comments.filter((c) => c.type === "overall");
  const restComments = comments.filter((c) => c.type !== "overall");

  const parts: string[] = [header];
  for (const c of overallComments) {
    parts.push(formatCommentBlock(c));
    parts.push("");
  }
  parts.push(insertCommentsIntoDiff(diff, restComments));

  return parts.join("\n");
}

export function getPrReviewDraftPath(
  workspaceRoot: string,
  owner: string,
  repo: string,
  number: number,
): string {
  return path.join(
    workspaceRoot,
    ".agent",
    `pr-review-${owner}-${repo}-${number}.md`,
  );
}

export function getPrReviewPayloadPath(
  workspaceRoot: string,
  owner: string,
  repo: string,
  number: number,
): string {
  return path.join(
    workspaceRoot,
    ".agent",
    `pr-review-${owner}-${repo}-${number}-payload.json`,
  );
}
