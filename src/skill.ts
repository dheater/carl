import { getGitStatus, getCurrentBranch, getGitDiff } from "./git";
import { getSkillOutputPath } from "./editor";
import type { AgentRunner, UsageSummary, EffortLevel } from "./types";

import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const CARL_SKILLS_DIR = path.join(__dirname, "..", "skills");
const CARL_RULES_DIR = path.join(__dirname, "..", "rules");
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".augment", "skills");
const LOCAL_CONFIG_DIR = ".carl";

function getGlobalConfigDir(): string {
  return (
    process.env.CARL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "carl")
  );
}
const EVENTS_LOG_FILE = "events.jsonl";

type PromptMeta = {
  prompt_chars: number;
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
};

type ToolCallMeta = {
  input_summary: string;
  output_bytes: number;
  error: boolean;
};

type TimingEvent = {
  timestamp: string;
  run_id: string;
  event: "prompt" | "skill" | "tool_call";
  subject: string;
  duration_ms: number;
  skill: string;
  model: string;
  meta?: PromptMeta | SkillMeta | ToolCallMeta;
};

type CarlConfig = {
  backend?: string;
  models?: {
    code?: string;
    review?: string;
    "pr-review"?: string;
  };
  backends?: {
    code?: string;
    review?: string;
    "pr-review"?: string;
  };
  providers?: {
    bedrock?: {
      region?: string;
    };
  };
  /** Global fallback effort level for all skills. */
  effort?: EffortLevel;
  /** Per-skill effort overrides; take precedence over the global `effort` field. */
  efforts?: {
    code?: EffortLevel;
    review?: EffortLevel;
    "pr-review"?: EffortLevel;
  };
};

export const DEFAULT_MODELS: Record<string, string> = {
  code: "sonnet4.6",
  review: "sonnet4.6",
  "pr-review": "sonnet4.6",
};

export const DEFAULT_EFFORTS: Record<string, EffortLevel> = {
  code: "medium",
  review: "high",
  "pr-review": "high",
};

const BASE_RULE_FILES = ["carl.md"] as const;

const READ_ONLY_WRITE_TOOL_EXCLUSIONS = [
  "remove-files",
  "save-file",
  "str-replace-editor",
  "write_file",
  "str_replace",
  "create_directory",
] as const;

const WRITABLE_SKILLS = new Set(["code", "pr-review"]);

const SKILL_RULE_FILES: Record<string, readonly string[]> = {
  review: ["git-policy.md"],
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

export function loadCarlConfig(
  workspaceRoot: string,
  createIfMissing = true,
): CarlConfig {
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
    if (!createIfMissing) return {};
    const defaults: CarlConfig = {
      backend: "bedrock",
      models: { ...DEFAULT_MODELS },
    };
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

  // Local overrides global field-by-field within nested objects so that, e.g.,
  // a local { efforts: { review: "low" } } does not silently drop global
  // { efforts: { code: "high" } }.
  return {
    ...globalConfig,
    ...localConfig,
    models: { ...globalConfig.models, ...localConfig.models },
    efforts: { ...globalConfig.efforts, ...localConfig.efforts },
    backends: { ...globalConfig.backends, ...localConfig.backends },
    providers: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(globalConfig.providers ?? {}),
          ...Object.keys(localConfig.providers ?? {}),
        ]),
      ].map((k) => [
        k,
        {
          ...(globalConfig.providers as any)?.[k],
          ...(localConfig.providers as any)?.[k],
        },
      ]),
    ) as CarlConfig["providers"],
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
  for (const dir of [CARL_SKILLS_DIR, GLOBAL_SKILLS_DIR]) {
    const p = path.join(dir, `${name}.md`);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
    }
  }
  return "";
}

function getExcludedTools(skill: string): string[] {
  return WRITABLE_SKILLS.has(skill) ? [] : [...READ_ONLY_WRITE_TOOL_EXCLUSIONS];
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

function writeTimingEvent(event: TimingEvent): void {
  const globalConfigDir = getGlobalConfigDir();
  fs.mkdirSync(globalConfigDir, { recursive: true });
  const eventsLogPath = path.join(globalConfigDir, EVENTS_LOG_FILE);
  fs.appendFileSync(eventsLogPath, `${JSON.stringify(event)}\n`, "utf-8");
}

function logTimingDuration(
  workspaceRoot: string,
  runId: string,
  event: TimingEvent["event"],
  subject: string,
  durationMs: number,
  skill: string,
  model: string,
  meta?: PromptMeta | SkillMeta,
): void {
  if (skill !== "pr-review") {
    writeTimingEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      event,
      subject,
      duration_ms: durationMs,
      skill,
      model,
      meta,
    });
  }
  console.log(`[Timing] ${event} duration ${durationMs}ms ${subject}`);
}

