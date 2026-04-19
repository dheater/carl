import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function collectPrompt(): string | null {
  const template = [
    "# What would you like to work on?",
    "# Leave blank to cancel.",
    "",
  ].join("\n");

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

export type EditorAction =
  | { action: "approve" }
  | { action: "reject"; reason: string; target?: string }
  | { action: "reply"; message: string };

export function openEditorForGate(
  phaseName: string,
  agentOutput: string,
): EditorAction {
  const header = [
    `# [${phaseName}] is waiting for your input`,
    `# Edit below as needed — add notes, answer questions inline.`,
    `# Write "reject: <reason>" on its own line to reject (returns to the developer).`,
    `# Write "reject-architect: <reason>" to reject back to architect instead.`,
    `# Save and close to approve without edits, or write "approve" on its own line to approve with notes.`,
    ``,
  ].join("\n");

  const template = header + agentOutput.trimEnd();

  const tmpFile = path.join(os.tmpdir(), `carl-gate-${Date.now()}.md`);
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

  return parseEditorGateApproval(content, template);
}

// Test helper: exposed for unit tests
export function parseEditorGateApproval(
  content: string,
  template: string,
): EditorAction {
  const nonCommentLines = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"));

  // Explicit reject signal: "reject: reason" or "reject-<phase>: reason" (unindented)
  const rejectMatch = nonCommentLines
    .map((l) => l.match(/^reject(?:-(\w+))?:\s*(.*)/i))
    .find(Boolean);
  if (rejectMatch) {
    const target = rejectMatch[1]?.toLowerCase();
    const reason = rejectMatch[2]?.trim() ?? "";
    return { action: "reject", reason, ...(target ? { target } : {}) };
  }

  // Explicit approve signal: "approve" or "approved" with optional surrounding whitespace
  // Also supports "approve: ..." syntax for backwards compatibility
  const approveMatch = nonCommentLines
    .map((l) => {
      const trimmed = l.trim();
      // Match "approve" or "approved" as sole content (case-insensitive)
      if (/^approved?(?::\s*.*)?$/i.test(trimmed)) {
        return trimmed;
      }
      return null;
    })
    .find(Boolean);
  if (approveMatch) {
    return { action: "approve" };
  }

  const normalize = (lines: string[]) => lines.join("\n").trim();
  const normalizedBody = normalize(nonCommentLines);

  // Empty body (user deleted everything) → approve
  if (normalizedBody === "") {
    return { action: "approve" };
  }

  // Unchanged body (user saved without edits) → approve
  const templateNonComment = template
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"));
  if (normalizedBody === normalize(templateNonComment)) {
    return { action: "approve" };
  }

  return { action: "reply", message: content.trim() };
}
