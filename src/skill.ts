import { getGitStatus, getCurrentBranch } from "./git";
import { getSkillOutputPath } from "./editor";

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
  event: "Auggie.create" | "prompt" | "skill";
  subject: string;
  duration_ms: number;
  skill: string;
  model: string;
  command?: string;
  meta?: Record<string, any>;
};

type CarlConfig = {
  models?: {
    duck?: string;
    review?: string;
    "pr-review"?: string;
  };
};

export const DEFAULT_MODELS: Record<string, string> = {
  duck: "gpt5.4",
  review: "gpt5.4",
  "pr-review": "gpt5.4",
};

const BASE_RULE_FILES = ["carl.md"] as const;

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
    const defaults: CarlConfig = { models: { ...DEFAULT_MODELS } };
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
  } catch {
    return {};
  }
}

type PromptResponse = string | { text: string; usage?: Record<string, any> };

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

export function getSkillModel(skill: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const config = loadCarlConfig(workspaceRoot, skill !== "pr-review");
    const override =
      config.models?.[skill as keyof NonNullable<CarlConfig["models"]>];
    if (override) return override;
  }
  return DEFAULT_MODELS[skill] ?? "haiku4.5";
}

function extractPromptResponseText(
  response: PromptResponse,
): [string, Record<string, any> | undefined] {
  if (typeof response === "string") {
    return [response, undefined];
  }
  const usage = response.usage
    ? { source: "auggie", ...response.usage }
    : undefined;
  return [response.text, usage];
}

function isBlockedResponse(response: string): boolean {
  return /^#\s+Interview\s*$/im.test(response);
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
  command: string | undefined,
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
      command,
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
  status: "success" | "blocked",
  output: string,
  workspaceRoot: string,
): void {
  if (skill === "pr-review") {
    return;
  }
  const outputPath = getSkillOutputPath(workspaceRoot, skill, status);
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
  status: "success" | "blocked";
  response: string;
}

class SkillTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillTimeoutError";
  }
}

const SKILL_TIMEOUT_MS: Record<string, number> = {
  review: 6 * 60 * 1000,
  duck: 12 * 60 * 1000,
};

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
  status: "success" | "blocked" | "error",
): string | null {
  if (skill === "pr-review") {
    return null;
  }
  const outputPath = getSkillOutputPath(
    workspaceRoot,
    skill,
    status === "blocked" ? "blocked" : "success",
  );
  return path.relative(workspaceRoot, outputPath) || path.basename(outputPath);
}

function buildSkillEventMeta(
  workspaceRoot: string,
  skill: string,
  status: "success" | "blocked" | "error",
  gitStatusBefore: GitStatusCounts,
  retryCount: number,
  errorType?: "network" | "timeout" | "exception",
): Record<string, any> {
  const gitStatusAfter = countGitStatus(workspaceRoot);
  const outputPath = getSkillOutputRelativePath(workspaceRoot, skill, status);
  const absoluteOutputPath = outputPath
    ? path.join(workspaceRoot, outputPath)
    : null;

  return {
    status,
    blocked_reason: status === "blocked" ? "interview" : null,
    error_type: status === "error" ? (errorType ?? "exception") : null,
    retry_count: retryCount,
    interview_triggered: status === "blocked",
    git_repo: gitStatusBefore.is_repo,
    tracked_changed_before: gitStatusBefore.tracked_changed,
    tracked_changed_after: gitStatusAfter.tracked_changed,
    untracked_before: gitStatusBefore.untracked,
    untracked_after: gitStatusAfter.untracked,
    output_path: outputPath,
    output_exists: absoluteOutputPath
      ? fs.existsSync(absoluteOutputPath)
      : false,
  };
}

function classifySkillError(err: unknown): "network" | "timeout" | "exception" {
  if (err instanceof NetworkUnavailableError) {
    return "network";
  }
  if (err instanceof SkillTimeoutError) {
    return "timeout";
  }
  return "exception";
}

