#!/usr/bin/env node

import { runSkill, DEFAULT_MODELS, buildSkillInstruction } from "./skill";
import { collectPrompt, openFileInEditor, getSkillOutputPath } from "./editor";
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
  validateNoDuplicateInlineComments,
  validateInlineCommentsHaveRationale,
  parseAiScore,
  type ReviewComment,
} from "./pr-review-draft";
import { getGitStatus, getHeadSha } from "./git";
import { red } from "./colors";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

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

async function cmdReview(workspaceRoot: string, model?: string): Promise<void> {
  await runSkill(
    workspaceRoot,
    "review",
    "Review all staged and uncommitted local changes. Run `git diff HEAD` to see the full diff, then work through the review process. Make recommendations to the user.",
    model,
  );
  const outputPath = getSkillOutputPath(workspaceRoot, "review");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
}

async function cmdCode(
  workspaceRoot: string,
  promptFile?: string,
  model?: string,
): Promise<void> {
  const initialPrompt = collectCommandPrompt(
    promptFile,
    "# What should Carl implement?",
  );
  if (!initialPrompt) {
    console.log("No prompt provided. Cancelled.");
    return;
  }

  await runSkill(workspaceRoot, "code", initialPrompt, model);
  const outputPath = getSkillOutputPath(workspaceRoot, "code");
  if (fs.existsSync(outputPath)) openFileInEditor(outputPath);
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
    throw new Error(
      `No diff for ${owner}/${repo}#${number}. Nothing to review.`,
    );
  }

  const agentDir = path.join(workspaceRoot, ".agent/notes");
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
    `Append \`||| COMMENT\` blocks under \`## Review comments\` per the pr-review skill.`,
    `Inline comments must reference a path + new-side line that appears in a diff hunk; multi-line ranges must lie within a single hunk.`,
    `Every inline comment must open with a sentence naming WHAT the problem is, then explain why it matters. Do not start with impact or importance — state the defect first.`,
    `Write prose comments only — do not write suggestion blocks.`,
    `Read any workspace file you need for context. Do not modify any file outside the draft.`,
    `Also fill in the \`AI-generated:\` line under \`## AI Generation Assessment\` with your assessment of how likely this diff is to be AI-generated (low/medium/high) and a one-sentence reason. Use exactly this format: \`AI-generated: low|medium|high — <reason>\``,
  ].join("\n");

  await runSkill(workspaceRoot, "pr-review", initialPrompt, model);
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
      `Inline comments must also open with a prose line naming WHAT the problem is (the defect or broken contract), then why it matters.`,
      ``,
      `Edit \`${draftRel}\`: remove or fix only the failing comments and keep the valid ones. Do not modify any other file.`,
    ].join("\n");
    await runSkill(workspaceRoot, "pr-review", rerunPrompt, model);
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

  const aiScore = parseAiScore(fs.readFileSync(draftPath, "utf-8"));
  if (aiScore) {
    const indicator =
      aiScore.level === "high"
        ? "🔴"
        : aiScore.level === "medium"
          ? "🟡"
          : "🟢";
    console.log(
      `AI-generated likelihood: ${indicator} ${aiScore.level.toUpperCase()} — ${aiScore.reason}`,
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
    `  code [<file>] Read prompt from file or open editor; run the implementation skill (default: ${DEFAULT_MODELS.code})`,
  );
  console.error(
    "  review        Run reviewer once (cleanup/refactor your own local changes)",
  );
  console.error("  reset         Clear .agent/");
  console.error(
    "  pr-review <github-pr-url>  Fetch PR diff, draft review comments in .agent/notes/pr-review.md, and upload as a pending GitHub review (requires gh CLI)",
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
