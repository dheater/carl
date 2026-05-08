import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (
        char === "\\" &&
        i + 1 < command.length &&
        command[i + 1] === quote
      ) {
        current += command[++i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function getEditorCommand(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}

function runEditor(filePath: string) {
  const editorCommand = getEditorCommand();
  const [editor, ...editorArgs] = splitCommand(editorCommand);
  return {
    editorCommand,
    result: spawnSync(editor || "vi", [...editorArgs, filePath], {
      stdio: "inherit",
    }),
  };
}

export function collectPrompt(
  header = "# What would you like to work on?",
): string | null {
  const template = [header, "# Leave blank to cancel.", ""].join("\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prompt-"));
  const tmpFile = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(tmpFile, template, "utf-8");

  try {
    const { editorCommand, result } = runEditor(tmpFile);
    if (result.error) {
      throw new Error(
        `Failed to open editor '${editorCommand}': ${result.error.message}`,
      );
    }

    const content = fs.readFileSync(tmpFile, "utf-8");
    const response = content
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")
      .trim();

    return response || null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Open a file in the configured editor. Logs warnings but does not throw. */
export function openFileInEditor(filePath: string): void {
  const { result } = runEditor(filePath);

  if (result.error || result.status !== 0) {
    const msg = result.error
      ? `Failed to open file in editor: ${result.error.message}`
      : `Editor exited with status ${result.status}`;
    console.warn(`Warning: ${msg}`);
  }
}

/**
 * Map a phase name and workspace root to the output file path.
 * architect success → .agent/prd.md
 * blocked architect + all other phases → .agent/notes/<phase>.md
 */
export function getPhaseOutputPath(
  workspaceRoot: string,
  phaseName: string,
  status: "success" | "blocked" = "success",
): string {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (phaseName === "architect" && status === "success") {
    return path.join(agentDir, "prd.md");
  }
  return path.join(agentDir, "notes", `${phaseName}.md`);
}
