import { getGitStatus, getCurrentBranch } from "./git";
import { getPhaseOutputPath } from "./editor";

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
  event: "Auggie.create" | "prompt" | "phase";
  subject: string;
  duration_ms: number;
  phase: string;
  model: string;
  command?: string;
  meta?: Record<string, any>;
};

type CarlConfig = {
  models?: {
    architect?: string;
    developer?: string;
    reviewer?: string;
    verify?: string;
    chat?: string;
    "pr-reviewer"?: string;
  };
};

export const DEFAULT_MODELS: Record<string, string> = {
  architect: "gpt5.4",
  developer: "sonnet4.6",
  reviewer: "gpt5.4",
  verify: "gpt5.4",
  chat: "gpt5.4",
  "pr-reviewer": "gpt5.4",
};

const BASE_RULE_FILES = ["carl.md", "errors.md"] as const;

const PHASE_RULE_FILES: Record<string, readonly string[]> = {
  developer: ["git-policy.md"],
  reviewer: ["git-policy.md", "review-code.md"],
  verify: ["git-policy.md"],
  chat: ["git-policy.md"],
};

type GitStatusCounts = {
  is_repo: boolean;
  tracked_changed: number;
  untracked: number;
};

export interface RunPhaseContext {
  prdPhaseTitle?: string;
}

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

function isInteractiveReviewRequest(initialPrompt?: string): boolean {
  if (!initialPrompt) return false;
  return /\breview\s+(?:code|project)\b/i.test(initialPrompt);
}

function getRuleFiles(phaseName: string, initialPrompt?: string): string[] {
  const files = [...BASE_RULE_FILES, ...(PHASE_RULE_FILES[phaseName] ?? [])];
  if (phaseName === "chat" && isInteractiveReviewRequest(initialPrompt)) {
    files.push("review-code.md");
  }
  return files;
}

function loadRules(phaseName: string, initialPrompt?: string): string {
  if (!fs.existsSync(CARL_RULES_DIR)) return "";
  return getRuleFiles(phaseName, initialPrompt)
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

export function getPhaseModel(phase: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const config = loadCarlConfig(workspaceRoot, phase !== "pr-reviewer");
    const override =
      config.models?.[phase as keyof NonNullable<CarlConfig["models"]>];
    if (override) return override;
  }
  return DEFAULT_MODELS[phase] ?? "haiku4.5";
}

function shouldAllowIndexing(phaseName: string): boolean {
  return phaseName !== "chat";
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
  phase: string,
  model: string,
  command: string | undefined,
  meta?: Record<string, any>,
): void {
  if (phase !== "pr-reviewer") {
    writeTimingEvent(workspaceRoot, {
      timestamp: new Date().toISOString(),
      run_id: runId,
      event,
      subject,
      duration_ms: durationMs,
      phase,
      model,
      command,
      meta,
    });
  }
  console.log(`[Timing] ${event} duration ${durationMs}ms ${subject}`);
}

export function buildSkillInstruction(
  phaseName: string,
  workspaceRoot?: string,
  initialPrompt?: string,
): string {
  const rules = loadRules(phaseName, initialPrompt);
  const skillContent = loadSkillFile(phaseName);
  let instruction = "";
  if (rules) {
    instruction += `# Rules\n\n${rules}\n\n---\n\n`;
  }
  instruction += skillContent
    ? `# Your skill for this session\n\n${skillContent}`
    : `Follow the ${phaseName} skill.`;

  if ((phaseName === "reviewer" || phaseName === "verify") && workspaceRoot) {
    const branch =
      phaseName === "reviewer" ? getCurrentBranch(workspaceRoot) : null;
    if (branch) {
      instruction += `\n\n---\n\n# Current branch\n\n\`${branch}\`\n\n`;
    }

    const prdPath = path.join(workspaceRoot, ".agent", "prd.md");
    if (fs.existsSync(prdPath)) {
      const phaseLabel = phaseName === "reviewer" ? "review" : "verification";
      const criteriaVerb = phaseName === "reviewer" ? "audit" : "validate";
      const evidenceLine =
        phaseName === "reviewer"
          ? "Treat anything not clearly implemented and later proven by `verify` as `[gap]`."
          : "Treat anything not clearly implemented and validated as `[gap]`.";
      instruction += "\n\n---\n\n# PRD acceptance criteria\n\n";
      instruction += `.agent/prd.md exists and is the source of truth for this ${phaseLabel}.\n\n`;
      instruction += `Before you ${criteriaVerb} results, extract the acceptance criteria from that file and check the current workspace state against each one.\n\n`;
      instruction +=
        "In `## Acceptance criteria`, list every acceptance criterion with exactly one status: `[met]`, `[gap]`, or `[unknown]`. " +
        `${evidenceLine} If .agent/prd.md has no acceptance criteria, say that explicitly.\n\n`;
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

    if (phaseName === "reviewer") {
      const isTicketBranch = branch && branch !== "main" && branch !== "master";
      instruction += "\n\n---\n\n# Commit message\n\n";
      if (isTicketBranch) {
        instruction += `Add \`## Proposed commit message\`. Subject: ticket prefix from \`${branch}\` + summary. Optional body.\n`;
      } else {
        instruction +=
          "Add `## Proposed commit message`. Subject: `fix:`/`feat:`/`chore:` + summary. Optional body.\n";
      }
    }
  }

  return instruction;
}

function writePhaseOutput(
  phaseName: string,
  status: "success" | "blocked",
  phaseOutput: string,
  workspaceRoot: string,
): void {
  if (phaseName === "pr-reviewer") {
    return;
  }
  const outputPath = getPhaseOutputPath(workspaceRoot, phaseName, status);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (
    phaseName === "architect" &&
    status === "success" &&
    fs.existsSync(outputPath)
  ) {
    return;
  }
  fs.writeFileSync(outputPath, phaseOutput, "utf-8");
}

export interface PrdPhase {
  lineIndex: number;
  title: string;
  completed: boolean;
}

export function parsePrdPhases(prdContent: string): PrdPhase[] {
  const lines = prdContent.split("\n");
  const phases: PrdPhase[] = [];
  let inPhasesSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Phases\s*$/i.test(line)) {
      inPhasesSection = true;
      continue;
    }
    if (inPhasesSection && /^##\s+/.test(line)) break;
    if (inPhasesSection) {
      const match = line.match(/^-\s+\[([ x])\]\s+(.+)$/i);
      if (match) {
        phases.push({
          lineIndex: i,
          title: match[2].trim(),
          completed: match[1] === "x",
        });
      }
    }
  }
  return phases;
}

