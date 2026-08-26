#!/usr/bin/env node

import {
  runSkill,
  runSkillWithValidation,
  resolveValidation,
  DEFAULT_MODELS,
  DEFAULT_EFFORTS,
  DEFAULT_MAX_RETRIES,
  getSkillModel,
  getSkillEffort,
  loadCarlConfig,
  type SkillValidation,
} from "./skill";
import type { EffortLevel } from "./types";
import { cmdStats } from "./stats-command";
import { DshRunner, BEDROCK_MODEL_IDS } from "./dsh-runner";
import type { AgentRunner } from "./types";
import { collectPrompt, openFileInEditor, getSkillOutputPath } from "./editor";
import { checkGhCli, fetchPrMetadata, fetchPrDiff } from "./github";
import { checkTuicrCli, openPrReviewInTuicr } from "./tuicr";
import {
  getPrReviewDraftPath,
  buildPrReviewDraft,
  parsePrReviewDraftComments,
  parseDiffHunks,
  validateCommentsInScope,
  validateNoDuplicateInlineComments,
  validateInlineCommentsHaveRationale,
  type ReviewComment,
} from "./pr-review-draft";
import { getGitStatus, getHeadSha } from "./git";
import { red } from "./colors";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

/**
 * There is one runner: a DeepSeek Harness runtime on Bedrock. A stale
 * `"backend"` in config.json is ignored rather than rejected, since the field
 * only ever had one valid value by the time it was removed.
 */
function createRunner(skill: string, model: string): AgentRunner {
  if (!BEDROCK_MODEL_IDS[model]) {
    const supportedModels = Object.keys(BEDROCK_MODEL_IDS).join(", ");
    throw new Error(
      `Model "${model}" is not a known Bedrock model.\n` +
        `Supported models: ${supportedModels}\n` +
        `Set a supported model for ${skill} in ~/.config/carl/config.json.`,
    );
  }
  return new DshRunner();
}

function collectCommandPrompt(
  promptFile?: string,
  header?: string,
): string | null {
  let userInput: string | null;
  if (promptFile) {
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    userInput = fs.readFileSync(promptFile, "utf-8").trim() || null;
  } else {
    userInput = collectPrompt(header);
  }
  return userInput || null;
}

/**
 * `carl ask` and `carl plan`: one read-only session that answers in prose and
 * leaves the workspace alone. Neither validates — there is nothing to check when
 * nothing changed — so this is `carl code` without the loop.
 *
 * Returns whether a session ran, so `plan` can tell the human what to do with a
 * plan and stay quiet when there is none.
 */
async function cmdReadOnlyPrompt(
  workspaceRoot: string,
  skill: "ask" | "plan",
  model: string,
  effort: EffortLevel,
  header: string,
  promptFile?: string,
): Promise<boolean> {
  const initialPrompt = collectCommandPrompt(promptFile, header);
  if (!initialPrompt) {
    console.log("No prompt provided. Cancelled.");
    return false;
  }

  await runSkill(
    workspaceRoot,
    skill,
    initialPrompt,
    model,
    effort,
    createRunner(skill, model),
  );
  const outputPath = getSkillOutputPath(workspaceRoot, skill);
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
  return true;
}

async function cmdPlan(
  workspaceRoot: string,
  model: string,
  effort: EffortLevel,
  promptFile?: string,
): Promise<void> {
  const ran = await cmdReadOnlyPrompt(
    workspaceRoot,
    "plan",
    model,
    effort,
    "# What should Carl plan?",
    promptFile,
  );
  if (!ran) return;
  // A plan is only worth writing if something acts on it, and the file is the
  // whole handoff: `carl code --plan` re-reads it, edits included.
  const planPath = path.relative(
    workspaceRoot,
    getSkillOutputPath(workspaceRoot, "plan"),
  );
  console.log(
    `Plan saved to ${planPath}. Edit it, then run \`carl code --plan\` to implement it.`,
  );
}

