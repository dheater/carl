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

/** Returns true when the directory (or any ancestor) is a jj workspace. */
export function detectJj(workspaceRoot?: string): boolean {
  try {
    execSync("jj root", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(workspaceRoot?: string): string | null {
  // jj: nearest bookmark at or below @ in the ancestry chain
  try {
    const output = execSync(
      "jj log --no-graph -r @ --template local_bookmarks",
      {
        cwd: workspaceRoot,
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    const trimmed = output.trim();
    if (trimmed) return trimmed;
  } catch {}

  // git (fallback, including colocated jj+git repos)
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
  // jj: commit_id of the working-copy parent (@)
  try {
    return execSync("jj log --no-graph -r @ --template commit_id", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {}

  // git (fallback, including colocated jj+git repos)
  try {
    return execSync("git rev-parse HEAD", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch (gitErr: any) {
    throw new Error(
      `Could not resolve HEAD in ${workspaceRoot}: ${gitErr.stderr?.trim() || gitErr.message}`,
    );
  }
}

/** Like getHeadSha, but returns null outside a repo instead of throwing. */
export function getHeadShaOrNull(workspaceRoot: string): string | null {
  try {
    return getHeadSha(workspaceRoot);
  } catch {
    return null;
  }
}

/**
 * Returns the working-copy diff in git unified-diff format.
 * Tries jj first (`jj diff --git`), then falls back to `git diff HEAD`.
 */
export function getGitDiff(workspaceRoot: string): string | null {
  // jj: working-copy changes in git unified-diff format
  try {
    return execSync("jj diff --git", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {}

  // git fallback (also covers colocated jj+git repos)
  try {
    return execSync("git diff HEAD", {
      cwd: workspaceRoot,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

export function getGitStatus(workspaceRoot: string): GitStatus {
  // jj: parse `jj diff --summary` for changed files
  try {
    if (detectJj(workspaceRoot)) {
      const summaryOutput = execSync("jj diff --summary", {
        cwd: workspaceRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });

      const trackedChanged: string[] = [];

      for (const line of summaryOutput.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Lines start with M/A/D/R followed by a space and the path.
        if (/^[MADR] /.test(trimmed)) {
          trackedChanged.push(trimmed.slice(2));
        }
      }

      return { isRepo: true, trackedChanged, untracked: [] };
    }
  } catch {}

  // git fallback (also covers colocated jj+git repos)
  try {
    const isRepo = detectGit();
    if (isRepo) {
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
    }
  } catch {}

  return { isRepo: false, trackedChanged: [], untracked: [] };
}
