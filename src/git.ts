import { execSync } from "child_process";

interface GitStatus {
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

export function getCurrentBranch(workspaceRoot?: string): string | null {
  try {
    const output = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return output.trim();
  } catch {
    return null;
  }
}

export function getHeadSha(workspaceRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch (err: any) {
    throw new Error(
      `Could not resolve HEAD in ${workspaceRoot}: ${err.stderr?.trim() || err.message}`,
    );
  }
}

export function getGitStatus(workspaceRoot: string): GitStatus {
  try {
    const isRepo = detectGit();
    if (!isRepo) {
      return { isRepo: false, trackedChanged: [], untracked: [] };
    }

    const statusOutput = execSync("git status --porcelain", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const trackedChanged: string[] = [];
    const untracked: string[] = [];

    for (const line of statusOutput.split("\n")) {
      if (!line.trim()) continue;

      const status = line.substring(0, 2);
      const filename = line.substring(3);

      if (status.includes("?")) {
        untracked.push(filename);
      } else {
        trackedChanged.push(filename);
      }
    }

    return { isRepo: true, trackedChanged, untracked };
  } catch {
    return { isRepo: false, trackedChanged: [], untracked: [] };
  }
}