async function cmdReview(
  workspaceRoot: string,
  model: string,
  effort: EffortLevel,
): Promise<void> {
  const runner = createRunner("review", model);
  await runSkill(
    workspaceRoot,
    "review",
    "Review all staged and uncommitted local changes. Make recommendations to the user.",
    model,
    effort,
    runner,
  );
  const outputPath = getSkillOutputPath(workspaceRoot, "review");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

/**
 * `carl code` and `carl feedback`: one session that changes the workspace, then
 * the configured check, then a repair loop. They differ only in the skill and the
 * question asked in the editor, so they share the outcome reporting below.
 */
async function cmdValidatedPrompt(
  workspaceRoot: string,
  skill: "code" | "feedback",
  header: string,
  model: string,
  effort: EffortLevel,
  validation: SkillValidation | undefined,
  promptFile?: string,
): Promise<void> {
  const initialPrompt = collectCommandPrompt(promptFile, header);
  if (!initialPrompt) {
    console.log("No prompt provided. Cancelled.");
    return;
  }

  const result = await runSkillWithValidation(
    workspaceRoot,
    skill,
    initialPrompt,
    model,
    effort,
    createRunner(skill, model),
    validation,
  );
  const outputPath = getSkillOutputPath(workspaceRoot, skill);
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);

  // Reported after the editor closes so it is the last thing on screen, and as a
  // non-zero exit so a keybind or script can tell a red run from a green one.
  // Not thrown: the notes are worth reading either way.
  const outcome = result.validation;
  if (outcome && !outcome.ok) {
    const runs = `${outcome.runs} run${outcome.runs === 1 ? "" : "s"}`;
    // What to do next depends on why carl stopped: more budget helps an exhausted
    // one and is useless on a stalled or timed-out one.
    const [what, next] = {
      budget: [
        `Validation is still failing after ${runs}`,
        `Fix it yourself, or run \`carl ${skill}\` again saying what to fix. Raise \`maxRetries\` in .carl/config.json to give carl more attempts.`,
      ],
      stalled: [
        `Validation is still failing after ${runs}, and the last session changed no files`,
        `Another run would repeat it, so carl stopped. Say what to fix and run \`carl ${skill}\` again.`,
      ],
      timeout: [
        `Validation did not finish, so nothing here is checked`,
        `Run the command yourself to see why, or point \`validate\` at a faster check.`,
      ],
      passed: [`Validation failed`, `Run the command yourself to see why.`],
    }[outcome.stopped];
    console.error(
      red(
        `${what}: \`${outcome.result.command}\`\n` +
          `Carl left the workspace as the last run made it — nothing was reverted.\n` +
          next,
      ),
    );
    if (outcome.result.output.trim()) {
      console.error(`\n${outcome.result.output.trim()}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Notes from an earlier skill, used as this command's prompt: `carl code --plan`
 * takes the plan, `carl feedback --review` takes the review.
 *
 * The absence is checked here rather than left to the generic "prompt file not
 * found", because the fix is a different command and `carl reset` is a common way
 * to arrive here.
 */
function savedNotesPromptFile(
  command: string,
  flag: string,
  source: string,
  workspaceRoot: string,
): string {
  const notesPath = getSkillOutputPath(workspaceRoot, source);
  if (!fs.existsSync(notesPath)) {
    throw new Error(
      `\`carl ${command} ${flag}\` found nothing at ${path.relative(workspaceRoot, notesPath)}.\n` +
        `That file is written by \`carl ${source}\` and deleted by \`carl reset\`.\n` +
        `Run \`carl ${source}\` first, or pass a prompt file: carl ${command} <file>`,
    );
  }
  return notesPath;
}

/**
 * `carl pr-review` takes the PR number of the repo in the current directory;
 * gh and tuicr both resolve owner/repo from the checkout. A URL used to be
 * required, so say so instead of failing on "not a number".
 */
function parsePrNumber(arg: string): number {
  if (!/^#?\d+$/.test(arg.trim())) {
    throw new Error(
      `\`carl pr-review\` takes the PR number of the repo in the current directory.\n` +
        `Usage: carl pr-review <pr-number>   (e.g. carl pr-review 42)\n` +
        `(received: ${JSON.stringify(arg)})`,
    );
  }
  return parseInt(arg.trim().replace(/^#/, ""), 10);
}

async function cmdPrReview(
  workspaceRoot: string,
  prArg: string,
  model: string,
  effort: EffortLevel,
): Promise<void> {
  const number = parsePrNumber(prArg);

  checkGhCli();
  checkTuicrCli();

  console.log(`Fetching PR metadata for #${number}...`);
  const metadata = fetchPrMetadata(workspaceRoot, number);

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
  const prDiff = fetchPrDiff(workspaceRoot, number);
  if (!prDiff.trim()) {
    throw new Error(`No diff for PR #${number}. Nothing to review.`);
  }

  const agentDir = path.join(workspaceRoot, ".agent/notes");
  fs.mkdirSync(agentDir, { recursive: true });
  const draftPath = getPrReviewDraftPath(workspaceRoot);
  const draftRel = path.relative(workspaceRoot, draftPath);
  const prIdentity = metadata.url;
  fs.writeFileSync(
    draftPath,
    buildPrReviewDraft(prDiff, prIdentity, metadata.headSha),
    "utf-8",
  );

  function assertDraftExists(): void {
    if (!fs.existsSync(draftPath)) {
      throw new Error(
        `Draft ${draftRel} is missing.\n` +
          `Reset .agent and re-run: carl pr-review ${number}`,
      );
    }
  }

  const runner = createRunner("pr-review", model);

  const initialPrompt = [
    `Review GitHub PR ${prIdentity}.`,
    `The draft file is at \`${draftRel}\` and contains the full PR diff.`,
    `Append \`||| COMMENT\` blocks under \`## Review comments\` per the pr-review skill.`,
    `Inline comments must reference a path + new-side line that appears in a diff hunk; multi-line ranges must lie within a single hunk.`,
    `Every inline comment must open with a sentence saying what is wrong, in plain language, then say what you would do about it. Write for a junior developer reading it on GitHub with no other context.`,
    `Write prose comments only — do not write suggestion blocks.`,
    `Read any workspace file you need for context. Do not modify any file outside the draft.`,
  ].join("\n");

  await runSkill(
    workspaceRoot,
    "pr-review",
    initialPrompt,
    model,
    effort,
    runner,
  );
  assertDraftExists();

  const hunks = parseDiffHunks(prDiff);
  function loadCommentsAndErrors(): {
    comments: ReviewComment[];
    errors: string[];
  } {
    try {
      const comments = parsePrReviewDraftComments(
        fs.readFileSync(draftPath, "utf-8"),
      );
      return {
        comments,
        errors: [
          ...validateCommentsInScope(comments, hunks),
          ...validateNoDuplicateInlineComments(comments),
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
      `Inline comments must also open with a prose line saying what is wrong, in plain language, before anything else.`,
      ``,
      `Edit \`${draftRel}\`: remove or fix only the failing comments and keep the valid ones. Do not modify any other file.`,
    ].join("\n");
    await runSkill(
      workspaceRoot,
      "pr-review",
      rerunPrompt,
      model,
      effort,
      runner,
    );
    assertDraftExists();
    ({ comments, errors } = loadCommentsAndErrors());
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid review comments remain in ${draftRel}:\n` +
        errors.map((e) => `  - ${e}`).join("\n") +
        `\nEdit ${draftRel} by hand and re-run: carl pr-review ${number}`,
    );
  }

  if (comments.length === 0) {
    throw new Error(
      `No \`||| COMMENT\` blocks found in ${draftRel}. Add comments or delete the draft.`,
    );
  }

  console.log(
    `Opening PR #${number} in tuicr with ${comments.length} drafted comment(s)...`,
  );
  await openPrReviewInTuicr(workspaceRoot, number, comments, `carl (${model})`);
  console.log(
    `tuicr closed. The drafted comments are still in ${draftRel}.\n` +
      `Nothing was sent to GitHub unless you ran \`:submit\` in tuicr.`,
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

declare const CARL_VERSION: string;

function getVersion(): string {
  try {
    return CARL_VERSION;
  } catch {
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
}

function usage(): void {
  console.error("Usage: carl [--model <model>] [--effort <level>] <command>");
  console.error("");
  console.error("Options:");
  console.error("  --version              Print version and exit");
  console.error(
    "  --model <model>        Override the model for this run (ignores config and defaults)",
  );
  console.error(
    "  --effort <level>       Override effort for this run: low, medium, high (ignores config and defaults)",
  );
  console.error("");
  console.error("Commands:");
  console.error(
    `  code [<file>|--plan] Read prompt from file, from the saved plan (--plan), or open editor; run the implementation skill (default model: ${DEFAULT_MODELS.code}, default effort: ${DEFAULT_EFFORTS.code})`,
  );
  console.error(
    `  ask [<file>]  Ask a question about the code; read-only session, answer written to .agent/notes/ask.md (default effort: ${DEFAULT_EFFORTS.ask})`,
  );
  console.error(
    `  plan [<file>] Plan a change without making it; read-only session, plan written to .agent/notes/plan.md for \`carl code --plan\` (default effort: ${DEFAULT_EFFORTS.plan})`,
  );
  console.error(
    `  review        Run reviewer once (cleanup/refactor your own local changes) (default effort: ${DEFAULT_EFFORTS.review})`,
  );
  console.error(
    `  feedback [<file>|--review] Assess review comments, apply the correct ones, and report how each was disposed of; validates like \`code\` (default effort: ${DEFAULT_EFFORTS.feedback})`,
  );
  console.error("  reset         Clear .agent/");
  console.error(
    `  pr-review <pr-number>  Draft review comments for a PR of the repo in the current directory, then open them in tuicr to review, edit, and submit (requires gh and tuicr) (default effort: ${DEFAULT_EFFORTS["pr-review"]})`,
  );
  console.error(
    "  stats         Report cost, tokens, turns, and duration per skill from the event log",
  );
  console.error("");
  console.error("stats options:");
  console.error(
    "  --this-week | --this-month | --this-year | --all   Time range (default: --this-week)",
  );
  console.error(
    "  --from YYYY-MM-DD --to YYYY-MM-DD                  Explicit range (--to is inclusive)",
  );
  console.error("  --skill <name>         Limit the report to one skill");
  console.error("  --json                 Emit the aggregates as JSON");
  console.error(
    "  --rebuild              Discard the derived metrics cache and re-read the logs",
  );
  console.error("");
  console.error(
    "Config: ~/.config/carl/config.json (global default), .carl/config.json (local override, optional)",
  );
  console.error(
    `  { "models": ${JSON.stringify(DEFAULT_MODELS, null, 2)}, "effort": "high", "efforts": { "code": "medium", "review": "high", "pr-review": "high" } }`,
  );
  console.error("");
  console.error(
    `  "validate": "<shell command>"   After \`carl code\` or \`carl feedback\`, run this to check the work; on failure, re-run the skill with the output`,
  );
  console.error(
    `  "maxRetries": <n>               Repair runs allowed after a failed validation (default: ${DEFAULT_MAX_RETRIES}, 0 to report only)`,
  );
}

function resolveSkillArgs(
  skill: string,
  model: string | undefined,
  effort: EffortLevel | undefined,
  carlConfig: ReturnType<typeof loadCarlConfig>,
): { model: string; effort: EffortLevel } {
  return {
    model: model ?? getSkillModel(skill, carlConfig),
    effort: effort ?? getSkillEffort(skill, carlConfig),
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("--version")) {
    console.log(`carl ${getVersion()}`);
    return;
  }

  let model: string | undefined;
  let effort: "low" | "medium" | "high" | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--model") {
      model = rawArgs[++i];
      if (!model) {
        console.error("error: --model requires a value");
        process.exit(1);
      }
    } else if (rawArgs[i] === "--effort") {
      const val = rawArgs[++i];
      if (!val) {
        console.error("error: --effort requires a value");
        process.exit(1);
      }
      if (val !== "low" && val !== "medium" && val !== "high") {
        console.error(
          `error: --effort must be one of: low, medium, high (got: ${JSON.stringify(val)})`,
        );
        process.exit(1);
      }
      effort = val;
    } else {
      args.push(rawArgs[i]);
    }
  }

  const command = args[0];
  const workspaceRoot = process.cwd();

  try {
    // Reporting reads the event log only; it needs no config and must not
    // create one as a side effect of asking how much carl costs.
    if (command === "stats") {
      cmdStats(args.slice(1));
      return;
    }

    const carlConfig = loadCarlConfig(workspaceRoot);
    switch (command) {
      case "code": {
        if (args.length > 2) {
          console.error(
            "Usage: carl [--model <model>] [--effort <level>] code [<prompt-file> | --plan]",
          );
          process.exit(1);
        }
        const { model: resolvedModel, effort: resolvedEffort } =
          resolveSkillArgs("code", model, effort, carlConfig);
        await cmdValidatedPrompt(
          workspaceRoot,
          "code",
          "# What should Carl implement?",
          resolvedModel,
          resolvedEffort,
          resolveValidation(carlConfig),
          args[1] === "--plan"
            ? savedNotesPromptFile("code", "--plan", "plan", workspaceRoot)
            : args[1],
        );
        break;
      }
      case "feedback": {
        if (args.length > 2) {
          console.error(
            "Usage: carl [--model <model>] [--effort <level>] feedback [<feedback-file> | --review]",
          );
          process.exit(1);
        }
        const { model: resolvedModel, effort: resolvedEffort } =
          resolveSkillArgs("feedback", model, effort, carlConfig);
        await cmdValidatedPrompt(
          workspaceRoot,
          "feedback",
          "# Paste the review feedback for Carl to assess",
          resolvedModel,
          resolvedEffort,
          resolveValidation(carlConfig),
          args[1] === "--review"
            ? savedNotesPromptFile(
                "feedback",
                "--review",
                "review",
                workspaceRoot,
              )
            : args[1],
        );
        break;
      }
      case "ask":
      case "plan": {
        if (args.length > 2) {
          console.error(
            `Usage: carl [--model <model>] [--effort <level>] ${command} [<prompt-file>]`,
          );
          process.exit(1);
        }
        const { model: resolvedModel, effort: resolvedEffort } =
          resolveSkillArgs(command, model, effort, carlConfig);
        if (command === "plan") {
          await cmdPlan(workspaceRoot, resolvedModel, resolvedEffort, args[1]);
        } else {
          await cmdReadOnlyPrompt(
            workspaceRoot,
            "ask",
            resolvedModel,
            resolvedEffort,
            "# What do you want to ask Carl?",
            args[1],
          );
        }
        break;
      }
      case "review": {
        const { model: resolvedModel, effort: resolvedEffort } =
          resolveSkillArgs("review", model, effort, carlConfig);
        await cmdReview(workspaceRoot, resolvedModel, resolvedEffort);
        break;
      }
      case "reset":
        cmdReset(workspaceRoot);
        break;
      case "pr-review": {
        if (args.length !== 2) {
          console.error("Usage: carl pr-review <pr-number>");
          process.exit(1);
        }
        const { model: resolvedModel, effort: resolvedEffort } =
          resolveSkillArgs("pr-review", model, effort, carlConfig);
        await cmdPrReview(
          workspaceRoot,
          args[1],
          resolvedModel,
          resolvedEffort,
        );
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
