import { execSync } from "child_process";

export interface PrUrl {
  owner: string;
  repo: string;
  number: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
}

export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  state: string;
  commits: CommitInfo[];
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
  let prJson: string;
  try {
    prJson = execSync(`gh api repos/${owner}/${repo}/pulls/${number}`, {
      stdio: "pipe",
      encoding: "utf-8",
    });
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

  let commitsJson: string;
  try {
    commitsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/commits`,
      { stdio: "pipe", encoding: "utf-8" },
    );
  } catch (err: any) {
    throw new Error(
      `Failed to fetch commits for ${owner}/${repo}#${number}: ${err.message}`,
    );
  }

  const pr = JSON.parse(prJson);
  const commits = JSON.parse(commitsJson);

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    state: pr.state,
    commits: commits.map((c: any) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? "unknown",
    })),
  };
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

export function fetchPrHeadSha(
  owner: string,
  repo: string,
  number: number,
): string {
  try {
    return execSync(
      `gh api repos/${owner}/${repo}/pulls/${number} --jq '.head.sha'`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
  } catch (err: any) {
    throw new Error(
      `Failed to fetch current head SHA for ${owner}/${repo}#${number}: ${err.message}`,
    );
  }
}

interface SubmitComment {
  type: "inline" | "file" | "overall";
  path?: string;
  line?: number;
  body: string;
}

export function submitPrReview(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  comments: SubmitComment[],
): void {
  const inlineComments = comments.filter(
    (c) => c.type === "inline" && c.path && c.line != null,
  );
  const fileComments = comments.filter((c) => c.type === "file" && c.path);
  const overallComments = comments.filter((c) => c.type === "overall");

  const body = overallComments.map((c) => c.body).join("\n\n");
  const reviewComments = inlineComments.map((c) => ({
    path: c.path!,
    line: c.line!,
    side: "RIGHT",
    body: c.body,
  }));

  const reviewPayload = {
    commit_id: headSha,
    body,
    event: "COMMENT",
    comments: reviewComments,
  };

  if (body || reviewComments.length > 0) {
    try {
      execSync(
        `gh api repos/${owner}/${repo}/pulls/${number}/reviews -X POST --input -`,
        {
          input: JSON.stringify(reviewPayload),
          stdio: ["pipe", "pipe", "pipe"],
          encoding: "utf-8",
        },
      );
    } catch (err: any) {
      throw new Error(
        `Failed to submit review for ${owner}/${repo}#${number}: ${err.stderr?.trim() || err.message}`,
      );
    }
  }

  const failedFileComments: string[] = [];
  for (const c of fileComments) {
    try {
      const filePayload = {
        body: c.body,
        commit_id: headSha,
        path: c.path!,
        subject_type: "file",
      };
      execSync(
        `gh api repos/${owner}/${repo}/pulls/${number}/comments -X POST --input -`,
        {
          input: JSON.stringify(filePayload),
          stdio: ["pipe", "pipe", "pipe"],
          encoding: "utf-8",
        },
      );
    } catch (err: any) {
      failedFileComments.push(
        `${c.path!}: ${err.stderr?.trim() || err.message}`,
      );
    }
  }

  if (failedFileComments.length > 0) {
    throw new Error(
      `Failed to submit file-level comment(s) for ${owner}/${repo}#${number}: ${failedFileComments.join("; ")}`,
    );
  }
}
