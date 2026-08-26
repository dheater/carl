import { execFileSync, spawn, spawnSync } from "child_process";
import type { ReviewComment } from "./pr-review-draft";

/**
 * tuicr is the review TUI (https://github.com/agavra/tuicr). It fetches the PR,
 * shows the diff, and submits the review to GitHub itself, so carl hands it
 * comments and gets out of the way.
 *
 * A tuicr "session" is a persisted JSON file holding the draft comments for one
 * review target. Only the TUI creates a PR session, so carl cannot pre-load
 * comments: it launches the TUI, waits for the session to appear, then writes
 * the comments into it through `tuicr review add`.
 */

/** How long to wait for the TUI to publish its session (commit selector included). */
const SESSION_TIMEOUT_MS = 120_000;
const SESSION_POLL_MS = 500;

export function checkTuicrCli(): void {
  try {
    execFileSync("tuicr", ["--version"], { stdio: "pipe", encoding: "utf-8" });
  } catch {
    throw new Error(
      `tuicr is not installed or not in PATH.\n` +
        `carl pr-review opens the review in tuicr.\n` +
        `Install it with: brew install tuicr   (or see https://github.com/agavra/tuicr)`,
    );
  }
}

interface SessionRow {
  slug?: string;
  kind?: string;
}

/**
 * Returns the slug of the persisted PR session for `number`, or null while it
 * does not exist yet. Slugs look like `gh:owner/repo/pr/42`; matching on the
 * `/pr/<n>` suffix avoids guessing the forge prefix and owner/repo casing.
 */
export function findPrSession(
  workspaceRoot: string,
  number: number,
): string | null {
  let json: string;
  try {
    json = execFileSync("tuicr", ["review", "list", "--repo", workspaceRoot], {
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (err: any) {
    throw new Error(
      `Failed to list tuicr review sessions for ${workspaceRoot}: ${(err.stderr ?? "").toString().trim() || err.message}`,
    );
  }

  let rows: SessionRow[];
  try {
    rows = JSON.parse(json) as SessionRow[];
  } catch {
    throw new Error(
      `Could not parse \`tuicr review list\` output as JSON: ${json.trim().slice(0, 200)}\n` +
        `carl needs tuicr >= 0.20 (JSON session CLI). Check: tuicr --version`,
    );
  }

  const suffix = `/pr/${number}`;
  const match = rows.find(
    (row) =>
      row.kind === "pr" &&
      typeof row.slug === "string" &&
      row.slug.endsWith(suffix),
  );
  return match?.slug ?? null;
}

/**
 * The JSON `tuicr review add --input -` accepts. Inline comments are always on
 * the new side: the draft's line numbers come from the diff's new-side hunks.
 */
export function buildAddCommentPayload(
  comment: ReviewComment,
): Record<string, unknown> {
  if (comment.type === "overall") {
    return { content: comment.body };
  }
  const payload: Record<string, unknown> = {
    content: comment.body,
    file: comment.path,
    side: "new",
  };
  if (comment.startLine != null && comment.startLine !== comment.line) {
    payload.start_line = comment.startLine;
    payload.end_line = comment.line;
  } else {
    payload.line = comment.line;
  }
  return payload;
}

function describeComment(comment: ReviewComment): string {
  if (comment.type === "overall") return "overall comment";
  const range =
    comment.startLine != null && comment.startLine !== comment.line
      ? `${comment.startLine}-${comment.line}`
      : `${comment.line}`;
  return `${comment.path}:${range}`;
}

function addComment(
  slug: string,
  comment: ReviewComment,
  username: string,
): string | null {
  const result = spawnSync(
    "tuicr",
    [
      "review",
      "add",
      "--session",
      slug,
      "--username",
      username,
      "--input",
      "-",
    ],
    {
      input: JSON.stringify(buildAddCommentPayload(comment)),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    },
  );
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    return (
      (result.stderr ?? "").toString().trim() ||
      (result.stdout ?? "").toString().trim() ||
      `tuicr review add exited ${result.status}`
    );
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens `tuicr pr <number>` on the terminal carl was invoked from and injects
 * `comments` as local draft comments as soon as tuicr's session exists. Resolves
 * when the human closes the TUI.
 *
 * Nothing is printed while the TUI owns the terminal — a stray line corrupts its
 * display — so injection failures are collected and thrown after it exits.
 */
export async function openPrReviewInTuicr(
  workspaceRoot: string,
  number: number,
  comments: ReviewComment[],
  username: string,
): Promise<void> {
  const child = spawn("tuicr", ["pr", String(number)], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });

  let exited = false;
  let spawnErrorMessage = "";
  const finished = new Promise<void>((resolve) => {
    child.on("error", (err) => {
      spawnErrorMessage = err.message;
      exited = true;
      resolve();
    });
    child.on("exit", () => {
      exited = true;
      resolve();
    });
  });

  let slug: string | null = null;
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (!exited && Date.now() < deadline) {
    slug = findPrSession(workspaceRoot, number);
    if (slug) break;
    await sleep(SESSION_POLL_MS);
  }

  const failures: string[] = [];
  if (slug) {
    for (const comment of comments) {
      const failure = addComment(slug, comment, username);
      if (failure) failures.push(`${describeComment(comment)}: ${failure}`);
    }
  }

  await finished;

  if (spawnErrorMessage) {
    throw new Error(
      `Failed to run \`tuicr pr ${number}\`: ${spawnErrorMessage}`,
    );
  }
  if (!slug) {
    throw new Error(
      `tuicr never published a review session for PR #${number}` +
        ` (waited ${Math.round(SESSION_TIMEOUT_MS / 1000)}s or until tuicr exited).\n` +
        `The ${comments.length} drafted comment(s) were not loaded into tuicr.\n` +
        `Check that \`tuicr pr ${number}\` opens the PR in this checkout, then re-run: carl pr-review ${number}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `tuicr rejected ${failures.length} of ${comments.length} comment(s) for session ${slug}:\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
}
