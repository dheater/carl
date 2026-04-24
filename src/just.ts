import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface JustResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestResult extends JustResult {
  command: string;
  usedJust: boolean;
}

export interface LintResult extends JustResult {
  status: "PASS" | "FAIL" | "SKIP";
  statusReason?: string;
}

/**
 * Run a Just target in the given workspace, preferring devbox if available.
 *
 * @param workspaceRoot The root directory of the workspace
 * @param target The Just target to run (e.g., "format", "lint")
 * @returns A structured result with exitCode, stdout, and stderr
 */
export function runJust(workspaceRoot: string, target: string): JustResult {
  const hasDevbox = fs.existsSync(path.join(workspaceRoot, "devbox.json"));

  const command = hasDevbox ? "devbox" : "just";
  const args = hasDevbox ? ["run", "just", target] : [target];

  try {
    const result = spawnSync(command, args, {
      cwd: workspaceRoot,
      encoding: "utf-8",
    });

    // Convert Buffer to string if needed (for mocked results)
    const stdout = result.stdout ? String(result.stdout) : "";
    const stderr = result.stderr ? String(result.stderr) : "";

    return {
      exitCode: result.status ?? (result.error ? 127 : 0),
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: `Unable to run ${command}: just command is unavailable for workspace ${workspaceRoot}`,
    };
  }
}

/**
 * Run the Just "format" target in the workspace.
 * Non-fatal: does not throw even if format fails or modifies files.
 *
 * @param workspaceRoot The root directory of the workspace
 * @returns A structured result with exitCode, stdout, and stderr
 */
export function runJustFormat(workspaceRoot: string): JustResult {
  return runJust(workspaceRoot, "format");
}

/**
 * Run the Just "lint" target and write output to .agent/lint.log.
 * Returns a LintResult with explicit status: PASS, FAIL, or SKIP (if no lint rule exists).
 * Non-fatal: does not throw even if lint fails.
 *
 * @param workspaceRoot The root directory of the workspace
 * @returns A LintResult with status (PASS/FAIL/SKIP), exitCode, stdout, and stderr
 */
export function runJustLint(workspaceRoot: string): LintResult {
  const result = runJust(workspaceRoot, "lint");

  // Write lint output to .agent/lint.log
  const agentDir = path.join(workspaceRoot, ".agent");
  const lintLogPath = path.join(agentDir, "lint.log");

  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  // Determine the command that was run
  const devboxPath = path.join(workspaceRoot, "devbox.json");
  const hasDevbox = fs.existsSync(devboxPath);
  const command = hasDevbox ? "devbox run just lint" : "just lint";

  // Detect if "lint" rule doesn't exist in Justfile
  // Common error: "error: recipe 'lint' not found"
  const ruleNotFound =
    result.stderr.includes("recipe 'lint' not found") ||
    result.stderr.includes("unknown recipe") ||
    (result.exitCode === 127 && result.stderr.includes("just"));

  let status: "PASS" | "FAIL" | "SKIP";
  let statusReason: string | undefined;

  if (ruleNotFound) {
    status = "SKIP";
    statusReason = "No lint rule defined in Justfile";
  } else if (result.exitCode === 0) {
    status = "PASS";
  } else {
    status = "FAIL";
  }

  const logContent = `Command: ${command}
Status: ${status}${statusReason ? ` (${statusReason})` : ""}

Stdout:
${result.stdout}

Stderr:
${result.stderr}`;
  fs.writeFileSync(lintLogPath, logContent, "utf-8");

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    status,
    statusReason,
  };
}

/**
 * Run the project's tests using the canonical test command.
 * Prefers `just test` if a Justfile is present, falls back to `npm test` if available.
 *
 * @param workspaceRoot The root directory of the workspace
 * @returns A structured result including exitCode, stdout, stderr, command, and usedJust flag
 */
export function runCanonicalTests(workspaceRoot: string): TestResult {
  const justfilePath = path.join(workspaceRoot, "Justfile");
  const packageJsonPath = path.join(workspaceRoot, "package.json");

  // Try just test if Justfile exists
  if (fs.existsSync(justfilePath)) {
    const result = runJust(workspaceRoot, "test");
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      command: "just test",
      usedJust: true,
    };
  }

  // Fall back to npm test if package.json with test script exists
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      if (packageJson.scripts?.test) {
        const result = spawnSync("npm", ["test"], {
          cwd: workspaceRoot,
          encoding: "utf-8",
        });

        const stdout = result.stdout ? String(result.stdout) : "";
        const stderr = result.stderr ? String(result.stderr) : "";

        return {
          exitCode: result.status ?? (result.error ? 127 : 0),
          stdout,
          stderr,
          command: "npm test",
          usedJust: false,
        };
      }
    } catch {
      // If package.json parsing fails, fall through to error case
    }
  }

  // No test command found
  return {
    exitCode: 1,
    stdout: "",
    stderr:
      "No test command found. Please add a `just test` recipe or `npm test` script.",
    command: "",
    usedJust: false,
  };
}
