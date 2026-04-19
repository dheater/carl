import { execSync, spawnSync } from "child_process";
import * as readline from "readline";
import { detectGit, getGitStatus, getCurrentBranch } from "./git";

export interface CommitOptions {
  workspaceRoot: string;
  trackedChanged: string[];
  untracked: string[];
  message: string;
}

export function promptForCommit(
  trackedChanged: string[],
  untracked: string[],
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Print summary
  if (trackedChanged.length > 0) {
    console.log("\nWill commit (tracked only):");
    trackedChanged.forEach((f) => console.log(`  ${f}`));
  }

  if (untracked.length > 0) {
    console.log("\nUntracked (left alone, not auto-staged):");
    untracked.forEach((f) => console.log(`  ${f}`));
  }

  return new Promise((resolve) => {
    rl.question("\nStage and commit tracked changes now? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export function parseProposedCommitMessage(text: string): string | null {
  // Find the "## Proposed commit message" section
  const match = text.match(
    /##\s+Proposed commit message\s*\n([\s\S]*?)(?=\n##|\Z)/i,
  );
  if (!match) {
    return null;
  }

  const section = match[1];
  // Get non-empty lines from the section
  const lines = section
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  // Return all non-empty lines from the section
  return lines.join("\n");
}

export function buildCommitMessageFromReviewerOutput(
  reviewerMessage: string,
  currentBranch: string,
): string {
  // Try to extract the proposed commit message section
  const proposedMsg = parseProposedCommitMessage(reviewerMessage);

  if (proposedMsg) {
    return proposedMsg;
  }

  // Fallback: Use branch-specific default if no proposed section found
  // Detect if this is a ticket branch (contains dash and non-numeric prefix)
  const isTicketBranch =
    currentBranch &&
    /^[A-Z]+-\d+/.test(currentBranch) &&
    currentBranch !== "main" &&
    currentBranch !== "master";

  if (isTicketBranch) {
    // Extract ticket prefix (e.g., "CLIENTS-934" from "CLIENTS-934-download-fixes")
    const ticketMatch = currentBranch.match(/^([A-Z]+-\d+)/);
    if (ticketMatch) {
      return `${ticketMatch[1]}: Sprint changes`;
    }
  }

  // Default fallback for non-ticket branches
  return "chore: Sprint changes";
}

export function stageAndCommit(
  workspaceRoot: string,
  message: string,
): boolean {
  try {
    // Stage only tracked changes
    execSync("git add -u", { cwd: workspaceRoot, stdio: "pipe" });

    // Build git commit arguments
    const args = ["commit", "-e"];
    if (message.trim()) {
      args.push("-m", message);
    }

    // Invoke git commit with editor
    const result = spawnSync("git", args, {
      cwd: workspaceRoot,
      stdio: "inherit",
    });

    return result.status === 0;
  } catch (error) {
    console.error(`Git commit failed: ${error}`);
    return false;
  }
}

export async function handleReviewerCommit(
  workspaceRoot: string,
  reviewerMessage: string,
): Promise<void> {
  // Check if git is available and we're in a repo
  if (!detectGit()) {
    console.log(
      "\n  [System] Not in a git repository or git not available. Skipping commit.",
    );
    return;
  }

  // Get current git status
  const gitStatus = getGitStatus(workspaceRoot);
  if (!gitStatus.isRepo) {
    console.log("\n  [System] Not in a git repository. Skipping commit.");
    return;
  }

  // If there are no tracked changes to commit, skip
  if (gitStatus.trackedChanged.length === 0) {
    console.log("\n  [System] No changes to commit.");
    return;
  }

  // Parse the proposed commit message from reviewer output
  const currentBranch = getCurrentBranch(workspaceRoot);
  const commitMessage = buildCommitMessageFromReviewerOutput(
    reviewerMessage,
    currentBranch || "main",
  );

  // Stage tracked changes and commit using git editor
  const success = stageAndCommit(workspaceRoot, commitMessage);
  if (success) {
    console.log("  [System] Changes committed successfully.");
  } else {
    console.log("  [System] Git commit failed, but workflow will continue.");
  }
}
