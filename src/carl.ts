#!/usr/bin/env node

import {
  runPhase,
  DEFAULT_MODELS,
  parsePrdPhases,
  markPhaseComplete,
  buildPrReviewInstruction,
  NetworkUnavailableError,
} from "./phase";
import { collectPrompt, openFileInEditor, getPhaseOutputPath } from "./editor";
import {
  parsePrUrl,
  checkGhCli,
  checkRepoMatch,
  fetchPrMetadata,
  fetchPrDiff,
  fetchPrHeadSha,
  submitPrReview,
} from "./github";
import {
  parsePrReviewOutput,
  buildPrReviewDraft,
  parsePrReviewDraft,
  getPrReviewDraftPath,
  getPrReviewPayloadPath,
  type PrReviewPayload,
} from "./pr-review-draft";
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
  if (promptFile) {
    // Explicit file always wins — don't auto-resume a pending prompt.
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    userInput = fs.readFileSync(promptFile, "utf-8").trim() || null;
  } else if (fs.existsSync(pendingPromptPath)) {
    userInput = fs.readFileSync(pendingPromptPath, "utf-8");
    console.log(
      `[System] Resuming saved prompt from previous network failure.`,
    );
    console.log(
      `[System] Run \`carl reset\` then \`carl ${command}\` to start fresh.`,
    );
  } else {
    userInput = collectPrompt(header);
  }

  return userInput || null;
}

function savePendingPrompt(
  workspaceRoot: string,
  command: string,
  input: string,
): void {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    getPendingPromptPath(workspaceRoot, command),
    input,
    "utf-8",
  );
}

function clearPendingPrompt(workspaceRoot: string, command: string): void {
  try {
    fs.unlinkSync(getPendingPromptPath(workspaceRoot, command));
  } catch {
  }
}

type PhaseResult = Awaited<ReturnType<typeof runPhase>>;

function buildPlanFollowUpPrompt(
  userInput: string,
  interviewRounds: string[],
): string {
  const transcript =
    interviewRounds.length > 0
      ? interviewRounds
          .map((round, index) =>
            [`## Round ${index + 1}`, round.trim()].join("\n\n"),
          )
          .join("\n\n")
      : "(no interview rounds)";

  return [
    "# Original planning request",
    userInput.trim(),
    "# Interview transcript",
    transcript,
    "Continue the planning workflow.",
    "If any clarification still blocks a useful PRD, output another `# Interview` with only the remaining questions.",
    "If the request is now clear enough, replace `.agent/prd.md` entirely with the complete PRD.",
  ].join("\n\n");
}

function readEditedFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  const before = fs.readFileSync(filePath, "utf-8");
  openFileInEditor(filePath);
  const after = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";

  return after.trimEnd() === before.trimEnd() ? null : after;
}

