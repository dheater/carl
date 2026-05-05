#!/usr/bin/env node

import { runPhase } from "./phase";
import { collectPrompt, openFileInEditor, getPhaseOutputPath } from "./editor";
import { red } from "./colors";
import * as fs from "fs";
import * as path from "path";

async function cmdPlan(workspaceRoot: string, promptFile?: string): Promise<void> {
  const pendingPromptPath = path.join(workspaceRoot, ".agent", "pending-prompt.md");

  let userInput: string | null;
  if (fs.existsSync(pendingPromptPath)) {
    userInput = fs.readFileSync(pendingPromptPath, "utf-8");
    console.log(`[System] Resuming saved prompt from previous network failure.`);
    console.log(`[System] Run \`carl reset\` then \`carl plan\` to start fresh.`);
  } else if (promptFile) {
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    userInput = fs.readFileSync(promptFile, "utf-8").trim() || null;
  } else {
    userInput = collectPrompt();
  }

  if (!userInput) {
    console.log("No prompt provided. Cancelled.");
    return;
  }

  // Persist the prompt before the network call so a failure doesn't lose it.
  const agentDir = path.join(workspaceRoot, ".agent");
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(pendingPromptPath, userInput, "utf-8");

  let result = await runPhase(workspaceRoot, "architect", "plan", userInput);

  try { fs.unlinkSync(pendingPromptPath); } catch { /* best-effort */ }

  if (result.status !== "success" && result.status !== "blocked") return;

  // Interview loop: show decisions.md to the user, let them answer inline,
  // re-run architect so it can process each round of feedback.
  // Exits when: user makes no changes (accepted), architect succeeds (tickets
  // written), or MAX_ROUNDS is reached (cost guard).
  const outputPath = getPhaseOutputPath(workspaceRoot, "architect");
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS && fs.existsSync(outputPath); round++) {
    const before = fs.readFileSync(outputPath, "utf-8");
    openFileInEditor(outputPath);
    const after = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf-8") : "";

    if (after.trimEnd() === before.trimEnd()) break; // No edits — user accepted the plan as-is.

    // User answered the interview questions in decisions.md. Re-run architect
    // with an explicit directive so it stops interviewing and renders tickets.
    result = await runPhase(
      workspaceRoot,
      "architect",
      "plan",
      "The user has answered your questions by editing decisions.md. The interview is complete. Read decisions.md, finalize scope, and render the ticket list. Do not ask any more questions.",
    );
    if (result.status !== "success" && result.status !== "blocked") return;
    if (result.status === "success") break; // Architect finished — tickets written, no more questions.
  }
}

async function cmdCode(workspaceRoot: string): Promise<void> {
  const result = await runPhase(workspaceRoot, "developer", "code");
  if (result.status === "skipped") return;
  const outputPath = getPhaseOutputPath(workspaceRoot, "developer");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

async function cmdReview(workspaceRoot: string): Promise<void> {
  const result = await runPhase(workspaceRoot, "reviewer", "review");
  if (result.status === "skipped") return;
  const outputPath = getPhaseOutputPath(workspaceRoot, "reviewer");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

function cmdReset(workspaceRoot: string): void {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
    console.log("Cleared .agent/.");
  } else {
    console.log("Nothing to clear.");
  }
}

function usage(): void {
  console.error("Usage: carl <command>");
  console.error("");
  console.error("Commands:");
  console.error("  plan [<file>]  Read prompt from file or open editor; run architect");
  console.error("  code          Run developer once");
  console.error("  review        Run reviewer once");
  console.error("  reset         Clear .agent/");
  console.error("");
  console.error("Config: .carl/config.json (optional)");
  console.error('  { "models": { "architect": "gemini-3.1-pro-preview", "developer": "kimi-k2.6", "reviewer": "sonnet4.6" } }');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const workspaceRoot = process.cwd();

  try {
    switch (command) {
      case "plan":
        if (args.length > 2) {
          console.error("Usage: carl plan [<prompt-file>]");
          process.exit(1);
        }
        await cmdPlan(workspaceRoot, args[1]);
        break;
      case "code":
        await cmdCode(workspaceRoot);
        break;
      case "review":
        await cmdReview(workspaceRoot);
        break;
      case "reset":
        cmdReset(workspaceRoot);
        break;
      default:
        usage();
        process.exit(1);
    }
  } catch (error: any) {
    console.error(red(error.message ?? String(error)));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
