import {
  getGitStatus,
  getCurrentBranch,
  getGitDiff,
  getHeadShaOrNull,
} from "./git";
import { getSkillOutputPath } from "./editor";
import { formatDuration } from "./stats-format";
import type { AgentRunner, UsageSummary, EffortLevel } from "./types";
import { attachUsage, usageFromError } from "./types";
import {
  buildValidationRetryPrompt,
  describeValidation,
  runValidation,
  type ValidationResult,
} from "./validate";

import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const CARL_SKILLS_DIR = path.join(__dirname, "..", "skills");
const CARL_RULES_DIR = path.join(__dirname, "..", "rules");
const LOCAL_CONFIG_DIR = ".carl";

export function getGlobalConfigDir(): string {
  return (
    process.env.CARL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "carl")
  );
}
export const EVENTS_LOG_FILE = "events.jsonl";

/**
 * Identifies one `carl` process. A single invocation can run a skill more than
 * once (`carl pr-review` re-runs on validation failure), so `run_id` alone
 * over-counts invocations.
 */
const INVOCATION_ID = randomUUID();

type PromptMeta = {
  /** `persona_chars + instruction_chars`; kept so older rows stay comparable. */
  prompt_chars: number;
  /**
   * carl's rules plus the skill definition — the same text on every run of a
   * skill, and the part a preserved context would only send once. Split out from
   * the instruction because the two answer different questions: this one is what
   * one-shot re-establishes, the other is what the human had to restate.
   */
  persona_chars: number;
  /** Workspace context, diff, and the human's prompt: this run's own input. */
  instruction_chars: number;
  response_chars: number;
  usage?: UsageSummary;
};

type SkillMeta = {
  status: "success" | "error";
  error_type: "network" | "exception" | null;
  retry_count: number;
  git_repo: boolean;
  tracked_changed_before: number;
  tracked_changed_after: number;
  untracked_before: number;
  untracked_after: number;
  output_path: string | null;
  output_exists: boolean;
  /** Usage accumulated before the failure; absent on success (see PromptMeta). */
  usage?: UsageSummary;
};

type ToolCallMeta = {
  input_summary: string;
  output_bytes: number;
  error: boolean;
};

/**
 * One run of the configured `validate` command. `attempt` is 0 for the check of
 * the first skill run, 1 for the check after the first repair, and so on.
 */
type ValidateMeta = {
  command: string;
  attempt: number;
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  output_bytes: number;
  /**
   * File-mutating tool calls made by the session this check judged. A repair with
   * 0 changed nothing, so it explains a check that failed identically twice.
   */
  session_mutations: number;
};

/**
 * One per validated run: what the whole loop cost and how it ended. The
 * per-attempt `validate` events say what happened; this says whether retrying
 * was worth it, which is the question the retry budget is a guess at.
 */
type ValidationMeta = {
  command: string;
  /** Skill runs spent, including the first. */
  runs: number;
  /** Repair runs spent: `runs - 1`. 0 means the first attempt was enough. */
  repairs: number;
  passed: boolean;
  timed_out: boolean;
  max_retries: number;
  stopped: ValidationStop;
};

type EventMeta =
  | PromptMeta
  | SkillMeta
  | ToolCallMeta
  | ValidateMeta
  | ValidationMeta;

type TimingEvent = {
  timestamp: string;
  run_id: string;
  invocation_id: string;
  event: "prompt" | "skill" | "tool_call" | "validate" | "validation";
  subject: string;
  duration_ms: number;
  skill: string;
  model: string;
  effort: EffortLevel;
  workspace: string;
  git_branch: string | null;
  git_sha: string | null;
  meta?: EventMeta;
};

/** Fields shared by every event emitted during one skill run. */
type RunContext = {
  runId: string;
  skill: string;
  model: string;
  effort: EffortLevel;
  workspace: string;
  gitBranch: string | null;
  gitSha: string | null;
};

/**
 * Bedrock route resolves its endpoint from the model catalog, so a configurable
 * region could not take effect. Stale keys in an existing config.json are
 * ignored rather than rejected.
 */