function writeTimeoutDiagnostic(
  workspaceRoot: string,
  skill: string,
  command: string,
  runId: string,
  timeoutMs: number,
  elapsedMs: number,
  sessionLog: string[],
): void {
  if (skill === "pr-review") {
    return;
  }
  try {
    const dir = path.join(workspaceRoot, ".agent", "notes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `timeout-${skill}-${runId}.md`);
    const header =
      `# Timeout: ${skill} (${command})\n\n` +
      `- run_id: ${runId}\n` +
      `- timeout: ${timeoutMs / 60000}m\n` +
      `- elapsed: ${(elapsedMs / 1000).toFixed(1)}s\n` +
      `- session_updates: ${sessionLog.length}\n\n` +
      `## Session activity\n\n`;
    const body = sessionLog.length
      ? sessionLog.join("\n")
      : "(no session updates received)";
    fs.writeFileSync(file, header + body + "\n", "utf-8");
  } catch {
    // Best-effort; never throw from the timeout path.
  }
}

export async function runSkill(
  workspaceRoot: string,
  skill: string,
  initialPrompt?: string,
  modelOverride?: string,
): Promise<RunSkillResult> {
  const command = skill;
  const runId = randomUUID();
  const model = modelOverride ?? getSkillModel(skill, workspaceRoot);
  const skillStartTime = Date.now();
  const gitStatusBefore = countGitStatus(workspaceRoot);

  let instruction = buildSkillInstruction(skill, workspaceRoot);
  if (initialPrompt) {
    instruction += `\n\n# User request\n\n${initialPrompt}`;
  }

  const { Auggie } = await import("@augmentcode/auggie-sdk");

  // UND_ERR_HEADERS_TIMEOUT and similar transient network errors surface as
  // "fetch failed" in the error message. The session is dead after such a
  // failure, so we recreate the client and retry.
  function isTransientFetchError(err: unknown): boolean {
    return ((err as any)?.message ?? "").includes("fetch failed");
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

      console.log(`  [System] Initializing agent...`);
      console.log(`[Timing] Auggie.create entry ${skill}/${model}`);
      const auggleCreateStart = Date.now();
      const excludedTools: string[] =
        skill !== "pr-review"
          ? ["remove-files", "save-file", "str-replace-editor"]
          : [];
      const client = await Auggie.create({
        workspaceRoot,
        model: model as any,
        allowIndexing: true,
        excludedTools,
      });
      logTimingDuration(
        workspaceRoot,
        runId,
        "Auggie.create",
        `${skill}/${model}`,
        Date.now() - auggleCreateStart,
        skill,
        model,
        command,
      );

      const sessionLog: string[] = [];
      client.onSessionUpdate((notification: any) => {
        const update = notification.update;
        if (!update) return;
        const ts = new Date().toISOString();
        if (update.sessionUpdate === "tool_call") {
          console.log(
            `\n  [${skill}/${model}] Running tool: ${update.title || "unknown"}...`,
          );
          sessionLog.push(`[${ts}] tool_call: ${update.title || "unknown"}`);
        } else if (update.sessionUpdate === "agent_thought_chunk") {
          if (update.content && update.content.text) {
            process.stdout.write(`\x1b[90m${update.content.text}\x1b[0m`);
            sessionLog.push(`[${ts}] thought: ${update.content.text}`);
          }
        } else if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content && update.content.text) {
            sessionLog.push(`[${ts}] message: ${update.content.text}`);
          }
        }
      });

      let shouldRetry = false;
      try {
        console.log(
          `  [System] Agent initialized. Sending prompt and awaiting response...`,
        );
        console.log(`[Timing] prompt entry ${skill}/${model}`);
        const promptStart = Date.now();
        const timeoutMs = SKILL_TIMEOUT_MS[skill];
        let timeoutHandle: NodeJS.Timeout | undefined;
        const promptPromise = client.prompt(instruction, {
          isAnswerOnly: true,
        });
        let raw: string;
        try {
          if (timeoutMs) {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                const writesTimeoutDiagnostic = skill !== "pr-review";
                writeTimeoutDiagnostic(
                  workspaceRoot,
                  skill,
                  command,
                  runId,
                  timeoutMs,
                  Date.now() - promptStart,
                  sessionLog,
                );
                client.cancel().catch(() => {});
                reject(
                  new SkillTimeoutError(
                    writesTimeoutDiagnostic
                      ? `${skill} exceeded ${timeoutMs / 60000}m timeout — cancelled. Diagnostic written to .agent/notes/timeout-${skill}-${runId}.md`
                      : `${skill} exceeded ${timeoutMs / 60000}m timeout — cancelled. Re-run \`carl ${command}\` to retry.`,
                  ),
                );
              }, timeoutMs);
            });
            raw = await Promise.race([promptPromise, timeoutPromise]);
          } else {
            raw = await promptPromise;
          }
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        [response, usage] = extractPromptResponseText(raw);
        const promptDuration = Date.now() - promptStart;
        logTimingDuration(
          workspaceRoot,
          runId,
          "prompt",
          `${skill}/${model}`,
          promptDuration,
          skill,
          model,
          command,
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
          // All retries exhausted — surface a clean message instead of the raw SDK error.
          throw new NetworkUnavailableError(
            `Network unavailable after ${MAX_FETCH_RETRIES + 1} attempts — run \`carl ${command}\` to retry.`,
          );
        } else {
          throw err;
        }
      } finally {
        try {
          await client.close();
        } catch {}
      }

      if (!shouldRetry) break;
    }

    const isBlocked = isBlockedResponse(response);
    const status: "success" | "blocked" = isBlocked ? "blocked" : "success";

    writeSkillOutput(skill, status, response, workspaceRoot);

    logTimingDuration(
      workspaceRoot,
      runId,
      "skill",
      skill,
      Date.now() - skillStartTime,
      skill,
      model,
      command,
      buildSkillEventMeta(
        workspaceRoot,
        skill,
        status,
        gitStatusBefore,
        retryCount,
      ),
    );

    return { status, response };
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
        command,
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
