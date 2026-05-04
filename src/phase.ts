import { getGitStatus, getCurrentBranch } from "./git";
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const CARL_SKILLS_DIR = path.join(__dirname, "..", "skills");
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

// Char-based credit estimates calibrated from CSV reconciliation against
// billed credits (rates per 1000 chars, expressed as cr/char). Treated as a
// budget proxy until programmatic credit access exists; revise when real
// numbers diverge.
const COST_PER_CHAR_BY_MODEL: Record<string, number> = {
  "haiku4.5": 0.0002,
  "sonnet4.6": 0.0006,
};

function estimateCredits(model: string, chars: number): number {
  const rate = COST_PER_CHAR_BY_MODEL[model];
  if (rate === undefined) return 0;
  return Number((chars * rate).toFixed(2));
}

type CarlConfig = {
  models?: {
    architect?: string;
    developer?: string;
    reviewer?: string;
  };
};

const DEFAULT_MODELS: Record<string, string> = {
  architect: "gemini-3.1-pro-preview",
  developer: "haiku4.5",
  reviewer: "sonnet4.6",
};

function loadCarlConfig(workspaceRoot: string): CarlConfig {
  const carlDir = path.join(workspaceRoot, EVENTS_LOG_DIR);
  const configPath = path.join(carlDir, "config.json");
  if (!fs.existsSync(configPath)) {
    const defaults: CarlConfig = {
      models: {
        architect: DEFAULT_MODELS.architect,
        developer: DEFAULT_MODELS.developer,
        reviewer: DEFAULT_MODELS.reviewer,
      },
    };
    fs.mkdirSync(carlDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    return defaults;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CarlConfig;
  } catch {
    return {};
  }
}

type PromptResponse = string | { text: string; usage?: Record<string, any> };

function loadSkillFile(name: string): string {
  for (const dir of [CARL_SKILLS_DIR, GLOBAL_SKILLS_DIR]) {
    const p = path.join(dir, `${name}.md`);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return "";
}

function getPhaseModel(phase: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const config = loadCarlConfig(workspaceRoot);
    const override = config.models?.[phase as keyof NonNullable<CarlConfig["models"]>];
    if (override) return override;
  }
  return DEFAULT_MODELS[phase] ?? "haiku4.5";
}

/**
 * Check if a ticket file has open tickets.
 * Returns true if:
 * - File doesn't exist (assume work exists, no skip)
 * - File exists and contains at least one open [ ] ticket heading (e.g., `## [ ] t-1: ...`)
 * Returns false if:
 * - File exists but contains no open [ ] ticket headings
 *
 * Only considers ticket heading lines (starting with `##`) as tickets.
 * Ignores `[ ]` or `[x]` appearing in AC prose or inline examples.
 */
export function hasOpenTickets(ticketFilePath: string): boolean {
  if (!fs.existsSync(ticketFilePath)) {
    // File doesn't exist - assume work exists, don't skip
    return true;
  }

  try {
    const content = fs.readFileSync(ticketFilePath, "utf-8");
    // Check for open ticket headings: lines starting with ## followed by [ ] (with optional whitespace)
    // Example matches: "## [ ] t-1: ...", "## [ ]t-1: ..."
    return /^##\s*\[\s*\]/m.test(content);
  } catch {
    // On read error, assume work exists, don't skip
    return true;
  }
}

/**
 * Count the number of open tickets in a ticket file.
 * Returns 0 if:
 * - File doesn't exist
 * - File exists but contains no open [ ] ticket headings
 * Returns the count of open [ ] ticket headings otherwise
 *
 * Only considers ticket heading lines (starting with `##`) as tickets.
 * Ignores `[ ]` or `[x]` appearing in AC prose or inline examples.
 */
export function countOpenTickets(ticketFilePath: string): number {
  if (!fs.existsSync(ticketFilePath)) {
    return 0;
  }

  try {
    const content = fs.readFileSync(ticketFilePath, "utf-8");
    // Count open ticket headings: lines starting with ## followed by [ ] (with optional whitespace)
    // Example matches: "## [ ] t-1: ...", "## [ ]t-1: ..."
    const matches = content.match(/^##\s*\[\s*\]/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function extractPromptResponseText(
  response: PromptResponse,
): [string, Record<string, any> | undefined] {
  if (typeof response === "string") {
    return [response, undefined];
  }
  // response is an object with text and optional usage
  const usage = response.usage
    ? { source: "auggie", ...response.usage }
    : undefined;
  return [response.text, usage];
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
  console.log(`[Timing] ${event} duration ${durationMs}ms ${subject}`);
}

export function buildSkillInstruction(
  phaseName: string,
  workspaceRoot?: string,
): string {
  const skillContent = loadSkillFile(phaseName);
  let instruction = skillContent
    ? `# Your skill for this session\n\n${skillContent}`
    : `Follow the ${phaseName} skill.`;

  // For reviewer phase, include git context: branch, files changed, proposed commit message guidance
  if (phaseName === "reviewer" && workspaceRoot) {
    // Add branch context section
    const branch = getCurrentBranch(workspaceRoot);
    if (branch) {
      instruction += `\n\n---\n\n# Current branch\n\n\`${branch}\`\n\n`;
    }

    // Add proposed commit message guidance section
    instruction += "\n\n---\n\n# Proposed commit message\n\n";
    instruction +=
      "After you finish your validation, provide a `## Proposed commit message` section " +
      "with a real commit subject and optional short body. This message should:\n\n";
    instruction += "- **Subject line** (required): ";
    if (branch && branch !== "main" && branch !== "master") {
      // Ticket branch: use ticket-prefix format
      instruction +=
        "Start with the ticket prefix extracted from the current branch name (e.g., `CLIENTS-934:`). " +
        "Follow it with a concise summary of code/behavior changes, not workflow meta (no mentions of gates, phases, or checklists).\n\n";
    } else {
      // Non-ticket branch: use conventional commit
      instruction +=
        "Use a conventional-commit style prefix (`fix:`, `chore:`, `feat:`, `docs:`, `refactor:`, `style:`, etc.) " +
        "followed by a concise summary of code/behavior changes, not workflow meta (no mentions of gates, phases, or checklists).\n\n";
    }
    instruction +=
      "- **Body** (optional): A short paragraph explaining the why and what if needed, keeping focus on code changes.\n\n";
    instruction += "Example:\n\n";
    instruction += "```\n";
    instruction += "## Proposed commit message\n\n";
    if (branch && branch !== "main" && branch !== "master") {
      instruction += "CLIENTS-934: Fix download timeout handling\n\n";
      instruction +=
        "Increase default timeout from 30s to 60s in HTTP client.\n";
    } else {
      instruction += "fix: Download timeout handling\n\n";
      instruction +=
        "Increase default timeout from 30s to 60s in HTTP client.\n";
    }
    instruction += "```\n";

    // Add files changed section
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

  return instruction;
}

// Architect output goes to .agent/decisions.md (top-level, durable artifact).
// Reviewer output goes to .agent/notes/reviewer.md (ephemeral phase note).
function writePhaseOutput(
  phaseName: string,
  phaseOutput: string,
  workspaceRoot: string,
): void {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  if (phaseName === "architect") {
    fs.writeFileSync(path.join(agentDir, "decisions.md"), phaseOutput, "utf-8");
    return;
  }

  const notesDir = path.join(agentDir, "notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(notesDir, `${phaseName}.md`),
    phaseOutput,
    "utf-8",
  );
}

export interface RunPhaseResult {
  status: "success" | "blocked" | "skipped";
  response: string;
}

// Wall-clock timeout per phase. Phases not listed have no timeout.
const PHASE_TIMEOUT_MS: Record<string, number> = {
  developer: 14 * 60 * 1000,
};

function writeTimeoutDiagnostic(
  workspaceRoot: string,
  phaseName: string,
  command: string,
  runId: string,
  timeoutMs: number,
  elapsedMs: number,
  sessionLog: string[],
): void {
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
): Promise<RunPhaseResult> {
  const runId = randomUUID();
  const model = getPhaseModel(phaseName, workspaceRoot);
  const phaseStartTime = Date.now();

  // Developer skips if no open tickets.
  if (phaseName === "developer") {
    if (!hasOpenTickets(path.join(workspaceRoot, ".agent", "dev-tickets.md"))) {
      console.log(`[System] No open dev tickets. Nothing for developer to do.`);
      return { status: "skipped", response: "" };
    }
  }

  // Architect skill detects continuation via decisions.md / dev-tickets.md / test-tickets.md on disk.
  let instruction = buildSkillInstruction(phaseName, workspaceRoot);
  if (phaseName === "architect" && initialPrompt) {
    instruction += `\n\n# User request\n\n${initialPrompt}\n\nThe user has already stated their request above. Skip the menu — proceed directly with this request.`;
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
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(
        `  [System] Network error. Retrying (attempt ${attempt + 1}/${MAX_FETCH_RETRIES + 1})...`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }

    console.log(
      `  [System] Initializing agent and indexing workspace (this may take a few minutes)...`,
    );
    console.log(`[Timing] Auggie.create entry ${phaseName}/${model}`);
    const auggleCreateStart = Date.now();
    const client = await Auggie.create({
      workspaceRoot,
      model: model as any,
      allowIndexing: true,
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
      const promptPromise = client.prompt(instruction, { isAnswerOnly: true });
      let raw: string;
      try {
        if (timeoutMs) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
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
                new Error(
                  `${phaseName} exceeded ${timeoutMs / 60000}m timeout — cancelled. Diagnostic written to .agent/notes/timeout-${phaseName}-${runId}.md`,
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
      const totalChars = instruction.length + response.length;
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
          estimated_credits: estimateCredits(model, totalChars),
          ...(usage && { usage }),
        },
      );
    } catch (err) {
      if (attempt < MAX_FETCH_RETRIES && isTransientFetchError(err)) {
        shouldRetry = true;
      } else if (isTransientFetchError(err)) {
        // All retries exhausted — surface a clean message instead of the raw SDK error.
        throw new Error(
          `Network unavailable after ${MAX_FETCH_RETRIES + 1} attempts — run \`carl ${command}\` to retry.`,
        );
      } else {
        throw err;
      }
    } finally {
      try {
        await client.close();
      } catch {
        // Best-effort close
      }
    }

    if (!shouldRetry) break;
  }

  const isBlocked = /block(?:ed|er):/i.test(response);
  const status: "success" | "blocked" = isBlocked ? "blocked" : "success";

  writePhaseOutput(phaseName, response, workspaceRoot);

  const phaseMeta: Record<string, any> = { status };
  if (phaseName === "architect") {
    phaseMeta.dev_open_tickets = countOpenTickets(
      path.join(workspaceRoot, ".agent", "dev-tickets.md"),
    );
    phaseMeta.test_open_tickets = countOpenTickets(
      path.join(workspaceRoot, ".agent", "test-tickets.md"),
    );
  }
  logTimingDuration(
    workspaceRoot,
    runId,
    "phase",
    phaseName,
    Date.now() - phaseStartTime,
    phaseName,
    model,
    command,
    phaseMeta,
  );

  return { status, response };
}