export function markPhaseComplete(prdPath: string, lineIndex: number): void {
  const content = fs.readFileSync(prdPath, "utf-8");
  const lines = content.split("\n");
  lines[lineIndex] = lines[lineIndex].replace(/^(-\s+\[) \]/, "$1x]");
  fs.writeFileSync(prdPath, lines.join("\n"), "utf-8");
}

export class NetworkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

export interface RunPhaseResult {
  status: "success" | "blocked";
  response: string;
}

class PhaseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseTimeoutError";
  }
}

const PHASE_TIMEOUT_MS: Record<string, number> = {
  developer: 14 * 60 * 1000,
  reviewer: 6 * 60 * 1000,
  verify: 10 * 60 * 1000,
  architect: 12 * 60 * 1000,
};

function countGitStatus(workspaceRoot: string): GitStatusCounts {
  const status = getGitStatus(workspaceRoot);
  return {
    is_repo: status.isRepo,
    tracked_changed: status.trackedChanged.length,
    untracked: status.untracked.length,
  };
}

function getPhaseOutputRelativePath(
  workspaceRoot: string,
  phaseName: string,
  status: "success" | "blocked" | "error",
): string | null {
  if (phaseName === "pr-reviewer") {
    return null;
  }
  const outputPath = getPhaseOutputPath(
    workspaceRoot,
    phaseName,
    status === "blocked" ? "blocked" : "success",
  );
  return path.relative(workspaceRoot, outputPath) || path.basename(outputPath);
}

function buildPhaseEventMeta(
  workspaceRoot: string,
  phaseName: string,
  status: "success" | "blocked" | "error",
  gitStatusBefore: GitStatusCounts,
  retryCount: number,
  context?: RunPhaseContext,
  errorType?: "network" | "timeout" | "exception",
): Record<string, any> {
  const gitStatusAfter = countGitStatus(workspaceRoot);
  const outputPath = getPhaseOutputRelativePath(
    workspaceRoot,
    phaseName,
    status,
  );
  const absoluteOutputPath = outputPath
    ? path.join(workspaceRoot, outputPath)
    : null;

  return {
    status,
    blocked_reason: status === "blocked" ? "interview" : null,
    error_type: status === "error" ? (errorType ?? "exception") : null,
    retry_count: retryCount,
    interview_triggered: status === "blocked",
    prd_present: fs.existsSync(path.join(workspaceRoot, ".agent", "prd.md")),
    git_repo: gitStatusBefore.is_repo,
    tracked_changed_before: gitStatusBefore.tracked_changed,
    tracked_changed_after: gitStatusAfter.tracked_changed,
    untracked_before: gitStatusBefore.untracked,
    untracked_after: gitStatusAfter.untracked,
    output_path: outputPath,
    output_exists: absoluteOutputPath
      ? fs.existsSync(absoluteOutputPath)
      : false,
    ...(context?.prdPhaseTitle
      ? { prd_phase_title: context.prdPhaseTitle }
      : {}),
  };
}

