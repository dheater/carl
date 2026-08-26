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

/**
 * Whether a terminal editor has a terminal to take over.
 *
 * A backgrounded, piped, or CI run has no tty, and `vi` handed a dead stdin does
 * not fail — it waits. A `carl feedback` run in a script sat on an invisible nvim
 * for twenty minutes before anyone noticed, so every editor call checks first.
 */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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

function throwIfEditorFailed(
  editorCommand: string,
  result: ReturnType<typeof spawnSync>,
): void {
  if (result.error) {
    throw new Error(
      `Failed to open editor '${editorCommand}': ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Editor '${editorCommand}' exited with status ${result.status}.`,
    );
  }
}

export function collectPrompt(
  header = "# What would you like to work on?",
): string | null {
  if (!isInteractive()) {
    throw new Error(
      `No terminal here, so carl cannot open an editor to ask for the prompt.\n` +
        `Write the prompt to a file and pass it: carl <command> <file>`,
    );
  }

  const template = [header, "# Leave blank to cancel.", ""].join("\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prompt-"));
  const tmpFile = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(tmpFile, template, "utf-8");

  try {
    const { editorCommand, result } = runEditor(tmpFile);
    throwIfEditorFailed(editorCommand, result);

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

export function openFileInEditor(filePath: string): void {
  if (!isInteractive()) {
    console.log(`Wrote ${filePath}`);
    return;
  }

  const { result } = runEditor(filePath);

  if (result.error || result.status !== 0) {
    const msg = result.error
      ? `Failed to open file in editor: ${result.error.message}`
      : `Editor exited with status ${result.status}`;
    console.warn(`Warning: ${msg}`);
  }
}

export function getSkillOutputPath(
  workspaceRoot: string,
  skill: string,
): string {
  const agentDir = path.join(workspaceRoot, ".agent");
  return path.join(agentDir, "notes", `${skill}.md`);
}
