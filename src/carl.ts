#!/usr/bin/env node

import { runPhase, DEFAULT_MODELS, parsePrdPhases, markPhaseComplete } from "./phase";
import { collectPrompt, openFileInEditor, getPhaseOutputPath } from "./editor";
import { red } from "./colors";
import * as fs from "fs";
import * as path from "path";

function getPendingPromptPath(workspaceRoot: string, command: string): string {
  return path.join(workspaceRoot, ".agent", `pending-${command}-prompt.md`);
}

function collectCommandPrompt(
  workspaceRoot: string,
  command: string,
  promptFile?: string,
  header?: string,
): string | null {
  const pendingPromptPath = getPendingPromptPath(workspaceRoot, command);

  let userInput: string | null;
  if (fs.existsSync(pendingPromptPath)) {
    userInput = fs.readFileSync(pendingPromptPath, "utf-8");
    console.log(`[System] Resuming saved prompt from previous network failure.`);
    console.log(`[System] Run \`carl reset\` then \`carl ${command}\` to start fresh.`);
  } else if (promptFile) {
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    userInput = fs.readFileSync(promptFile, "utf-8").trim() || null;
  } else {
    userInput = collectPrompt(header);
  }

  if (!userInput) {
    return null;
  }

  const agentDir = path.join(workspaceRoot, ".agent");
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(pendingPromptPath, userInput, "utf-8");
  return userInput;
}

function clearPendingPrompt(workspaceRoot: string, command: string): void {
  try {
    fs.unlinkSync(getPendingPromptPath(workspaceRoot, command));
  } catch {
    // Best-effort cleanup.
  }
}

async function cmdPlan(
  workspaceRoot: string,
  promptFile?: string,
  model?: string,
): Promise<void> {
  const userInput = collectCommandPrompt(workspaceRoot, "plan", promptFile);
  if (!userInput) {
    console.log("No prompt provided. Cancelled.");
    return;
  }

  await runPhase(workspaceRoot, "architect", "plan", userInput, model);
  clearPendingPrompt(workspaceRoot, "plan");

  // PRD loop: show prd.md to the user, let them answer inline,
  // re-run architect so it can process each round of feedback.
  // Exits when: user makes no changes (accepted) or architect succeeds.
  const outputPath = getPhaseOutputPath(workspaceRoot, "architect");
  while (fs.existsSync(outputPath)) {
    const before = fs.readFileSync(outputPath, "utf-8");
    openFileInEditor(outputPath);
    const after = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf-8") : "";

    if (after.trimEnd() === before.trimEnd()) break; // No edits — user accepted the plan as-is.

    // User answered the interview questions in prd.md. Re-run architect
    // with an explicit directive so it finalizes the PRD.
    const result = await runPhase(
      workspaceRoot,
      "architect",
      "plan",
      "The user has answered your questions by editing prd.md. The interview is complete. Read prd.md and finalize the PRD with acceptance criteria. Do not ask any more questions.",
      model,
    );
    if (result.status === "success") break;
  }
}