type CarlConfig = {
  models?: {
    code?: string;
    ask?: string;
    plan?: string;
    feedback?: string;
    review?: string;
    "pr-review"?: string;
  };
  /** Global fallback effort level for all skills. */
  effort?: EffortLevel;
  /** Per-skill effort overrides; take precedence over the global `effort` field. */
  efforts?: {
    code?: EffortLevel;
    ask?: EffortLevel;
    plan?: EffortLevel;
    feedback?: EffortLevel;
    review?: EffortLevel;
    "pr-review"?: EffortLevel;
  };
  /**
   * Shell command that decides whether `carl code` finished the job — typically
   * the project's own lint-and-test one-liner. Absent means carl cannot check
   * the work: there is no safe guess at another project's check command, and
   * running the wrong one is worse than running none.
   */
  validate?: string;
  /** How many times carl re-runs a skill after `validate` fails. */
  maxRetries?: number;
};

export const DEFAULT_MODELS: Record<string, string> = {
  code: "sonnet4.6",
  ask: "sonnet4.6",
  plan: "sonnet4.6",
  feedback: "sonnet4.6",
  review: "sonnet4.6",
  "pr-review": "sonnet4.6",
};

/**
 * `plan` gets `high` for the same reason `pr-review` does: it is the cheap step
 * whose mistakes are paid for by the expensive one after it. `ask` gets `medium`
 * because a question can be as hard as the code it is about.
 *
 * `feedback` gets `high` because its job is judging whether a claim is true. A
 * wrong "applied" edits the code to match a mistake, which is the one outcome
 * that costs more than the run.
 */
export const DEFAULT_EFFORTS: Record<string, EffortLevel> = {
  code: "medium",
  ask: "medium",
  plan: "high",
  feedback: "high",
  review: "medium",
  "pr-review": "high",
};

/**
 * Two repair attempts by default. The first catches the ordinary case — a typo,
 * a missed caller, a test the change forgot. The second earns its keep only when
 * the first made progress and uncovered a further failure, and that is enforced
 * rather than assumed: the loop stops the moment a repair session changes no
 * file (see ValidationStop), so the budget is a ceiling, not a promise to spend.
 *
 * No upper bound is imposed on the configured value for the same reason.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Rules every skill loads. `code-mode.md` is base because every skill runs
 * through the same Code Mode tool surface, and the logs showed 60% of programs
 * making one tool call or fewer — a model round-trip each, for no batching.
 */
const BASE_RULE_FILES = ["carl.md", "code-mode.md"] as const;

/** Every other skill runs in a read-only sandbox. */
const WRITABLE_SKILLS = new Set(["code", "feedback", "pr-review"]);

export function isReadOnlySkill(skill: string): boolean {
  return !WRITABLE_SKILLS.has(skill);
}

/**
 * Skills whose output is a changed workspace, so a check command can tell
 * whether they succeeded. `pr-review` writes only a draft file, and the rest are
 * sandboxed read-only, so there is nothing for `validate` to prove about them.
 */
const VALIDATED_SKILLS = new Set(["code", "feedback"]);

/** Rules for a session that writes code someone will have to live with. */
const WRITING_RULES = ["git-policy.md", "help-error-messages.md"] as const;

/**
 * Rules a skill needs on top of the base. Only `code` and `feedback` write
 * code, so only they can produce an error message or leave a commit to make.
 * The read-only sandbox stops every other skill from running a git command that
 * lands, and `pr-review`'s own skill file forbids git and gh.
 */
const SKILL_RULE_FILES: Record<string, readonly string[]> = {
  code: WRITING_RULES,
  feedback: WRITING_RULES,
};

type GitStatusCounts = {
  is_repo: boolean;
  tracked_changed: number;
  untracked: number;
};

function readConfigFile(configPath: string): CarlConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CarlConfig;
  } catch (err: any) {
    throw new Error(
      `Failed to parse ${configPath}: ${err.message}\n` +
        `Fix or delete the file and try again.`,
    );
  }
}

/**
 * Rejects values carl would otherwise misread at the worst moment: an empty
 * `validate` would run a shell that always succeeds, and a `maxRetries` of
 * `"2"` or `-1` would silently pick a different retry budget than the one the
 * file asks for.
 */
