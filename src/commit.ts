import { execSync, spawnSync } from "child_process";
import * as readline from "readline";
import { detectGit, getGitStatus } from "./git";

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

  // Stage tracked changes and commit using git editor
  const success = stageAndCommit(workspaceRoot, reviewerMessage);
  if (success) {
    console.log("  [System] Changes committed successfully.");
  } else {
    console.log("  [System] Git commit failed, but workflow will continue.");
  }
}
