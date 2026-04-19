import { execSync } from "child_process";

export interface GitStatus {
  isRepo: boolean;
  trackedChanged: string[];
  untracked: string[];
}

export function detectGit(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      stdio: "pipe",
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

export function getGitStatus(workspaceRoot: string): GitStatus {
  try {
    const isRepo = detectGit();
    if (!isRepo) {
      return { isRepo: false, trackedChanged: [], untracked: [] };
    }

    // Get porcelain status output
    const statusOutput = execSync("git status --porcelain", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const trackedChanged: string[] = [];
    const untracked: string[] = [];

    for (const line of statusOutput.split("\n")) {
      if (!line.trim()) continue;

      // Format: XY FILENAME
      // X is index status, Y is worktree status
      // ? is untracked
      const status = line.substring(0, 2);
      const filename = line.substring(3);

      if (status.includes("?")) {
        untracked.push(filename);
      } else {
        // Any other status means tracked file with changes
        trackedChanged.push(filename);
      }
    }

    return { isRepo: true, trackedChanged, untracked };
  } catch {
    return { isRepo: false, trackedChanged: [], untracked: [] };
  }
}