async function cmdCode(
  workspaceRoot: string,
  promptFile?: string,
  model?: string,
): Promise<void> {
  const prdPath = path.join(workspaceRoot, ".agent", "prd.md");
  if (fs.existsSync(prdPath)) {
    const phases = parsePrdPhases(fs.readFileSync(prdPath, "utf-8"));
    if (phases.length > 0) {
      const next = phases.find((p) => !p.completed);
      if (!next) {
        console.log("[System] All phases complete. Run `carl review` to validate.");
        return;
      }
      const remaining = phases.filter((p) => !p.completed).length;
      const phaseNumber = phases.indexOf(next) + 1;
      console.log(`[System] Running phase ${phaseNumber} of ${phases.length}: ${next.title}`);
      const result = await runPhase(
        workspaceRoot,
        "developer",
        "code",
        `Implement this phase from .agent/prd.md: ${next.title}\n\nWork only on this phase. Stop when this phase is complete.`,
        model,
      );
      if (result.status !== "blocked") {
        markPhaseComplete(prdPath, next.lineIndex);
        const stillRemaining = remaining - 1;
        if (stillRemaining > 0) {
          console.log(`[System] Phase complete. ${stillRemaining} phase(s) remaining. Run \`carl code\` to continue.`);
        } else {
          console.log("[System] All phases complete. Run `carl review` to validate.");
        }
      } else {
        console.log("[System] Phase blocked — not marked complete. Fix the blocker then run `carl code` again.");
      }
      const outputPath = getPhaseOutputPath(workspaceRoot, "developer");
      if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
      return;
    }
  }

  const userInput = collectCommandPrompt(
    workspaceRoot,
    "code",
    promptFile,
    "# What should Carl implement?",
  );
  if (!userInput) {
    console.log("No prompt provided. Cancelled.");
    return;
  }

  await runPhase(
    workspaceRoot,
    "developer",
    "code",
    userInput,
    model,
  );
  clearPendingPrompt(workspaceRoot, "code");
  const outputPath = getPhaseOutputPath(workspaceRoot, "developer");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

async function cmdReview(
  workspaceRoot: string,
  model?: string,
): Promise<void> {
  await runPhase(
    workspaceRoot,
    "reviewer",
    "review",
    undefined,
    model,
  );
  const outputPath = getPhaseOutputPath(workspaceRoot, "reviewer");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

async function cmdChat(
  workspaceRoot: string,
  promptFile?: string,
  model?: string,
): Promise<void> {
  const userInput = collectCommandPrompt(
    workspaceRoot,
    "chat",
    promptFile,
    "# Message to agent",
  );
  if (!userInput) {
    console.log("No prompt provided. Cancelled.");
    return;
  }
  let result = await runPhase(
    workspaceRoot,
    "chat",
    "chat",
    userInput,
    model,
  );
  clearPendingPrompt(workspaceRoot, "chat");

  // Chat loop: show chat.md to the user, let them reply inline,
  // re-run chat so it can process each round of feedback.
  // Exits when: user makes no changes (accepted).
  const outputPath = getPhaseOutputPath(workspaceRoot, "chat");
  while (fs.existsSync(outputPath)) {
    const before = fs.readFileSync(outputPath, "utf-8");
    openFileInEditor(outputPath);
    const after = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf-8") : "";

    if (after.trimEnd() === before.trimEnd()) break; // No edits — user accepted the response as-is.

    result = await runPhase(
      workspaceRoot,
      "chat",
      "chat",
      after,
      model,
    );
  }

  if (result.status === "blocked") {
    console.log("[System] Chat response indicated a blocker.");
  }
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
  console.error("Usage: carl [--model <model>] <command>");
  console.error("");
  console.error("Options:");
  console.error("  --model <model>  Override the model for this run (ignores config and defaults)");
  console.error("");
  console.error("Commands:");
  console.error("  plan [<file>]  Read prompt from file or open editor; write .agent/prd.md for complex work");
  console.error("  code [<file>]  Read prompt from file or open editor; run the implementation session");
  console.error("  review        Run reviewer once");
  console.error(`  chat [<file>] Read prompt from file or open editor; run the general-purpose chat skill (default: ${DEFAULT_MODELS.chat})`);
  console.error("  reset         Clear .agent/");
  console.error("");
  console.error("Config: .carl/config.json (optional)");
  console.error(`  { "models": ${JSON.stringify(DEFAULT_MODELS, null, 2)} }`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  let model: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--model") {
      model = rawArgs[++i];
      if (!model) {
        console.error("error: --model requires a value");
        process.exit(1);
      }
    } else {
      args.push(rawArgs[i]);
    }
  }

  const command = args[0];
  const workspaceRoot = process.cwd();

  try {
    switch (command) {
      case "plan":
        if (args.length > 2) {
          console.error("Usage: carl [--model <model>] plan [<prompt-file>]");
          process.exit(1);
        }
        await cmdPlan(workspaceRoot, args[1], model);
        break;
      case "code":
        if (args.length > 2) {
          console.error("Usage: carl [--model <model>] code [<prompt-file>]");
          process.exit(1);
        }
        await cmdCode(workspaceRoot, args[1], model);
        break;
      case "review":
        await cmdReview(workspaceRoot, model);
        break;
      case "chat":
        if (args.length > 2) {
          console.error("Usage: carl [--model <model>] chat [<prompt-file>]");
          process.exit(1);
        }
        await cmdChat(workspaceRoot, args[1], model);
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
