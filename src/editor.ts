import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function collectPrompt(
  header = "# What would you like to work on?",
): string | null {
  const template = [header, "# Leave blank to cancel.", ""].join("\n");

  const tmpFile = path.join(os.tmpdir(), `carl-prompt-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, template, "utf-8");

  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const result = spawnSync(editor, [tmpFile], {
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    fs.unlinkSync(tmpFile);
    throw new Error(
      `Failed to open editor '${editor}': ${result.error.message}`,
    );
  }

  const content = fs.readFileSync(tmpFile, "utf-8");
  fs.unlinkSync(tmpFile);

  const response = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n")
    .trim();

  return response || null;
}

/**
 * Open a file in the user's editor ($EDITOR, $VISUAL, or vi).
 * Resolves env precedence and uses spawnSync with stdio: inherit.
 * Logs a warning on error but does not throw.
 */
export function openFileInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const result = spawnSync(editor, [filePath], {
    stdio: "inherit",
    shell: true,
  });

  if (result.error || result.status !== 0) {
    const msg = result.error
      ? `Failed to open file in editor: ${result.error.message}`
      : `Editor exited with status ${result.status}`;
    console.warn(`Warning: ${msg}`);
  }
}

/**
 * Map a phase name and workspace root to the output file path.
 * architect → .agent/prd.md
 * all other phases → .agent/notes/<phase>.md
 */
export function getPhaseOutputPath(
  workspaceRoot: string,
  phaseName: string,
): string {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (phaseName === "architect") {
    return path.join(agentDir, "prd.md");
  }
  return path.join(agentDir, "notes", `${phaseName}.md`);
}
