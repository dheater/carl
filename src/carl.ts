#!/usr/bin/env node

import {
  runPhase,
  DEFAULT_MODELS,
  parsePrdPhases,
  markPhaseComplete,
  NetworkUnavailableError,
} from "./phase";
import {
  collectPrompt,
  openFileInEditor,
  getPhaseOutputPath,
} from "./editor";
import {
  parsePrUrl,
  checkGhCli,
  checkRepoMatch,
  fetchPrMetadata,
  fetchPrDiff,
  checkNotForkPr,
  createPendingReview,
} from "./github";
import {
  getPrReviewDraftPath,
  buildPrReviewDraft,
  parsePrReviewDraftComments,
  parseDiffHunks,
  validateCommentsInScope,
  validateInlineCommentsHaveRationale,
  type ReviewComment,
} from "./pr-review-draft";
import { getGitStatus, getHeadSha } from "./git";
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
): Promise<void> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(
      `\`carl pr-review\` now requires a GitHub PR URL.\n` +
        `Usage: carl pr-review https://github.com/owner/repo/pull/NUMBER\n` +
        `(received: ${JSON.stringify(url)})`,
    );
  }

  checkGhCli();

  const { owner, repo, number } = parsePrUrl(url);

  checkRepoMatch(workspaceRoot, owner, repo);

  console.log(`Fetching PR metadata for ${owner}/${repo}#${number}...`);
  const metadata = fetchPrMetadata(owner, repo, number);
  checkNotForkPr(metadata, owner, repo);

  const localHead = getHeadSha(workspaceRoot);
  if (localHead !== metadata.headSha) {
    throw new Error(
      `Local HEAD (${localHead.slice(0, 8)}) does not match PR head (${metadata.headSha.slice(0, 8)}).\n` +
        `Check out the PR branch at the correct commit:\n` +
        `  git fetch origin && git checkout ${metadata.headSha}`,
    );
  }

  const driftedFiles = getGitStatus(workspaceRoot).trackedChanged.filter(
    (file) => file !== ".agent" && !file.startsWith(".agent/"),
  );
  if (driftedFiles.length > 0) {
    throw new Error(
      `Local checkout has tracked changes outside .agent and may not match the PR head cleanly.\n` +
        `Revert or stash these files before reviewing:\n` +
        driftedFiles.map((file) => `  - ${file}`).join("\n"),
    );
  }

  console.log(`Fetching PR diff...`);
  const prDiff = fetchPrDiff(owner, repo, number);
  if (!prDiff.trim()) {
    throw new Error(`No diff for ${owner}/${repo}#${number}. Nothing to review.`);
  }

  const agentDir = path.join(workspaceRoot, ".agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const draftPath = getPrReviewDraftPath(workspaceRoot);
  const draftRel = path.relative(workspaceRoot, draftPath);
  const prIdentity = `${owner}/${repo}#${number}`;
  fs.writeFileSync(
    draftPath,
    buildPrReviewDraft(prDiff, prIdentity, metadata.headSha),
    "utf-8",
  );

  function assertDraftExists(): void {
    if (!fs.existsSync(draftPath)) {
      throw new Error(
        `Draft ${draftRel} is missing.\n` +
          `Reset .agent and re-run: carl pr-review ${url}`,
      );
    }
  }

  const initialPrompt = [
    `Review GitHub PR ${prIdentity}.`,
    `The draft file is at \`${draftRel}\` and contains the full PR diff.`,
    `Append \`||| COMMENT\` blocks under \`## Review comments\` per the pr-reviewer skill.`,
    `Inline comments must reference a path + new-side line that appears in a diff hunk; multi-line ranges must lie within a single hunk.`,
    `Every inline comment must start with a rationale line explaining WHY the change matters; the reader is the PR author.`,
    `Write prose comments only — do not write suggestion blocks.`,
    `Read any workspace file you need for context. Do not modify any file outside the draft.`,
  ].join("\n");

  await runPhase(workspaceRoot, "pr-reviewer", "pr-review", initialPrompt, model);
  assertDraftExists();

  const hunks = parseDiffHunks(prDiff);
  function loadCommentsAndErrors(): {
    comments: ReviewComment[];
    errors: string[];
  } {
    try {
      const comments = parsePrReviewDraftComments(fs.readFileSync(draftPath, "utf-8"));
      return {
        comments,
        errors: [
          ...validateCommentsInScope(comments, hunks),
          ...validateInlineCommentsHaveRationale(comments),
        ],
      };
    } catch (err: any) {
      return {
        comments: [],
        errors: [err?.message ?? String(err)],
      };
    }
  }

  let { comments, errors } = loadCommentsAndErrors();

  if (errors.length > 0) {
    const rerunPrompt = [
      `Some review comments in \`${draftRel}\` will be rejected.`,
      ``,
      `Errors:`,
      ...errors.map((e) => `- ${e}`),
      ``,
      `Inline comments must reference a path + new-side line that appears in a PR diff hunk (added \`+\` or context line); multi-line ranges must lie within a single hunk.`,
      `Inline comments must also start with a rationale line that explains WHY the change matters.`,
      ``,
      `Edit \`${draftRel}\`: remove or fix only the failing comments and keep the valid ones. Do not modify any other file.`,
    ].join("\n");
    await runPhase(workspaceRoot, "pr-reviewer", "pr-review", rerunPrompt, model);
    assertDraftExists();
    ({ comments, errors } = loadCommentsAndErrors());
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid review comments remain in ${draftRel}:\n` +
        errors.map((e) => `  - ${e}`).join("\n") +
        `\nEdit ${draftRel} by hand and re-run: carl pr-review ${url}`,
    );
  }

  if (comments.length === 0) {
    throw new Error(
      `No \`||| COMMENT\` blocks found in ${draftRel}. Add comments or delete the draft.`,
    );
  }

  console.log(
    `Creating pending review on ${prIdentity} (${comments.length} comment(s))...`,
  );
  const reviewId = createPendingReview(
    owner,
    repo,
    number,
    metadata.headSha,
    comments,
  );
  console.log(
    `Pending review created (id: ${reviewId}).\n` +
      `Open the PR on GitHub and submit it.`,
  );
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
  console.error("  review        Run reviewer once (your own local changes)");
  console.error(
    `  chat [<file>] Read prompt from file or open editor; run the general-purpose chat skill (default: ${DEFAULT_MODELS.chat})`,
  );
  console.error("  reset         Clear .agent/");
  console.error(
    "  pr-review <github-pr-url>  Fetch PR diff, draft review comments in .agent/pr-review.md, and upload as a pending GitHub review (requires gh CLI)",
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
        if (args.length !== 2) {
          console.error("Usage: carl pr-review <github-pr-url>");
          process.exit(1);
        }
        await cmdPrReview(workspaceRoot, args[1], model);
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