async function rerunFromEditedOutput(
  initialResult: PhaseResult,
  options: {
    shouldContinue: (result: PhaseResult) => boolean;
    getOutputPath: () => string;
    rerun: (editedOutput: string) => Promise<PhaseResult>;
  },
): Promise<{ result: PhaseResult; noEdit: boolean }> {
  let result = initialResult;

  while (options.shouldContinue(result)) {
    const outputPath = options.getOutputPath();
    if (!fs.existsSync(outputPath)) break;

    const editedOutput = readEditedFile(outputPath);
    if (editedOutput === null) return { result, noEdit: true };

    result = await options.rerun(editedOutput);
  }

  return { result, noEdit: false };
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

  const agentDir = path.join(workspaceRoot, ".agent");
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
    console.log("Cleared .agent/.");
  }

  const interviewRounds: string[] = [];
  let result: PhaseResult;
  try {
    result = await runPhase(
      workspaceRoot,
      "architect",
      "plan",
      userInput,
      model,
    );
  } catch (err) {
    if (err instanceof NetworkUnavailableError)
      savePendingPrompt(workspaceRoot, "plan", userInput);
    throw err;
  }

  const interviewResult = await rerunFromEditedOutput(result, {
    shouldContinue: (current) => current.status === "blocked",
    getOutputPath: () =>
      getPhaseOutputPath(workspaceRoot, "architect", "blocked"),
    rerun: async (editedInterview) => {
      interviewRounds.push(editedInterview);

      try {
        return await runPhase(
          workspaceRoot,
          "architect",
          "plan",
          buildPlanFollowUpPrompt(userInput, interviewRounds),
          model,
        );
      } catch (err) {
        if (err instanceof NetworkUnavailableError)
          savePendingPrompt(workspaceRoot, "plan", userInput);
        throw err;
      }
    },
  });
  result = interviewResult.result;

  if (interviewResult.noEdit && result.status === "blocked") {
    console.log("No answers provided. Cancelled.");
    return;
  }

  clearPendingPrompt(workspaceRoot, "plan");
  const prdPath = getPhaseOutputPath(workspaceRoot, "architect");
  if (fs.existsSync(prdPath)) openFileInEditor(prdPath);
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
      const nextIndex = phases.findIndex((phase) => !phase.completed);
      const next = nextIndex === -1 ? null : phases[nextIndex];
      if (!next) {
        console.log(
          "[System] All phases complete. Run `carl review` to validate.",
        );
        return;
      }
      const phaseNumber = nextIndex + 1;
      console.log(
        `[System] Running phase ${phaseNumber} of ${phases.length}: ${next.title}`,
      );
      let result: PhaseResult;
      try {
        result = await runPhase(
          workspaceRoot,
          "developer",
          "code",
          `Implement this phase from .agent/prd.md: ${next.title}\n\nWork only on this phase. Stop when this phase is complete.`,
          model,
        );
      } catch (err) {
        if (err instanceof NetworkUnavailableError) {
          console.log(
            `[System] Phase "${next.title}" interrupted by network failure. Run \`carl code\` to retry this phase.`,
          );
        }
        throw err;
      }

      const outputPath = getPhaseOutputPath(workspaceRoot, "developer");
      const interviewResult = await rerunFromEditedOutput(result, {
        shouldContinue: (current) => current.status === "blocked",
        getOutputPath: () => outputPath,
        rerun: async (editedOutput) => {
          try {
            return await runPhase(
              workspaceRoot,
              "developer",
              "code",
              editedOutput,
              model,
            );
          } catch (err) {
            if (err instanceof NetworkUnavailableError) {
              console.log(
                `[System] Phase "${next.title}" interrupted by network failure. Run \`carl code\` to retry this phase.`,
              );
            }
            throw err;
          }
        },
      });
      result = interviewResult.result;

      if (result.status !== "blocked") {
        markPhaseComplete(prdPath, next.lineIndex);
        const stillRemaining = phases.length - phaseNumber;
        if (stillRemaining > 0) {
          console.log(
            `[System] Phase complete. ${stillRemaining} phase(s) remaining. Run \`carl code\` to continue.`,
          );
        } else {
          console.log(
            "[System] All phases complete. Run `carl review` to validate.",
          );
        }
      } else {
        console.log(
          "[System] Phase blocked — not marked complete. Fix the blocker then run `carl code` again.",
        );
      }
      if (!interviewResult.noEdit && fs.existsSync(outputPath)) {
        openFileInEditor(outputPath);
      }
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

  let result: PhaseResult;
  try {
    result = await runPhase(
      workspaceRoot,
      "developer",
      "code",
      userInput,
      model,
    );
  } catch (err) {
    if (err instanceof NetworkUnavailableError)
      savePendingPrompt(workspaceRoot, "code", userInput);
    throw err;
  }
  clearPendingPrompt(workspaceRoot, "code");

  const outputPath = getPhaseOutputPath(workspaceRoot, "developer");
  const interviewResult = await rerunFromEditedOutput(result, {
    shouldContinue: (current) => current.status === "blocked",
    getOutputPath: () => outputPath,
    rerun: async (editedOutput) => {
      try {
        return await runPhase(
          workspaceRoot,
          "developer",
          "code",
          editedOutput,
          model,
        );
      } catch (err) {
        if (err instanceof NetworkUnavailableError)
          savePendingPrompt(workspaceRoot, "code", userInput);
        throw err;
      }
    },
  });
  result = interviewResult.result;

  if (!interviewResult.noEdit && fs.existsSync(outputPath))
    openFileInEditor(outputPath);
}

