import { execFileSync } from "child_process";

export interface PrMetadata {
  number: number;
  headSha: string;
  url: string;
}

export function checkGhCli(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe", encoding: "utf-8" });
  } catch {
    throw new Error(
      `gh CLI is not installed or not in PATH.\n` +
        `carl reads the PR diff with gh, and tuicr submits the review with it.\n` +
        `Install it from https://cli.github.com/ then run: gh auth login`,
    );
  }
}

function ghError(number: number, action: string, err: any): Error {
  const stderr: string = (err.stderr ?? "").toString().trim();
  if (stderr.includes("no pull requests found") || stderr.includes("404")) {
    return new Error(
      `PR #${number} not found in this repository.\n` +
        `Check the number with: gh pr list`,
    );
  }
  if (
    stderr.includes("401") ||
    stderr.includes("Must be authenticated") ||
    stderr.includes("requires authentication") ||
    stderr.includes("gh auth login")
  ) {
    return new Error(
      `Not authorized to read PR #${number}.\n` +
        `Fix your credentials with: gh auth login`,
    );
  }
  if (stderr.includes("not a git repository")) {
    return new Error(
      `Not a git repository, so there is no repo to resolve PR #${number} against.\n` +
        `Run carl pr-review from the checkout of the PR's repository.`,
    );
  }
  return new Error(
    `Failed to ${action} for PR #${number}: ${stderr || err.message}`,
  );
}

/**
 * Metadata comes from the repo in `workspaceRoot`: gh resolves owner/repo from
 * the checkout's remotes, which is what makes a bare PR number unambiguous.
 */
export function fetchPrMetadata(
  workspaceRoot: string,
  number: number,
): PrMetadata {
  let json: string;
  try {
    json = execFileSync(
      "gh",
      ["pr", "view", String(number), "--json", "headRefOid,url"],
      { cwd: workspaceRoot, stdio: "pipe", encoding: "utf-8" },
    );
  } catch (err: any) {
    throw ghError(number, "fetch PR metadata", err);
  }

  const pr = JSON.parse(json) as { headRefOid?: string; url?: string };
  if (!pr.headRefOid) {
    throw new Error(
      `gh returned no head commit for PR #${number}: ${json.trim()}\n` +
        `Re-run after \`gh auth status\`; carl needs the head SHA to check your checkout matches the PR.`,
    );
  }
  return {
    number,
    headSha: pr.headRefOid,
    url: pr.url ?? `#${number}`,
  };
}

export function fetchPrDiff(workspaceRoot: string, number: number): string {
  try {
    return execFileSync("gh", ["pr", "diff", String(number)], {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: any) {
    throw ghError(number, "fetch the diff", err);
  }
}