function assertValidConfig(config: CarlConfig, source: string): void {
  if (config.validate !== undefined) {
    if (typeof config.validate !== "string" || !config.validate.trim()) {
      throw new Error(
        `Invalid "validate" in ${source}: expected a non-empty shell command, got ${JSON.stringify(config.validate)}.\n` +
          `Set it to the command that checks this project, e.g. "validate": "npm test", or remove the key.`,
      );
    }
  }
  if (config.maxRetries !== undefined) {
    if (
      typeof config.maxRetries !== "number" ||
      !Number.isInteger(config.maxRetries) ||
      config.maxRetries < 0
    ) {
      throw new Error(
        `Invalid "maxRetries" in ${source}: expected a whole number of retries (0 or more), got ${JSON.stringify(config.maxRetries)}.\n` +
          `0 runs "validate" once and reports; ${DEFAULT_MAX_RETRIES} is the default.`,
      );
    }
  }
}

export function loadCarlConfig(workspaceRoot: string): CarlConfig {
  const globalConfigDir = getGlobalConfigDir();
  const globalConfigPath = path.join(globalConfigDir, "config.json");
  const localConfigPath = path.join(
    workspaceRoot,
    LOCAL_CONFIG_DIR,
    "config.json",
  );

  const globalExists = fs.existsSync(globalConfigPath);
  const localExists = fs.existsSync(localConfigPath);

  if (!globalExists && !localExists) {
    const defaults: CarlConfig = { models: { ...DEFAULT_MODELS } };
    fs.mkdirSync(globalConfigDir, { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify(defaults, null, 2) + "\n",
      "utf-8",
    );
    return defaults;
  }

  const globalConfig = globalExists ? readConfigFile(globalConfigPath) : {};
  const localConfig = localExists ? readConfigFile(localConfigPath) : {};
  // Checked per file so the message names the one to edit.
  assertValidConfig(globalConfig, globalConfigPath);
  assertValidConfig(localConfig, localConfigPath);
  return {
    ...globalConfig,
    ...localConfig,
    models: { ...globalConfig.models, ...localConfig.models },
    efforts: { ...globalConfig.efforts, ...localConfig.efforts },
  };
}

function getRuleFiles(skill: string): string[] {
  return [...BASE_RULE_FILES, ...(SKILL_RULE_FILES[skill] ?? [])];
}

function loadRules(skill: string): string {
  if (!fs.existsSync(CARL_RULES_DIR)) return "";
  return getRuleFiles(skill)
    .filter((f) => fs.existsSync(path.join(CARL_RULES_DIR, f)))
    .map((fileName) => {
      const raw = fs.readFileSync(path.join(CARL_RULES_DIR, fileName), "utf-8");
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function loadSkillFile(name: string): string {
  const p = path.join(CARL_SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(p)) return "";
  const raw = fs.readFileSync(p, "utf-8");
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
}

export function getSkillModel(skill: string, config?: CarlConfig): string {
  const override =
    config?.models?.[skill as keyof NonNullable<CarlConfig["models"]>];
  if (override) return override;
  return DEFAULT_MODELS[skill] ?? "sonnet4.6";
}

export function getSkillEffort(
  skill: string,
  config?: CarlConfig,
): EffortLevel {
  const perSkill =
    config?.efforts?.[skill as keyof NonNullable<CarlConfig["efforts"]>];
  if (perSkill) return perSkill;
  if (config?.effort) return config.effort;
  return DEFAULT_EFFORTS[skill] ?? "medium";
}

/** A configured check plus how many repair runs carl may spend on it. */
export type SkillValidation = {
  command: string;
  maxRetries: number;
};

/**
 * The validation contract for a run, or undefined when the project configured no
 * check command — in which case carl runs the skill once and hands back, as it
 * always did.
 */
export function resolveValidation(
  config?: CarlConfig,
): SkillValidation | undefined {
  if (!config?.validate) return undefined;
  return {
    command: config.validate,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

function writeTimingEvent(event: TimingEvent): void {
  const globalConfigDir = getGlobalConfigDir();
  fs.mkdirSync(globalConfigDir, { recursive: true });
  const eventsLogPath = path.join(globalConfigDir, EVENTS_LOG_FILE);
  fs.appendFileSync(eventsLogPath, `${JSON.stringify(event)}\n`, "utf-8");
}

function buildRunContext(
  workspaceRoot: string,
  runId: string,
  skill: string,
  model: string,
  effort: EffortLevel,
): RunContext {
  return {
    runId,
    skill,
    model,
    effort,
    workspace: workspaceRoot,
    gitBranch: getCurrentBranch(workspaceRoot),
    gitSha: getHeadShaOrNull(workspaceRoot),
  };
}

function emitEvent(
  ctx: RunContext,
  event: TimingEvent["event"],
  subject: string,
  durationMs: number,
  meta?: EventMeta,
): void {
  writeTimingEvent({
    timestamp: new Date().toISOString(),
    run_id: ctx.runId,
    invocation_id: INVOCATION_ID,
    event,
    subject,
    duration_ms: durationMs,
    skill: ctx.skill,
    model: ctx.model,
    effort: ctx.effort,
    workspace: ctx.workspace,
    git_branch: ctx.gitBranch,
    git_sha: ctx.gitSha,
    meta,
  });
}

/**
 * Milestone events use this; tool calls go through `emitEvent` directly.
 */
function logTimingDuration(
  ctx: RunContext,
  event: TimingEvent["event"],
  subject: string,
  durationMs: number,
  meta?: EventMeta,
): void {
  emitEvent(ctx, event, subject, durationMs, meta);
  console.log(`[Timing] ${event} duration ${durationMs}ms ${subject}`);
}

/**
 * The agent's identity: carl's rules and the skill it is performing.
 */
export function buildSkillPersona(skill: string): string {
  const rules = loadRules(skill);
  const skillContent = loadSkillFile(skill);
  let persona = "";
  if (rules) {
    persona += `# Rules\n\n${rules}\n\n---\n\n`;
  }
  persona += skillContent || `Follow the ${skill} skill.`;
  return persona;
}

/**
 * The request and the context it needs: workspace, review diff, user prompt.
 */
export function buildSkillInstruction(
  skill: string,
  workspaceRoot?: string,
  gitBranch?: string | null,
  validateCommand?: string,
): string {
  let instruction = "";
  if (workspaceRoot) {
    instruction += `# Workspace\n\nThe workspace root is \`${workspaceRoot}\`. The bash tool already runs with this as the working directory — never prefix commands with \`cd ${workspaceRoot} &&\` or \`cd /workspace &&\`.`;
  }

  // Said out loud because the alternative is worse than the tokens it costs: a
  // session that hits a denied write and does not know the denial was the point
  // reports it as a blocker and asks for write access, which turns a plan into a
  // complaint. Observed live from `carl plan` before this section existed.
  if (isReadOnlySkill(skill)) {
    instruction +=
      "\n\n---\n\n# Sandbox\n\n" +
      `This session is read-only. The filesystem sandbox refuses every write, including through \`bash\`, and that is what \`carl ${skill}\` is for — it is not a misconfiguration and there is no way to grant access mid-run. If a write is denied, do not report it, do not ask for write access, and do not tell the human to apply something by hand. Carl saves your response to \`.agent/notes/${skill}.md\`, which is how the work leaves this session.\n`;
  }

  // Which command proves the work is a fact about the project, so carl states it
  // rather than leaving the model to infer one.
  if (VALIDATED_SKILLS.has(skill)) {
    instruction += "\n\n---\n\n# Validation\n\n";
    instruction += validateCommand
      ? `Carl runs \`${validateCommand}\` in the workspace after you stop, and starts a new session with the failures if it fails. Run it yourself before you finish, so the fix lands in this session instead of costing another one.\n`
      : `This project configures no validation command, so nothing checks your work after you stop. Run the smallest check that would catch a mistake in what you changed.\n`;
  }

  if (skill === "review" && workspaceRoot) {
    const branch = gitBranch ?? getCurrentBranch(workspaceRoot);
    const isTicketBranch = branch && branch !== "main" && branch !== "master";

    instruction += "\n\n---\n\n# Commit message\n\n";
    if (isTicketBranch) {
      instruction += `Add \`## Proposed commit message\`. Subject: ticket prefix from \`${branch}\` + summary. Optional body.\n`;
    } else {
      instruction +=
        "Add `## Proposed commit message`. Subject: `fix:`/`feat:`/`chore:` + summary. Optional body.\n";
    }

    const diff = getGitDiff(workspaceRoot);
    instruction += "\n\n---\n\n# Diff\n\n";
    if (diff === null) {
      instruction += "git diff HEAD failed — check repository state.\n";
    } else if (diff === "") {
      instruction += "No diff (nothing staged or modified against HEAD).\n";
    } else {
      instruction += "```diff\n" + diff + "\n```\n";
    }
  }

  return instruction;
}

// Per-million-token prices (USD) by model family, most specific pattern first.
// Cache write is charged at 1.25x the input rate (5-minute TTL); cache read at
// 0.1x the input rate.
//
// Reviewed 2026-08-06 against the published Anthropic first-party rates.
// CAVEAT: carl calls Bedrock, which is a separate price list from the
// first-party API. aws.amazon.com/bedrock/pricing renders its Anthropic rows
// dynamically and only the Sonnet 5 footnote was retrievable ($2/$10 promo
// through 2026-08-31, then $3/$15). Sonnet 4.6, Haiku 4.5, and Opus Bedrock
// rates below are first-party figures used as a stand-in. Costs are estimates;
// reconcile against AWS Cost Explorer before trusting them to the cent.
//
type ModelRate = {
  pattern: RegExp;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

const MODEL_RATES: ModelRate[] = [
  {
    pattern: /fable|mythos/i,
    input: 10.0,
    output: 50.0,
    cacheWrite: 12.5,
    cacheRead: 1.0,
  },
  {
    pattern: /opus/i,
    input: 5.0,
    output: 25.0,
    cacheWrite: 6.25,
    cacheRead: 0.5,
  },
  {
    pattern: /sonnet/i,
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  {
    pattern: /haiku/i,
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
];

/**
 * Fingerprint of the rate table above, derived from its contents so it changes
 * automatically when any number does. Metrics compare this against the value
 * cached alongside each run's cost and reprice when it differs — a hand-bumped
 * version constant would eventually be forgotten during a rate edit, silently
 * leaving stale costs in the cache.
 */
export const RATES_FINGERPRINT: string = MODEL_RATES.map(
  (r) =>
    `${r.pattern.source}:${r.input}/${r.output}/${r.cacheWrite}/${r.cacheRead}`,
).join("|");

const warnedUnpricedModels = new Set<string>();

/**
 * Estimated USD cost of a run at *current* rates, or null when the model has no
 * known rates (non-Anthropic backends). Returning null keeps unpriced runs
 * distinguishable from genuinely-free ones; callers must not coerce it to 0.
 *
 * Deliberately not historical: these metrics exist to show whether changes to
 * carl made it cheaper, so every run is priced with one rate table. Pricing each
 * run at the rates in effect on its own date would make a vendor price change
 * look like a regression (or an improvement) in carl.
 */
export function computeCost(usage: UsageSummary): number | null {
  const { modelId } = usage;
  if (!modelId) return null;
  const rates = MODEL_RATES.find((r) => r.pattern.test(modelId));
  if (!rates) {
    if (!warnedUnpricedModels.has(modelId)) {
      warnedUnpricedModels.add(modelId);
      console.warn(
        `[Cost] No pricing for model "${modelId}" — reporting it as unpriced.`,
      );
    }
    return null;
  }
  const cost =
    ((usage.inputTokens ?? 0) * rates.input +
      (usage.outputTokens ?? 0) * rates.output +
      (usage.cacheWriteTokens ?? 0) * rates.cacheWrite +
      (usage.cacheReadTokens ?? 0) * rates.cacheRead) /
    1_000_000;
  return cost;
}

function buildUsageSummary(
  usage: UsageSummary | undefined,
  durationMs: number,
): string {
  const secs = (durationMs / 1000).toFixed(1);
  const parts: string[] = [`${secs}s`];
  if (usage?.turns != null) {
    parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  }
  if (usage?.inputTokens != null && usage?.outputTokens != null) {
    parts.push(
      `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`,
    );
  }
  if (usage?.cacheReadTokens != null || usage?.cacheWriteTokens != null) {
    const cacheRead = (usage.cacheReadTokens ?? 0).toLocaleString();
    const cacheWrite = (usage.cacheWriteTokens ?? 0).toLocaleString();
    parts.push(`${cacheRead} cache read / ${cacheWrite} cache write tokens`);
  }
  const cost = usage ? computeCost(usage) : null;
  if (cost != null) parts.push(`$${cost.toFixed(4)}`);
  return `Completed in ${parts.join(" · ")}`;
}

function writeSkillOutput(
  skill: string,
  output: string,
  workspaceRoot: string,
  usage: UsageSummary | undefined,
  durationMs: number,
): void {
  if (skill === "pr-review") {
    return;
  }
  const outputPath = getSkillOutputPath(workspaceRoot, skill);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const summary = buildUsageSummary(usage, durationMs);
  fs.writeFileSync(
    outputPath,
    output + "\n\n---\n\n" + summary + "\n",
    "utf-8",
  );
}

export class NetworkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

export interface RunSkillResult {
  response: string;
  /** Correlates this run with its events in the log. */
  runId: string;
  /**
   * Successful file-mutating tool calls the session made. Zero means the session
   * cannot have changed the workspace, which is what lets the validation loop
   * tell a repair from a session that only talked about one.
   */
  mutations: number;
}

/**
 * Tool names that change files, as the runtime reports them inside Code Mode
 * programs. A failed call does not count — a `write` that errored mutated
 * nothing. `bash` is deliberately absent: nearly every session runs it to look
 * around, so counting it would call every session a mutation.
 */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "write_file",
  "str_replace",
  "multi_edit",
]);

function countGitStatus(workspaceRoot: string): GitStatusCounts {
  const status = getGitStatus(workspaceRoot);
  return {
    is_repo: status.isRepo,
    tracked_changed: status.trackedChanged.length,
    untracked: status.untracked.length,
  };
}

function getSkillOutputRelativePath(
  workspaceRoot: string,
  skill: string,
): string | null {
  if (skill === "pr-review") {
    return null;
  }
  const outputPath = getSkillOutputPath(workspaceRoot, skill);
  return path.relative(workspaceRoot, outputPath) || path.basename(outputPath);
}

function buildSkillEventMeta(
  workspaceRoot: string,
  skill: string,
  status: "success" | "error",
  gitStatusBefore: GitStatusCounts,
  retryCount: number,
  errorType?: "network" | "exception",
  usage?: UsageSummary,
): SkillMeta {
  const gitStatusAfter = countGitStatus(workspaceRoot);
  const outputPath = getSkillOutputRelativePath(workspaceRoot, skill);
  return {
    status,
    error_type: status === "error" ? (errorType ?? "exception") : null,
    retry_count: retryCount,
    git_repo: gitStatusBefore.is_repo,
    tracked_changed_before: gitStatusBefore.tracked_changed,
    tracked_changed_after: gitStatusAfter.tracked_changed,
    untracked_before: gitStatusBefore.untracked,
    untracked_after: gitStatusAfter.untracked,
    output_path: outputPath,
    output_exists: outputPath
      ? fs.existsSync(path.join(workspaceRoot, outputPath))
      : false,
    ...(usage && { usage }),
  };
}

function classifySkillError(err: unknown): "network" | "exception" {
  if (err instanceof NetworkUnavailableError) {
    return "network";
  }
  return "exception";
}

/**
 * Why a failed run is worth attempting again. Every entry has to satisfy the
 * recovery rule in rules/help-error-messages.md: specific, recurring, bounded,
 * testable, and skippable by the caller. Anything else propagates unchanged —
 * an AccessDenied does not get cheaper by being retried three times.
 */
type RetryReason = "network" | "poisoned-session";

/** Per-reason budget, in retries after the first attempt. */
const RUNNER_RETRY_BUDGET: Record<RetryReason, number> = {
  network: 2,
  // A repeat is a whole run's spend, and a session usually dies this way deep
  // into its work, so this gets one fresh start rather than two.
  "poisoned-session": 1,
};

const RETRY_DELAY_MS: Record<RetryReason, number> = {
  network: 5000,
  // Nothing is waiting to recover: the next attempt is a new process with a new
  // session, so sleeping first would only cost the human time.
  "poisoned-session": 0,
};

/**
 * True for the one failure a fresh session reliably fixes.
 *
 * A model that hallucinates a dotted tool name (`tools.write`, borrowed from the
 * Code Mode API) gets a plain "unknown tool" answer from the runtime — but that
 * call is now in the transcript, and every later turn replays it to Bedrock,
 * which rejects the whole request because tool names must match
 * `[a-zA-Z0-9_-]+`. The session cannot recover, no matter how many turns are
 * left; a session that never made the call is fine.
 */
function isPoisonedSession(message: string): boolean {
  return (
    message.includes("toolUse.name") &&
    message.includes("failed to satisfy constraint")
  );
}

function classifyRetryable(err: unknown): RetryReason | null {
  const message: string = (err as any)?.message ?? "";
  if (message.includes("fetch failed")) return "network";
  if (isPoisonedSession(message)) return "poisoned-session";
  return null;
}

function describeRetry(
  reason: RetryReason,
  skill: string,
  attempt: number,
): string {
  const of = `attempt ${attempt + 1}/${RUNNER_RETRY_BUDGET[reason] + 1}`;
  if (reason === "network") return `Network error. Retrying (${of})...`;
  return (
    `The model called a tool by an invalid name, which Bedrock refuses to ` +
    `replay, so this session cannot continue. Re-running ${skill} in a fresh ` +
    `session (${of})...`
  );
}

/** The error the human sees once a retryable failure has used up its budget. */
function exhaustedError(
  reason: RetryReason,
  skill: string,
  err: unknown,
): Error {
  if (reason === "network") {
    return new NetworkUnavailableError(
      `Network unavailable after ${RUNNER_RETRY_BUDGET.network + 1} attempts — run \`carl ${skill}\` to retry.`,
    );
  }
  return new Error(
    `The model corrupted its session with an invalid tool name in all ` +
      `${RUNNER_RETRY_BUDGET["poisoned-session"] + 1} attempts, and Bedrock rejects the ` +
      `request once that name is in the transcript.\n` +
      `Re-run \`carl ${skill}\`, or use a different model for it — this is a ` +
      `model behaviour, not a workspace problem.\n` +
      `Provider error: ${(err as any)?.message ?? String(err)}`,
  );
}

export async function runSkill(
  workspaceRoot: string,
  skill: string,
  initialPrompt: string | undefined,
  model: string,
  effort: EffortLevel,
  runner: AgentRunner,
  options: { validateCommand?: string } = {},
): Promise<RunSkillResult> {
  const runId = randomUUID();
  const skillStartTime = Date.now();
  const gitStatusBefore = countGitStatus(workspaceRoot);
  const readOnly = !WRITABLE_SKILLS.has(skill);
  const ctx = buildRunContext(workspaceRoot, runId, skill, model, effort);

  if (!runner) {
    throw new Error(
      `runSkill: no runner provided for skill "${skill}". Callers must construct and pass a runner.`,
    );
  }

  const persona = buildSkillPersona(skill);
  let instruction = buildSkillInstruction(
    skill,
    workspaceRoot,
    ctx.gitBranch,
    options.validateCommand,
  );
  if (initialPrompt) {
    instruction += `\n\n---\n\n# User request\n\n${initialPrompt}`;
  }

  // The model and route are named here because they are chosen from three places
  // — the command line, .carl/config.json, ~/.config/carl/config.json — and a run
  // that picked a different one than intended is otherwise invisible until the
  // bill or the wall clock says so.
  const route = runner.describeRoute?.();
  console.log(
    `Starting skill: ${skill} (model ${model}${route ? ` via ${route}` : ""}, effort ${effort})`,
  );

  let response = "";
  let usage: UsageSummary | undefined;
  let retryCount = 0;
  let mutations = 0;
  try {
    for (;;) {
      try {
        const promptStart = Date.now();
        const result = await runner.run({
          workspaceRoot,
          skill,
          model,
          persona,
          instruction,
          effort,
          readOnly,
          onProgress: (line) => {
            process.stderr.write(
              `  [${formatDuration(Date.now() - promptStart)}] ${line}\n`,
            );
          },
          onToolCall: (event) => {
            if (!event.error && MUTATING_TOOLS.has(event.tool)) mutations++;
            emitEvent(ctx, "tool_call", event.tool, event.durationMs ?? 0, {
              input_summary: event.inputSummary ?? "",
              output_bytes: event.outputBytes ?? 0,
              error: event.error,
            });
          },
        });
        response = result.text;
        usage = result.usage;
        const promptDuration = Date.now() - promptStart;
        logTimingDuration(ctx, "prompt", `${skill}/${model}`, promptDuration, {
          prompt_chars: persona.length + instruction.length,
          persona_chars: persona.length,
          instruction_chars: instruction.length,
          response_chars: response.length,
          ...(usage && { usage }),
        });
        break;
      } catch (err) {
        const reason = classifyRetryable(err);
        if (!reason) throw err;
        if (retryCount >= RUNNER_RETRY_BUDGET[reason]) {
          // Carry the failed attempt's spend forward onto the replacement error.
          const replacement = exhaustedError(reason, skill, err);
          const spent = usageFromError(err);
          throw spent ? attachUsage(replacement, spent) : replacement;
        }
        retryCount++;
        console.log(`  [System] ${describeRetry(reason, skill, retryCount)}`);
        const delayMs = RETRY_DELAY_MS[reason];
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    writeSkillOutput(
      skill,
      response,
      workspaceRoot,
      usage,
      Date.now() - skillStartTime,
    );

    logTimingDuration(
      ctx,
      "skill",
      skill,
      Date.now() - skillStartTime,
      buildSkillEventMeta(
        workspaceRoot,
        skill,
        "success",
        gitStatusBefore,
        retryCount,
      ),
    );

    return { response, runId, mutations };
  } catch (err) {
    logTimingDuration(
      ctx,
      "skill",
      skill,
      Date.now() - skillStartTime,
      buildSkillEventMeta(
        workspaceRoot,
        skill,
        "error",
        gitStatusBefore,
        retryCount,
        classifySkillError(err),
        usageFromError(err),
      ),
    );
    throw err;
  }
}

/**
 * Why the validation loop stopped. `stalled` is the interesting one: a repair
 * session that changed no file cannot have changed the outcome, so another one
 * is a paid re-roll of the same dice.
 */
export type ValidationStop = "passed" | "budget" | "timeout" | "stalled";

export type ValidationOutcome = {
  ok: boolean;
  /** Skill runs spent, including the first: 1 means the first run passed. */
  runs: number;
  stopped: ValidationStop;
  result: ValidationResult;
};

export interface RunSkillWithValidationResult extends RunSkillResult {
  /** Absent when the project configured no `validate` command. */
  validation?: ValidationOutcome;
}

/**
 * Runs a skill, then checks its work with the project's own command and gives it
 * the failures back.
 *
 * Every attempt is a whole new run — new run_id, new session, new spend — because
 * that is what the runtime gives us and, for the failures worth retrying, what
 * you want: a session that has already convinced itself the code is fine is the
 * worst one to ask for a second opinion. The cost is that the repair session
 * remembers nothing, so buildValidationRetryPrompt has to hand it back the
 * request, the previous summary, and the failure.
 */
export async function runSkillWithValidation(
  workspaceRoot: string,
  skill: string,
  initialPrompt: string,
  model: string,
  effort: EffortLevel,
  runner: AgentRunner,
  validation?: SkillValidation,
): Promise<RunSkillWithValidationResult> {
  const options = { validateCommand: validation?.command };
  let run = await runSkill(
    workspaceRoot,
    skill,
    initialPrompt,
    model,
    effort,
    runner,
    options,
  );
  if (!validation) return run;

  const loopStart = Date.now();

  for (let attempt = 0; ; attempt++) {
    const ctx = buildRunContext(workspaceRoot, run.runId, skill, model, effort);
    console.log(`Validating: \`${validation.command}\``);
    const result = runValidation(workspaceRoot, validation.command);
    emitEvent(ctx, "validate", "validate", result.durationMs, {
      command: result.command,
      attempt,
      passed: result.ok,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      output_bytes: Buffer.byteLength(result.output, "utf-8"),
      session_mutations: run.mutations,
    });
    console.log(describeValidation(result));

    // A timeout is not retried: the killed command left no output to hand back,
    // so the next session would be repairing something it cannot see. A stalled
    // repair is not retried either — see ValidationStop.
    const stopped: ValidationStop | null = result.ok
      ? "passed"
      : result.timedOut
        ? "timeout"
        : attempt >= validation.maxRetries
          ? "budget"
          : attempt > 0 && run.mutations === 0
            ? "stalled"
            : null;

    if (stopped) {
      if (stopped === "stalled") {
        console.log(
          `The last ${skill} session changed no files, so another run would repeat it. Stopping.`,
        );
      }
      emitEvent(ctx, "validation", validation.command, Date.now() - loopStart, {
        command: validation.command,
        runs: attempt + 1,
        repairs: attempt,
        passed: result.ok,
        timed_out: result.timedOut,
        max_retries: validation.maxRetries,
        stopped,
      });
      return {
        ...run,
        validation: { ok: result.ok, runs: attempt + 1, stopped, result },
      };
    }

    console.log(
      `Re-running ${skill} in a fresh session to fix it (attempt ${attempt + 2}/${validation.maxRetries + 1})...`,
    );
    run = await runSkill(
      workspaceRoot,
      skill,
      buildValidationRetryPrompt(initialPrompt, run.response, result, {
        attempt: attempt + 1,
        total: validation.maxRetries,
      }),
      model,
      effort,
      runner,
      options,
    );
  }
}