async function cmdReview(workspaceRoot: string, model?: string): Promise<void> {
  await runPhase(workspaceRoot, "reviewer", "review", undefined, model);
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
  let result: PhaseResult;
  try {
    result = await runPhase(workspaceRoot, "chat", "chat", userInput, model);
  } catch (err) {
    if (err instanceof NetworkUnavailableError)
      savePendingPrompt(workspaceRoot, "chat", userInput);
    throw err;
  }
  clearPendingPrompt(workspaceRoot, "chat");

  const outputPath = getPhaseOutputPath(workspaceRoot, "chat");
  const interviewResult = await rerunFromEditedOutput(result, {
    shouldContinue: () => true,
    getOutputPath: () => outputPath,
    rerun: async (editedOutput) => {
      try {
        return await runPhase(
          workspaceRoot,
          "chat",
          "chat",
          editedOutput,
          model,
        );
      } catch (err) {
        if (err instanceof NetworkUnavailableError)
          savePendingPrompt(workspaceRoot, "chat", userInput);
        throw err;
      }
    },
  });
  result = interviewResult.result;

  if (result.status === "blocked") {
    console.log("[System] Chat response indicated a blocker.");
  }
}

async function cmdPrReview(
  workspaceRoot: string,
  url: string,
  model?: string,
  noPub?: boolean,
): Promise<void> {
  checkGhCli();

  const { owner, repo, number } = parsePrUrl(url);
  checkRepoMatch(workspaceRoot, owner, repo);

  console.log(`Fetching PR metadata for ${owner}/${repo}#${number}...`);
  const metadata = fetchPrMetadata(owner, repo, number);

  console.log(`Fetching diff for ${owner}/${repo}#${number}...`);
  const diff = fetchPrDiff(owner, repo, number);

  console.log(`PR #${metadata.number}: ${metadata.title}`);
  console.log(
    `  ${metadata.headRef} → ${metadata.baseRef} (${metadata.commits.length} commit(s), head ${metadata.headSha.slice(0, 8)})`,
  );

  const prompt = buildPrReviewInstruction(owner, repo, metadata, diff);
  const result = await runPhase(workspaceRoot, "pr-review", "pr-review", prompt, model);
  const reviewComments = parsePrReviewOutput(result.response);
  const draftContent = buildPrReviewDraft(diff, reviewComments, metadata, owner, repo);
  const draftPath = getPrReviewDraftPath(workspaceRoot, owner, repo, number);
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, draftContent, "utf-8");
  const draftRelPath = path.relative(workspaceRoot, draftPath);
  console.log(`Review draft written to ${draftRelPath}`);

  openFileInEditor(draftPath);
  const editedContent = fs.existsSync(draftPath)
    ? fs.readFileSync(draftPath, "utf-8")
    : draftContent;
  const submittedComments = parsePrReviewDraft(editedContent);

  const payload: PrReviewPayload = {
    owner,
    repo,
    number,
    headSha: metadata.headSha,
    comments: submittedComments,
  };
  const payloadPath = getPrReviewPayloadPath(workspaceRoot, owner, repo, number);
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  const payloadRelPath = path.relative(workspaceRoot, payloadPath);

  if (submittedComments.length === 0) {
    console.log(`No comments extracted. Payload written to ${payloadRelPath}`);
    return;
  }

  console.log(
    `Extracted ${submittedComments.length} comment(s). Payload saved to ${payloadRelPath}`,
  );

  if (noPub) {
    console.log(`Skipping GitHub upload (--no-pub).`);
    return;
  }

  const currentHeadSha = fetchPrHeadSha(owner, repo, number);
  if (currentHeadSha !== metadata.headSha) {
    throw new Error(
      `PR ${owner}/${repo}#${number} changed after review was generated.\n` +
        `Review SHA: ${metadata.headSha.slice(0, 8)}, current SHA: ${currentHeadSha.slice(0, 8)}\n` +
        `Extracted comments saved to ${payloadRelPath}. Regenerate the review with: carl pr-review ${url}`,
    );
  }

  console.log(
    `Submitting ${submittedComments.length} comment(s) to ${owner}/${repo}#${number}...`,
  );
  try {
    submitPrReview(owner, repo, number, metadata.headSha, submittedComments);
    console.log(`Review submitted successfully.`);
  } catch (err: any) {
    throw new Error(
      `${err.message}\n` +
        `Review draft remains saved at ${draftRelPath}.\n` +
        `Extracted comments remain saved at ${payloadRelPath}.\n` +
        `To retry: carl pr-review-submit ${url}`,
    );
  }
}