export function buildSkillInstruction(
  skill: string,
  workspaceRoot?: string,
): string {
  const rules = loadRules(skill);
  const skillContent = loadSkillFile(skill);
  let instruction = "";
  if (workspaceRoot) {
    instruction += `# Workspace\n\nThe workspace root is \`${workspaceRoot}\`. The bash tool already runs with this as the working directory — never prefix commands with \`cd ${workspaceRoot} &&\` or \`cd /workspace &&\`.\n\n---\n\n`;
  }
  if (rules) {
    instruction += `# Rules\n\n${rules}\n\n---\n\n`;
  }
  instruction += skillContent || `Follow the ${skill} skill.`;

  if (skill === "review" && workspaceRoot) {
    const branch = getCurrentBranch(workspaceRoot);
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

// Per-million-token prices (USD) for each model family.
// Cache write is charged at 1.25× the input rate; cache read at 0.1× the input rate.
// Source: Anthropic pricing page (Sonnet/Haiku/Opus tiers).
const MODEL_RATES: Array<{
  pattern: RegExp;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = [
  {
    pattern: /opus/i,
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
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
    input: 0.8,
    output: 4.0,
    cacheWrite: 1.0,
    cacheRead: 0.08,
  },
];

export function computeCost(usage: UsageSummary): number | null {
  const { modelId } = usage;
  if (!modelId) return null;
  const rates = MODEL_RATES.find((r) => r.pattern.test(modelId));
  if (!rates) return null;
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
}

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
  };
}

function classifySkillError(err: unknown): "network" | "exception" {
  if (err instanceof NetworkUnavailableError) {
    return "network";
  }
  return "exception";
}

function isTransientFetchError(err: unknown): boolean {
  return ((err as any)?.message ?? "").includes("fetch failed");
}

export async function runSkill(
  workspaceRoot: string,
  skill: string,
  initialPrompt: string | undefined,
  model: string,
  effort: EffortLevel,
  runner: AgentRunner,
): Promise<RunSkillResult> {
  const runId = randomUUID();
  const skillStartTime = Date.now();
  const gitStatusBefore = countGitStatus(workspaceRoot);
  const excludedTools = getExcludedTools(skill);

  if (!runner) {
    throw new Error(
      `runSkill: no runner provided for skill "${skill}". Callers must construct and pass a runner.`,
    );
  }

  let instruction = buildSkillInstruction(skill, workspaceRoot);
  if (initialPrompt) {
    instruction += `\n\n# User request\n\n${initialPrompt}`;
  }

  const MAX_FETCH_RETRIES = 2;

  console.log(`Starting skill: ${skill}`);

  let response = "";
  let usage: UsageSummary | undefined;
  let retryCount = 0;
  try {
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
      retryCount = attempt;
      if (attempt > 0) {
        console.log(
          `  [System] Network error. Retrying (attempt ${attempt + 1}/${MAX_FETCH_RETRIES + 1})...`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }

      let shouldRetry = false;
      try {
        const promptStart = Date.now();
        const result = await runner.run({
          workspaceRoot,
          skill,
          model,
          instruction,
          excludedTools,
          effort,
          onToolCall: (event) => {
            writeTimingEvent({
              timestamp: new Date().toISOString(),
              run_id: runId,
              event: "tool_call",
              subject: event.tool,
              duration_ms: event.durationMs ?? 0,
              skill,
              model,
              meta: {
                input_summary: event.inputSummary ?? "",
                output_bytes: event.outputBytes ?? 0,
                error: event.error,
              },
            });
          },
        });
        response = result.text;
        usage = result.usage;
        const promptDuration = Date.now() - promptStart;
        logTimingDuration(
          workspaceRoot,
          runId,
          "prompt",
          `${skill}/${model}`,
          promptDuration,
          skill,
          model,
          {
            prompt_chars: instruction.length,
            response_chars: response.length,
            ...(usage && { usage }),
          },
        );
      } catch (err) {
        if (attempt < MAX_FETCH_RETRIES && isTransientFetchError(err)) {
          shouldRetry = true;
        } else if (isTransientFetchError(err)) {
          throw new NetworkUnavailableError(
            `Network unavailable after ${MAX_FETCH_RETRIES + 1} attempts — run \`carl ${skill}\` to retry.`,
          );
        } else {
          throw err;
        }
      }

      if (!shouldRetry) break;
    }

    writeSkillOutput(
      skill,
      response,
      workspaceRoot,
      usage,
      Date.now() - skillStartTime,
    );

    logTimingDuration(
      workspaceRoot,
      runId,
      "skill",
      skill,
      Date.now() - skillStartTime,
      skill,
      model,
      buildSkillEventMeta(
        workspaceRoot,
        skill,
        "success",
        gitStatusBefore,
        retryCount,
      ),
    );

    return { response };
  } catch (err) {
    logTimingDuration(
      workspaceRoot,
      runId,
      "skill",
      skill,
      Date.now() - skillStartTime,
      skill,
      model,
      buildSkillEventMeta(
        workspaceRoot,
        skill,
        "error",
        gitStatusBefore,
        retryCount,
        classifySkillError(err),
      ),
    );
    throw err;
  }
}
