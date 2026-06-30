import { getGitStatus, getCurrentBranch } from "./git";
import { getSkillOutputPath } from "./editor";
import {
  AgentRunner,
  AuggieRunner,
  BedrockRunner,
  BEDROCK_MODEL_IDS,
} from "./runner";

import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const CARL_SKILLS_DIR = path.join(__dirname, "..", "skills");
const CARL_RULES_DIR = path.join(__dirname, "..", "rules");
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".augment", "skills");
const EVENTS_LOG_DIR = ".carl";
const EVENTS_LOG_FILE = "events.jsonl";

type TimingEvent = {
  timestamp: string;
  run_id: string;
  event: "prompt" | "skill";
  subject: string;
  duration_ms: number;
  skill: string;
  model: string;
  meta?: Record<string, any>;
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
};

export const DEFAULT_MODELS: Record<string, string> = {
  code: "sonnet4.6",
  review: "sonnet4.6",
  "pr-review": "sonnet4.6",
};

const BASE_RULE_FILES = ["carl.md"] as const;

const READ_ONLY_WRITE_TOOL_EXCLUSIONS = [
  "remove-files",
  "save-file",
  "str-replace-editor",
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

function loadCarlConfig(
  workspaceRoot: string,
  createIfMissing = true,
): CarlConfig {
  const carlDir = path.join(workspaceRoot, EVENTS_LOG_DIR);
  const configPath = path.join(carlDir, "config.json");
  if (!fs.existsSync(configPath)) {
    if (!createIfMissing) {
      return {};
    }
    const defaults: CarlConfig = {
      backend: "bedrock",
      models: { ...DEFAULT_MODELS },
    };
    fs.mkdirSync(carlDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(defaults, null, 2) + "\n",
      "utf-8",
    );
    return defaults;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CarlConfig;
  } catch (err: any) {
    throw new Error(
      `Failed to parse ${configPath}: ${err.message}\n` +
        `Fix or delete the file and try again.`,
    );
  }
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

function getSkillModel(
  skill: string,
  workspaceRoot?: string,
  config?: CarlConfig,
): string {
  if (workspaceRoot) {
    const resolved =
      config ?? loadCarlConfig(workspaceRoot, skill !== "pr-review");
    const override =
      resolved.models?.[skill as keyof NonNullable<CarlConfig["models"]>];
    if (override) return override;
  }
  return DEFAULT_MODELS[skill] ?? "sonnet4.6";
}

const VALID_BACKENDS = ["auggie", "bedrock"] as const;

function getBackend(
  workspaceRoot?: string,
  skill?: string,
  config?: CarlConfig,
): string {
  if (workspaceRoot) {
    const resolved = config ?? loadCarlConfig(workspaceRoot, false);
    const backend =
      (skill &&
        resolved.backends?.[
          skill as keyof NonNullable<CarlConfig["backends"]>
        ]) ||
      resolved.backend;
    if (backend) {
      if (!(VALID_BACKENDS as readonly string[]).includes(backend)) {
        throw new Error(
          `Invalid backend "${backend}" in .carl/config.json.\n` +
            `Valid options: ${VALID_BACKENDS.join(", ")}.`,
        );
      }
      return backend;
    }
  }
  throw new Error(
    `No backend configured. Set "backend" in .carl/config.json.\n` +
      `Valid options: ${VALID_BACKENDS.join(", ")}.`,
  );
}

function writeTimingEvent(workspaceRoot: string, event: TimingEvent): void {
  const eventsDir = path.join(workspaceRoot, EVENTS_LOG_DIR);
  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true });
  }

  const eventsLogPath = path.join(eventsDir, EVENTS_LOG_FILE);
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
  meta?: Record<string, any>,
): void {
  if (skill !== "pr-review") {
    writeTimingEvent(workspaceRoot, {
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
  if (rules) {
    instruction += `# Rules\n\n${rules}\n\n---\n\n`;
  }
  instruction += skillContent || `Follow the ${skill} skill.`;

  if (skill === "review" && workspaceRoot) {
    const branch = getCurrentBranch(workspaceRoot);
    if (branch) {
      instruction += `\n\n---\n\n# Current branch\n\n\`${branch}\`\n\n`;
    }

    const gitStatus = getGitStatus(workspaceRoot);
    if (gitStatus.isRepo) {
      let filesSection = "\n\n---\n\n# Files changed\n\n";
      if (gitStatus.trackedChanged.length > 0) {
        filesSection += "## Tracked changes\n\n";
        filesSection += gitStatus.trackedChanged
          .map((f) => `- ${f}`)
          .join("\n");
        filesSection += "\n\n";
      }
      if (gitStatus.untracked.length > 0) {
        filesSection +=
          "## Untracked files (not staged for commit)\n\n" +
          gitStatus.untracked.map((f) => `- ${f}`).join("\n");
        filesSection += "\n\n";
      }
      if (
        gitStatus.trackedChanged.length === 0 &&
        gitStatus.untracked.length === 0
      ) {
        filesSection += "No files changed.\n\n";
      }
      instruction += filesSection;
    } else {
      instruction +=
        "\n\n---\n\n# Files changed\n\nNot in a git repository.\n\n";
    }
  }

  if (skill === "review") {
    const branch = getCurrentBranch(workspaceRoot);
    const isTicketBranch = branch && branch !== "main" && branch !== "master";
    instruction += "\n\n---\n\n# Commit message\n\n";
    if (isTicketBranch) {
      instruction += `Add \`## Proposed commit message\`. Subject: ticket prefix from \`${branch}\` + summary. Optional body.\n`;
    } else {
      instruction +=
        "Add `## Proposed commit message`. Subject: `fix:`/`feat:`/`chore:` + summary. Optional body.\n";
    }
  }

  return instruction;
}

function writeSkillOutput(
  skill: string,
  output: string,
  workspaceRoot: string,
): void {
  if (skill === "pr-review") {
    return;
  }
  const outputPath = getSkillOutputPath(workspaceRoot, skill);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf-8");
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
): Record<string, any> {
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

function createRunner(
  workspaceRoot: string,
  skill: string,
  model: string,
  region: string | undefined,
  config: CarlConfig,
): AgentRunner {
  const backend = getBackend(workspaceRoot, skill, config);

  if (backend === "auggie") {
    return new AuggieRunner();
  }

  if (!BEDROCK_MODEL_IDS[model]) {
    const supportedModels = Object.keys(BEDROCK_MODEL_IDS).join(", ");
    throw new Error(
      `Model "${model}" is not supported by Bedrock backend.\n` +
        `Supported Bedrock models: ${supportedModels}\n` +
        `Either:\n` +
        `  1. Change model to a supported Bedrock model in .carl/config.json\n` +
        `  2. Set "backends": {"${skill}": "auggie"} to use auggie for ${skill} skill\n` +
        `  3. Change global "backend" to "auggie" or remove it`,
    );
  }
  return new BedrockRunner(region ?? process.env.AWS_REGION ?? "us-east-1");
}

export async function runSkill(
  workspaceRoot: string,
  skill: string,
  initialPrompt?: string,
  modelOverride?: string,
  runner?: AgentRunner,
): Promise<RunSkillResult> {
  const runId = randomUUID();
  const carlConfig = loadCarlConfig(workspaceRoot);
  const model =
    modelOverride ?? getSkillModel(skill, workspaceRoot, carlConfig);
  const skillStartTime = Date.now();
  const gitStatusBefore = countGitStatus(workspaceRoot);
  const excludedTools = getExcludedTools(skill);

  const activeRunner =
    runner ??
    createRunner(
      workspaceRoot,
      skill,
      model,
      carlConfig.providers?.bedrock?.region,
      carlConfig,
    );

  let instruction = buildSkillInstruction(skill, workspaceRoot);
  if (initialPrompt) {
    instruction += `\n\n# User request\n\n${initialPrompt}`;
  }

  const MAX_FETCH_RETRIES = 2;

  console.log(`Starting skill: ${skill}`);

  let response = "";
  let usage: Record<string, any> | undefined;
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
        const result = await activeRunner.run({
          workspaceRoot,
          skill,
          model,
          instruction,
          excludedTools,
        });
        response = result.text;
        usage = result.usage as Record<string, any> | undefined;
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

    writeSkillOutput(skill, response, workspaceRoot);

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
    if (skill !== "pr-review") {
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
    }
    throw err;
  }
}