function classifyPhaseError(err: unknown): "network" | "timeout" | "exception" {
  if (err instanceof NetworkUnavailableError) {
    return "network";
  }
  if (err instanceof PhaseTimeoutError) {
    return "timeout";
  }
  return "exception";
}

function writeTimeoutDiagnostic(
  workspaceRoot: string,
  phaseName: string,
  command: string,
  runId: string,
  timeoutMs: number,
  elapsedMs: number,
  sessionLog: string[],
): void {
  if (phaseName === "pr-reviewer") {
    return;
  }
  try {
    const dir = path.join(workspaceRoot, ".agent", "notes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `timeout-${phaseName}-${runId}.md`);
    const header =
      `# Timeout: ${phaseName} (${command})\n\n` +
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

export async function runPhase(
  workspaceRoot: string,
  phaseName: string,
  command: string,
  initialPrompt?: string,
  modelOverride?: string,
  context?: RunPhaseContext,
): Promise<RunPhaseResult> {
  const runId = randomUUID();
  const model = modelOverride ?? getPhaseModel(phaseName, workspaceRoot);
  const phaseStartTime = Date.now();
  const allowIndexing = shouldAllowIndexing(phaseName);
  const gitStatusBefore = countGitStatus(workspaceRoot);

  let instruction = buildSkillInstruction(
    phaseName,
    workspaceRoot,
    initialPrompt,
  );
  if (initialPrompt) {
    instruction += `\n\n# User request\n\n${initialPrompt}`;
    if (phaseName === "architect") {
      instruction +=
        "\n\nThe user has already stated their request above. Skip the menu — proceed directly with this request.";
    }
  }

  const { Auggie } = await import("@augmentcode/auggie-sdk");

  // UND_ERR_HEADERS_TIMEOUT and similar transient network errors surface as
  // "fetch failed" in the error message. The session is dead after such a
  // failure, so we recreate the client and retry.
  function isTransientFetchError(err: unknown): boolean {
    return ((err as any)?.message ?? "").includes("fetch failed");
  }

  const MAX_FETCH_RETRIES = 2;

  console.log(`Starting phase: ${phaseName}`);

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
      console.log(`[Timing] Auggie.create entry ${phaseName}/${model}`);
      const auggleCreateStart = Date.now();
      const client = await Auggie.create({
        workspaceRoot,
        model: model as any,
        allowIndexing,
      });
      logTimingDuration(
        workspaceRoot,
        runId,
        "Auggie.create",
        `${phaseName}/${model}`,
        Date.now() - auggleCreateStart,
        phaseName,
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
            `\n  [${phaseName}/${model}] Running tool: ${update.title || "unknown"}...`,
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
        console.log(`[Timing] prompt entry ${phaseName}/${model}`);
        const promptStart = Date.now();
        const timeoutMs = PHASE_TIMEOUT_MS[phaseName];
        let timeoutHandle: NodeJS.Timeout | undefined;
        const promptPromise = client.prompt(instruction, {
          isAnswerOnly: true,
        });
        let raw: string;
        try {
          if (timeoutMs) {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                const writesTimeoutDiagnostic = phaseName !== "pr-reviewer";
                writeTimeoutDiagnostic(
                  workspaceRoot,
                  phaseName,
                  command,
                  runId,
                  timeoutMs,
                  Date.now() - promptStart,
                  sessionLog,
                );
                client.cancel().catch(() => {});
                reject(
                  new PhaseTimeoutError(
                    writesTimeoutDiagnostic
                      ? `${phaseName} exceeded ${timeoutMs / 60000}m timeout — cancelled. Diagnostic written to .agent/notes/timeout-${phaseName}-${runId}.md`
                      : `${phaseName} exceeded ${timeoutMs / 60000}m timeout — cancelled. Re-run \`carl ${command}\` to retry.`,
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
          `${phaseName}/${model}`,
          promptDuration,
          phaseName,
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

    writePhaseOutput(phaseName, status, response, workspaceRoot);

    logTimingDuration(
      workspaceRoot,
      runId,
      "phase",
      phaseName,
      Date.now() - phaseStartTime,
      phaseName,
      model,
      command,
      buildPhaseEventMeta(
        workspaceRoot,
        phaseName,
        status,
        gitStatusBefore,
        retryCount,
        context,
      ),
    );

    return { status, response };
  } catch (err) {
    if (phaseName !== "pr-reviewer") {
      logTimingDuration(
        workspaceRoot,
        runId,
        "phase",
        phaseName,
        Date.now() - phaseStartTime,
        phaseName,
        model,
        command,
        buildPhaseEventMeta(
          workspaceRoot,
          phaseName,
          "error",
          gitStatusBefore,
          retryCount,
          context,
          classifyPhaseError(err),
        ),
      );
    }
    throw err;
  }
}
