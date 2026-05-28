import { execSync } from "child_process";
import type { ReviewComment } from "./pr-review-draft";

interface GitHubUser {
  login?: string;
}

interface PullRequestReview {
  id?: number | string;
  state?: string;
  user?: GitHubUser;
}

interface PrUrl {
  owner: string;
  repo: string;
  number: number;
}

export interface PrMetadata {
  number: number;
  headSha: string;
  headRepoFullName: string;
}

export function parsePrUrl(url: string): PrUrl {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid GitHub PR URL: ${url}\n` +
        `Expected format: https://github.com/owner/repo/pull/NUMBER`,
    );
  }
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

export function checkGhCli(): void {
  try {
    execSync("gh --version", { stdio: "pipe", encoding: "utf-8" });
  } catch {
    throw new Error(
      `gh CLI is not installed or not in PATH.\n` +
        `Install it from https://cli.github.com/ then run: gh auth login`,
    );
  }
}

function normalizeGitHubRepoId(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();

  const httpsMatch = remoteUrl.match(
    /https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`.toLowerCase();

  return null;
}

export function checkRepoMatch(
  workspaceRoot: string,
  owner: string,
  repo: string,
): void {
  let remoteOutput: string;
  try {
    remoteOutput = execSync("git remote -v", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch {
    throw new Error(
      `Could not read git remotes. Is this directory a git repository?`,
    );
  }

  const expectedId = `${owner}/${repo}`.toLowerCase();
  const remoteUrls = remoteOutput
    .split("\n")
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);

  const found = remoteUrls.some(
    (url) => normalizeGitHubRepoId(url) === expectedId,
  );

  if (!found) {
    throw new Error(
      `Workspace repo does not match PR repo ${owner}/${repo}.\n` +
        `Remotes found: ${remoteUrls.join(", ")}\n` +
        `Run carl pr-review from the correct repository checkout.`,
    );
  }
}

export function fetchPrMetadata(
  owner: string,
  repo: string,
  number: number,
): PrMetadata {
  try {
    const prJson = execSync(`gh api repos/${owner}/${repo}/pulls/${number}`, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const pr = JSON.parse(prJson);

    return {
      number: pr.number,
      headSha: pr.head.sha,
      headRepoFullName: pr.head.repo?.full_name ?? "",
    };
  } catch (err: any) {
    const stderr: string = err.stderr ?? "";
    if (stderr.includes("Not Found") || stderr.includes("Could not resolve")) {
      throw new Error(
        `PR ${owner}/${repo}#${number} not found.\n` +
          `Verify the URL and run: gh auth status`,
      );
    }
    if (
      stderr.includes("401") ||
      stderr.includes("Must be authenticated") ||
      stderr.includes("requires authentication")
    ) {
      throw new Error(
        `Not authorized to read ${owner}/${repo}#${number}.\n` +
          `Fix your credentials with: gh auth login`,
      );
    }
    throw new Error(
      `Failed to fetch PR metadata for ${owner}/${repo}#${number}: ${stderr || err.message}`,
    );
  }
}

export function checkNotForkPr(
  metadata: PrMetadata,
  owner: string,
  repo: string,
): void {
  const expected = `${owner}/${repo}`.toLowerCase();
  if (!metadata.headRepoFullName || metadata.headRepoFullName.toLowerCase() !== expected) {
    throw new Error(
      `Fork PRs are not supported.\n` +
        `PR source is from ${metadata.headRepoFullName || "an unknown fork"}, expected ${owner}/${repo}.\n` +
        `Ensure the PR source branch is pushed directly to ${owner}/${repo}.`,
    );
  }
}

export function fetchPrDiff(
  owner: string,
  repo: string,
  number: number,
): string {
  try {
    return execSync(
      `gh api -H "Accept: application/vnd.github.v3.diff" repos/${owner}/${repo}/pulls/${number}`,
      { stdio: "pipe", encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err: any) {
    throw new Error(
      `Failed to fetch diff for ${owner}/${repo}#${number}: ${err.message}`,
    );
  }
}

function findOwnPendingReviewId(
  owner: string,
  repo: string,
  number: number,
): string | null {
  try {
    const viewerJson = execSync("gh api user", {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const viewer = JSON.parse(viewerJson) as GitHubUser;
    if (!viewer.login) return null;

    const reviewsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    const reviews = JSON.parse(reviewsJson) as PullRequestReview[];
    const pending = reviews.find(
      (review) =>
        review.state === "PENDING" &&
        review.user?.login?.toLowerCase() === viewer.login!.toLowerCase(),
    );
    return pending?.id != null ? String(pending.id) : null;
  } catch {
    return null;
  }
}

export function createPendingReview(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  comments: ReviewComment[],
): string {
  const inlineComments = comments.filter(
    (c) => c.type === "inline" && c.path && c.line != null,
  );
  const overallComments = comments.filter((c) => c.type === "overall");
  const body = overallComments.map((c) => c.body).join("\n\n");

  const apiComments = inlineComments.map((c) => {
    const comment: Record<string, unknown> = {
      path: c.path!,
      line: c.line!,
      side: "RIGHT",
      body: c.body,
    };
    if (c.startLine != null && c.startLine !== c.line) {
      comment.start_line = c.startLine;
      comment.start_side = "RIGHT";
    }
    return comment;
  });

  // No "event" field → review is created as PENDING (not auto-submitted).
  const reviewPayload: Record<string, unknown> = {
    commit_id: headSha,
    comments: apiComments,
  };
  if (body) reviewPayload.body = body;

  let result: string;
  try {
    result = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/reviews -X POST --input -`,
      {
        input: JSON.stringify(reviewPayload),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
  } catch (err: any) {
    const stderr = err.stderr?.trim() || err.message;
    if (stderr.includes("422")) {
      const pendingReviewId = findOwnPendingReviewId(owner, repo, number);
      if (pendingReviewId) {
        throw new Error(
          `Pending review already exists for ${owner}/${repo}#${number}.\n` +
            `GitHub rejects creating a second pending review for the same user.\n` +
            `Submit or delete review ${pendingReviewId} in the PR UI, then re-run: carl pr-review https://github.com/${owner}/${repo}/pull/${number}`,
        );
      }
    }
    throw new Error(
      `Failed to create pending review for ${owner}/${repo}#${number}: ${stderr}`,
    );
  }

  try {
    const data = JSON.parse(result);
    return String(data.id);
  } catch {
    return "unknown";
  }
}