async function cmdPrReviewSubmit(
  workspaceRoot: string,
  url: string,
): Promise<void> {
  checkGhCli();

  const { owner, repo, number } = parsePrUrl(url);
  const payloadPath = getPrReviewPayloadPath(workspaceRoot, owner, repo, number);

  if (!fs.existsSync(payloadPath)) {
    throw new Error(
      `No saved payload found for ${owner}/${repo}#${number}.\n` +
        `Run: carl pr-review ${url}`,
    );
  }

  const payload: PrReviewPayload = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));

  if (payload.comments.length === 0) {
    console.log(`Saved payload for ${owner}/${repo}#${number} has no comments. Nothing to submit.`);
    return;
  }

  const currentHeadSha = fetchPrHeadSha(owner, repo, number);
  if (currentHeadSha !== payload.headSha) {
    throw new Error(
      `PR ${owner}/${repo}#${number} changed since payload was saved.\n` +
        `Payload SHA: ${payload.headSha.slice(0, 8)}, current SHA: ${currentHeadSha.slice(0, 8)}\n` +
        `Regenerate the review with: carl pr-review ${url}`,
    );
  }

  console.log(
    `Submitting ${payload.comments.length} comment(s) to ${owner}/${repo}#${number}...`,
  );
  submitPrReview(owner, repo, number, payload.headSha, payload.comments);
  console.log(`Review submitted successfully.`);
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

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function usage(): void {
  console.error("Usage: carl [--model <model>] <command>");
  console.error("");
  console.error("Options:");
  console.error("  --version        Print version and exit");
  console.error(
    "  --model <model>  Override the model for this run (ignores config and defaults)",
  );
  console.error("");
  console.error("Commands:");
  console.error(
    "  plan [<file>]  Read prompt from file or open editor; write .agent/prd.md for complex work",
  );
  console.error(
    "  code [<file>]  Read prompt from file or open editor; run the implementation session",
  );
  console.error("  review        Run reviewer once");
  console.error(
    `  chat [<file>] Read prompt from file or open editor; run the general-purpose chat skill (default: ${DEFAULT_MODELS.chat})`,
  );
  console.error("  reset         Clear .agent/");
  console.error(
    "  pr-review [--no-pub] <URL>  Fetch and review a GitHub PR (requires gh CLI)",
  );
  console.error(
    "    --no-pub  Skip uploading comments to GitHub",
  );
  console.error(
    "  pr-review-submit <URL>      Re-submit a saved review payload (recovery after failure)",
  );
  console.error("");
  console.error("Config: .carl/config.json (optional)");
  console.error(`  { "models": ${JSON.stringify(DEFAULT_MODELS, null, 2)} }`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("--version")) {
    console.log(`carl ${getVersion()}`);
    return;
  }

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
      case "pr-review": {
        const noPub = args.includes("--no-pub");
        const prArgs = args.filter((a) => a !== "--no-pub");
        if (prArgs.length !== 2) {
          console.error(
            "Usage: carl [--model <model>] pr-review [--no-pub] <github-pr-url>",
          );
          process.exit(1);
        }
        await cmdPrReview(workspaceRoot, prArgs[1], model, noPub);
        break;
      }
      case "pr-review-submit": {
        if (args.length !== 2) {
          console.error(
            "Usage: carl pr-review-submit <github-pr-url>",
          );
          process.exit(1);
        }
        await cmdPrReviewSubmit(workspaceRoot, args[1]);
        break;
      }
      default:
        usage();
        process.exit(1);
    }
  } catch (error: any) {
    console.error(red(error.message ?? String(error)));
    process.exit(1);
  }
}

export const cliPromise = main().catch((error) => {
  console.error(error);
  process.exit(1);
});
