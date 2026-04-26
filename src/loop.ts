import { StateManager } from "./state";
import {
  getNextPhase,
  getPhaseModel,
  HAPPY_PATH_GRAPH,
  GATE_PHASES,
} from "./graph";
import { blue, yellow } from "./colors";
import { runJustFormat, runJustLint, runCanonicalTests } from "./just";
import { getGitStatus, getCurrentBranch } from "./git";
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
  meta?: Record<string, any>;
};

type PromptResponse = string | { text: string; usage?: Record<string, any> };

// Shared Auggie client for the current run + phase, so we can:
// - reuse a session across editor gate round-trips for the same phase
// - but avoid sharing a single client across different phases
let sharedClient: any | null = null;
let sharedClientPhase: string | null = null;
let sharedClientRunId: string | null = null;

// Separate test-writer client (never shared with developer or other phases)
let testWriterClient: any | null = null;
let testWriterClientRunId: string | null = null;

export async function closeSharedClient(): Promise<void> {
  if (sharedClient) {
    try {
      await sharedClient.close();
    } catch {
      // Best-effort close; errors here shouldn't prevent workflow completion
    }
    sharedClient = null;
    sharedClientPhase = null;
    sharedClientRunId = null;
  }
  if (testWriterClient) {
    try {
      await testWriterClient.close();
    } catch {
      // Best-effort close
    }
    testWriterClient = null;
    testWriterClientRunId = null;
  }
}

const SKILL_ALIASES: Record<string, string[]> = {
  // Developer phase is implemented by the coder skill; keep developer as a legacy alias
  developer: ["coder", "developer"],
};

function loadSkillFile(name: string): string {
  const searchNames = SKILL_ALIASES[name] ?? [name];
  const searchDirs = [CARL_SKILLS_DIR, GLOBAL_SKILLS_DIR];
  for (const skillName of searchNames) {
    for (const dir of searchDirs) {
      const p = path.join(dir, `${skillName}.md`);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    }
  }
  return "";
}

/**
 * Check if a ticket file has open tickets.
 * Returns true if:
 * - File doesn't exist (assume work exists, no skip)
 * - File exists and contains at least one open [ ] ticket
 * Returns false if:
 * - File exists but contains no open [ ] tickets
 */
export function hasOpenTickets(ticketFilePath: string): boolean {
  if (!fs.existsSync(ticketFilePath)) {
    // File doesn't exist - assume work exists, don't skip
    return true;
  }

  try {
    const content = fs.readFileSync(ticketFilePath, "utf-8");
    // Check for any open tickets: [ ] pattern (with optional leading -#* before it)
    return /\[\s*\]/.test(content);
  } catch {
    // On read error, assume work exists, don't skip
    return true;
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
    meta,
  });
  console.log(`[Timing] ${event} duration ${durationMs}ms ${subject}`);
}

function writeTestArtifacts(
  workspaceRoot: string,
  result: ReturnType<typeof runCanonicalTests>,
): void {
  const agentDir = path.join(workspaceRoot, ".agent");
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  // Write test summary JSON
  const summary = {
    command: result.command,
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    timestamp: new Date().toISOString(),
  };
  const summaryPath = path.join(agentDir, "tests-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  // Write test log on failure
  if (result.exitCode !== 0) {
    const logContent = `Command: ${result.command}\n\nStdout:\n${result.stdout}\n\nStderr:\n${result.stderr}`;
    const logPath = path.join(agentDir, "tests.log");
    fs.writeFileSync(logPath, logContent, "utf-8");
  }
}

function parsePrerequisites(skillContent: string): string[] {
  const frontmatter = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return [];
  const block = frontmatter[1].match(
    /prerequisites:\s*\n((?:[ \t]+-[ \t]+\S+\n?)+)/,
  );
  if (!block) return [];
  return (block[1].match(/\S+/g) ?? []).filter((s) => s !== "-");
}

export function buildSkillInstruction(
  phaseName: string,
  workspaceRoot?: string,
): string {
  const skillContent = loadSkillFile(phaseName);
  let instruction = skillContent
    ? `# Your skill for this session\n\n${skillContent}`
    : `Follow the ${phaseName} skill.`;

  // Embed prerequisite skills that are not phase skills (those run in their own sessions)
  const prerequisites = parsePrerequisites(skillContent);
  for (const prereq of prerequisites) {
    if (HAPPY_PATH_GRAPH.includes(prereq)) continue;
    const prereqContent = loadSkillFile(prereq);
    if (prereqContent) {
      instruction += `\n\n---\n\n# Supporting skill: ${prereq}\n\n${prereqContent}`;
    }
  }

  // For reviewer phase, include deterministic context: git status, branch context, lint results, and proposed commit message section
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

    // Add lint results if available
    const lintLogPath = path.join(workspaceRoot, ".agent", "lint.log");
    if (fs.existsSync(lintLogPath)) {
      const lintContent = fs.readFileSync(lintLogPath, "utf-8");
      instruction += "# Lint results\n\n```\n" + lintContent + "\n```";
    }

    // Add test results if available
    const testSummaryPath = path.join(
      workspaceRoot,
      ".agent",
      "tests-summary.json",
    );
    if (fs.existsSync(testSummaryPath)) {
      try {
        const summary = JSON.parse(fs.readFileSync(testSummaryPath, "utf-8"));
        instruction += "\n\n# Tests/Verification\n\n";
        instruction += `Test command: \`${summary.command}\`\n\n`;
        instruction += `**Status:** ${summary.status}\n\n`;

        // If tests failed, include log snippet
        if (summary.status === "FAIL") {
          const testLogPath = path.join(workspaceRoot, ".agent", "tests.log");
          if (fs.existsSync(testLogPath)) {
            const logContent = fs.readFileSync(testLogPath, "utf-8");
            instruction += "**Output:**\n\n```\n" + logContent + "\n```";
          }
        }
      } catch {
        // Ignore parse errors; just skip test results section
      }
    }
  }

  return instruction;
}

// Phases that read from and write to the shared workflow context.
// Developer and verifier run in clean context windows with no prior workflow context injected.
/**
 * Write phase notes to .agent/notes/{phaseName}.md
 */
function writePhaseNotes(
  phaseName: string,
  phaseOutput: string,
  workspaceRoot: string,
): void {
  const agentDir = path.join(workspaceRoot, ".agent");

  // Ensure notes directory exists and write phase notes
  const notesDir = path.join(agentDir, "notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  const notesFileName = `${phaseName}.md`;
  fs.writeFileSync(path.join(notesDir, notesFileName), phaseOutput, "utf-8");
}

/**
 * Run the test-writer phase in parallel with developer.
 * Returns the test-writer response or throws if creation fails.
 */
async function runTestWriterPhase(
  workspaceRoot: string,
  runId: string,
): Promise<string> {
  const { Auggie } = await import("@augmentcode/auggie-sdk");

  // Close and discard any existing test-writer client from a different run
  if (testWriterClient && testWriterClientRunId !== runId) {
    try {
      await testWriterClient.close();
    } catch {
      // Best-effort close
    }
    testWriterClient = null;
    testWriterClientRunId = null;
  }

  // Create a new test-writer client if needed
  if (!testWriterClient) {
    console.log(`[Timing] Auggie.create entry test-writer/haiku4.5`);
    const auggleCreateStart = Date.now();
    testWriterClient = await Auggie.create({
      workspaceRoot: workspaceRoot,
      model: "haiku4.5",
      allowIndexing: true,
    });
    const auggleCreateDuration = Date.now() - auggleCreateStart;
    logTimingDuration(
      workspaceRoot,
      runId,
      "Auggie.create",
      "test-writer/haiku4.5",
      auggleCreateDuration,
      "test-writer",
      "haiku4.5",
    );
    testWriterClientRunId = runId;
  }

  testWriterClient.onSessionUpdate((notification: any) => {
    const update = notification.update;
    if (update) {
      if (update.sessionUpdate === "tool_call") {
        console.log(
          `\n  [test-writer/haiku4.5] Running tool: ${update.title || "unknown"}...`,
        );
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        if (update.content && update.content.text) {
          process.stdout.write(`\x1b[90m${update.content.text}\x1b[0m`);
        }
      }
    }
  });

  const testWriterInstruction = buildSkillInstruction(
    "test-writer",
    workspaceRoot,
  );
  console.log(
    `  [System] Agent initialized. Sending prompt and awaiting response...`,
  );
  console.log(`[Timing] prompt entry test-writer/haiku4.5`);
  const testWriterPromptStart = Date.now();
  const testWriterResponseRaw = await testWriterClient.prompt(
    testWriterInstruction,
    { isAnswerOnly: true },
  );
  const [testWriterResponse, testWriterUsage] = extractPromptResponseText(
    testWriterResponseRaw,
  );
  const testWriterPromptDuration = Date.now() - testWriterPromptStart;
  logTimingDuration(
    workspaceRoot,
    runId,
    "prompt",
    "test-writer/haiku4.5",
    testWriterPromptDuration,
    "test-writer",
    "haiku4.5",
    {
      prompt_chars: testWriterInstruction.length,
      response_chars: testWriterResponse.length,
      ...(testWriterUsage && { usage: testWriterUsage }),
    },
  );

  return testWriterResponse;
}

export async function runLoop(stateManager: StateManager): Promise<void> {
  let state = stateManager.load();

  if (state.status === "awaiting_approval") {
    throw new Error(
      "Workflow is awaiting approval. Run `carl approve` or `carl reject`.",
    );
  }

  // Ensure we are in a running state to start the loop
  if (state.status === "paused") {
    state = stateManager.update({ status: "running" });
  }

  const { Auggie } = await import("@augmentcode/auggie-sdk");

  const runId = state.run_id;

  while (state.status === "running") {
    const phaseName = state.current_phase;
    const model = getPhaseModel(phaseName);
    const phaseStartTime = Date.now();

    console.log(`Starting phase: ${phaseName}`);
    console.log(
      `  [System] Initializing agent and indexing workspace (this may take a few minutes)...`,
    );

    let client = sharedClient;
    // If we have a client from a different run or phase, close and discard it
    if (
      client &&
      (sharedClientRunId !== runId || sharedClientPhase !== phaseName)
    ) {
      try {
        await client.close();
      } catch {
        // Best-effort close; errors here shouldn't abort the workflow
      }
      sharedClient = null;
      sharedClientPhase = null;
      sharedClientRunId = null;
      client = null;
    }

    // Create a new client when there isn't a matching one for this run + phase
    if (!client) {
      console.log(`[Timing] Auggie.create entry ${phaseName}/${model}`);
      const auggleCreateStart = Date.now();
      client = await Auggie.create({
        workspaceRoot: state.workspace_path,
        model: model as any,
        allowIndexing: true,
      });
      const auggleCreateDuration = Date.now() - auggleCreateStart;
      logTimingDuration(
        state.workspace_path,
        runId,
        "Auggie.create",
        `${phaseName}/${model}`,
        auggleCreateDuration,
        phaseName,
        model,
      );
      sharedClient = client;
      sharedClientPhase = phaseName;
      sharedClientRunId = runId;
    }

    client.onSessionUpdate((notification: any) => {
      const update = notification.update;
      if (update) {
        if (update.sessionUpdate === "tool_call") {
          console.log(
            `\n  [${phaseName}/${model}] Running tool: ${update.title || "unknown"}...`,
          );
        } else if (update.sessionUpdate === "agent_thought_chunk") {
          if (update.content && update.content.text) {
            // Print thoughts in dim gray
            process.stdout.write(`\x1b[90m${update.content.text}\x1b[0m`);
          }
        }
      }
    });

    try {
      let instruction = buildSkillInstruction(phaseName, state.workspace_path);

      const history = state.history || [];
      const lastEntry = history.length > 0 ? history[history.length - 1] : null;

      // Only inject the initial prompt on the very first architect run (no prior architect history)
      const hasPriorArchitectRun = history.some((h) => h.phase === "architect");
      if (
        phaseName === "architect" &&
        state.initial_prompt &&
        !hasPriorArchitectRun
      ) {
        instruction += `\n\n# User request\n\n${state.initial_prompt}\n\nThe user has already stated their request above. Skip the menu — proceed directly with this request.`;
      }

      // Fallback: raw prior output for this phase if context engine is unavailable
      const priorOutput = history
        .slice()
        .reverse()
        .find((h) => h.phase === phaseName && h.status === "success");

      if (state.pending_reply) {
        if (priorOutput) {
          instruction += `\n\n# Your previous output\n\n${priorOutput.outputs}`;
        }
        instruction += `\n\n# Human reply\n\n${state.pending_reply}\n\nContinue from where you left off using this answer. Do not re-ask questions that have been answered.`;
        state = stateManager.update({ pending_reply: undefined });
      } else if (lastEntry && lastEntry.status === "rejected") {
        if (priorOutput) {
          instruction += `\n\n# Your previous output\n\n${priorOutput.outputs}`;
        }
        instruction += `\n\n# Rejection feedback\n\n${lastEntry.outputs}\n\nPlease incorporate this feedback and try again.`;
      } else if (lastEntry && lastEntry.status === "blocked") {
        instruction += `\n\n# Blocker\n\n${lastEntry.outputs}\n\nPlease fix the underlying issues and try again.`;
      } else if (lastEntry && lastEntry.phase !== phaseName) {
        // Only reviewer receives prior workflow context (architect plan/decisions).
        // Developer runs clean — it reads .agent/dev-tickets.md directly (created by architect).
        if (phaseName === "reviewer") {
          // Look for the most recent architect success in history
          const architectOutput = history
            .slice()
            .reverse()
            .find((h) => h.phase === "architect" && h.status === "success");
          if (architectOutput) {
            instruction += `\n\n# Prior workflow context\n\n${architectOutput.outputs}`;
          }
        }
      }

      console.log(
        `  [System] Agent initialized. Sending prompt and awaiting response...`,
      );

      let response: string;
      let isBlocked: boolean;

      // Check if developer/test-writer should be skipped due to no open tickets
      const devTicketsPath = path.join(
        state.workspace_path,
        ".agent",
        "dev-tickets.md",
      );
      const testTicketsPath = path.join(
        state.workspace_path,
        ".agent",
        "test-tickets.md",
      );
      const hasDevTickets = hasOpenTickets(devTicketsPath);
      const hasTestTickets = hasOpenTickets(testTicketsPath);

      // Run coder and test-writer in parallel for the developer phase
      // If BOTH have no tickets, skip the entire phase; otherwise run what we can
      if (phaseName === "developer" && !hasDevTickets && !hasTestTickets) {
        // No open developer or test tickets - skip the phase entirely
        console.log(
          `[System] No open developer or test tickets. Skipping developer phase.`,
        );

        const history = state.history || [];
        const phaseStartTime = Date.now();
        const phaseDuration = Date.now() - phaseStartTime;

        // Record both entries as success (no-op)
        history.push({
          phase: "developer",
          model: model,
          status: "success",
          outputs: "",
        });

        history.push({
          phase: "test-writer",
          model: "haiku4.5",
          status: "success",
          outputs: "",
        });

        // Log phase events
        logTimingDuration(
          state.workspace_path,
          runId,
          "phase",
          "developer",
          phaseDuration,
          "developer",
          model,
          { status: "success", blocked: false },
        );

        logTimingDuration(
          state.workspace_path,
          runId,
          "phase",
          "test-writer",
          phaseDuration,
          "test-writer",
          "haiku4.5",
          { status: "success", blocked: false },
        );

        // Transition to next phase
        const nextPhase = getNextPhase("developer");
        if (nextPhase) {
          state = stateManager.update({
            history,
            current_phase: nextPhase,
          });
          console.log(`[System] Transitioning to: ${nextPhase}`);
        }
        continue;
      } else if (phaseName === "developer") {
        // At least one of dev or test has tickets (we skipped both above)
        const coderRunsPrompt = hasDevTickets;
        const testWriterRunsPrompt = hasTestTickets;

        if (coderRunsPrompt && testWriterRunsPrompt) {
          console.log(
            `[Timing] prompt entry coder/${model} and test-writer/haiku4.5 in parallel`,
          );
        } else if (coderRunsPrompt) {
          console.log(
            `[Timing] prompt entry coder/${model} (test-writer has no tickets)`,
          );
        } else {
          console.log(
            `[Timing] prompt entry test-writer/haiku4.5 (coder has no tickets)`,
          );
        }

        const promptStart = Date.now();

        // Prepare test-writer instruction in advance if needed
        let testWriterInstruction = "";
        let twClient: any = null;
        if (testWriterRunsPrompt) {
          testWriterInstruction = buildSkillInstruction(
            "test-writer",
            state.workspace_path,
          );

          // Ensure test-writer client is ready
          twClient = testWriterClient;
          if (!twClient) {
            console.log(`[Timing] Auggie.create entry test-writer/haiku4.5`);
            const auggleCreateStart = Date.now();
            twClient = await Auggie.create({
              workspaceRoot: state.workspace_path,
              model: "haiku4.5",
              allowIndexing: true,
            });
            const auggleCreateDuration = Date.now() - auggleCreateStart;
            logTimingDuration(
              state.workspace_path,
              runId,
              "Auggie.create",
              "test-writer/haiku4.5",
              auggleCreateDuration,
              "test-writer",
              "haiku4.5",
            );
            testWriterClient = twClient;
            testWriterClientRunId = runId;
          }

          twClient.onSessionUpdate((notification: any) => {
            const update = notification.update;
            if (update) {
              if (update.sessionUpdate === "tool_call") {
                console.log(
                  `\n  [test-writer/haiku4.5] Running tool: ${update.title || "unknown"}...`,
                );
              } else if (update.sessionUpdate === "agent_thought_chunk") {
                if (update.content && update.content.text) {
                  process.stdout.write(`\x1b[90m${update.content.text}\x1b[0m`);
                }
              }
            }
          });
        }

        // Run prompts conditionally
        let coderResponse = "";
        let testWriterResponse = "";
        let coderUsage: Record<string, any> | undefined = undefined;
        if (coderRunsPrompt && testWriterRunsPrompt) {
          // Both run in parallel
          const [crRaw, trRaw] = await Promise.all([
            client.prompt(instruction, { isAnswerOnly: true }),
            twClient!.prompt(testWriterInstruction, { isAnswerOnly: true }),
          ]);
          const [cr, crUsage] = extractPromptResponseText(crRaw);
          const [tr] = extractPromptResponseText(trRaw);
          coderResponse = cr;
          testWriterResponse = tr;
          coderUsage = crUsage;
        } else if (coderRunsPrompt) {
          // Only coder runs
          const crRaw = await client.prompt(instruction, {
            isAnswerOnly: true,
          });
          const [cr, crUsage] = extractPromptResponseText(crRaw);
          coderResponse = cr;
          testWriterResponse = ""; // No-op
          coderUsage = crUsage;
        } else {
          // Only test-writer runs
          const trRaw = await twClient!.prompt(testWriterInstruction, {
            isAnswerOnly: true,
          });
          const [tr] = extractPromptResponseText(trRaw);
          testWriterResponse = tr;
          coderResponse = ""; // No-op
        }

        const promptDuration = Date.now() - promptStart;
        logTimingDuration(
          state.workspace_path,
          runId,
          "prompt",
          `coder/${model} and test-writer/haiku4.5`,
          promptDuration,
          phaseName,
          model,
          {
            prompt_chars: instruction.length,
            response_chars: coderResponse.length,
            blocked:
              /block(?:ed|er):/i.test(coderResponse) ||
              /block(?:ed|er):/i.test(testWriterResponse),
            ...(coderUsage && { usage: coderUsage }),
          },
        );

        response = coderResponse;
        isBlocked = /block(?:ed|er):/i.test(response);

        // Add developer entry first (deterministic order)
        history.push({
          phase: phaseName,
          model: model,
          status: isBlocked ? "blocked" : "success",
          outputs: response,
        });

        // Add test-writer entry (always after developer in deterministic order)
        const testWriterBlocked = /block(?:ed|er):/i.test(testWriterResponse);
        history.push({
          phase: "test-writer",
          model: "haiku4.5",
          status: testWriterBlocked ? "blocked" : "success",
          outputs: testWriterResponse,
        });

        // If either is blocked, we'll handle it below
        if (testWriterBlocked && !isBlocked) {
          isBlocked = true; // Treat as blocked for the gating logic
        }
      } else {
        // Non-developer phases run normally (sequential)
        console.log(`[Timing] prompt entry ${phaseName}/${model}`);
        const promptStart = Date.now();
        const responseRaw = await client.prompt(instruction, {
          isAnswerOnly: true,
        });
        const [responseText, responseUsage] =
          extractPromptResponseText(responseRaw);
        response = responseText;
        const promptDuration = Date.now() - promptStart;
        logTimingDuration(
          state.workspace_path,
          runId,
          "prompt",
          `${phaseName}/${model}`,
          promptDuration,
          phaseName,
          model,
          {
            prompt_chars: instruction.length,
            response_chars: response.length,
            ...(responseUsage && { usage: responseUsage }),
          },
        );

        isBlocked = false; // Only developer can be blocked

        history.push({
          phase: phaseName,
          model: model,
          status: "success",
          outputs: response,
        });
      }

      if (!isBlocked && phaseName === "architect") {
        // Write architect notes
        writePhaseNotes(phaseName, response, state.workspace_path);
      }

      if (!isBlocked && phaseName === "reviewer") {
        // Write reviewer notes
        writePhaseNotes(phaseName, response, state.workspace_path);
      }

      const phaseDuration = Date.now() - phaseStartTime;

      // Determine phase status for logging
      let phaseStatus = "success";
      let developerPhaseBlocked = false;

      // Special handling for developer phase: check if either developer or test-writer blocked
      let shouldTransitionToArchitect = false;
      if (phaseName === "developer") {
        // Both developer and test-writer have already completed above in parallel
        // Check if either reported a blocker
        const devEntry = history[history.length - 2]; // developer entry
        const twEntry = history[history.length - 1]; // test-writer entry

        const devBlocked = devEntry?.status === "blocked";
        const twBlocked = twEntry?.status === "blocked";

        if (devBlocked || twBlocked) {
          phaseStatus = "blocked";
          developerPhaseBlocked = true;
          // One or both blocked; don't run deterministic checks
          shouldTransitionToArchitect = true;
          isBlocked = true; // Mark as blocked so we transition to architect below
        }
      }

      // Log phase event with status
      logTimingDuration(
        state.workspace_path,
        runId,
        "phase",
        phaseName,
        phaseDuration,
        phaseName,
        model,
        {
          status: phaseStatus,
          ...(phaseName === "developer" && { blocked: developerPhaseBlocked }),
        },
      );

      if (isBlocked) {
        state = stateManager.update({ history, current_phase: "architect" });
        const blockedPhase =
          phaseName === "developer"
            ? shouldTransitionToArchitect &&
              history[history.length - 1]?.status === "blocked"
              ? "test-writer"
              : "developer"
            : phaseName;
        console.log(
          blue(
            `Phase ${blockedPhase} reported a blocker. Handing back to architect.`,
          ),
        );
        continue;
      }

      const isGate = GATE_PHASES.has(phaseName);
      const nextPhase = getNextPhase(phaseName);

      if (isGate) {
        state = stateManager.update({ history, status: "awaiting_approval" });
        console.log(`Phase ${phaseName} completed. Awaiting approval.`);
        break; // Pause loop
      } else if (nextPhase) {
        // After developer and test-writer complete (in parallel), run deterministic checks
        if (phaseName === "developer") {
          // Both completed above; continue with deterministic checks

          console.log(
            `[System] Running deterministic format and lint checks...`,
          );
          runJustFormat(state.workspace_path);
          const lintResult = runJustLint(state.workspace_path);
          console.log(
            `[System] Lint check completed: ${lintResult.status}${lintResult.statusReason ? ` (${lintResult.statusReason})` : ""}`,
          );

          console.log(`[System] Running deterministic test suite...`);
          const testResult = runCanonicalTests(state.workspace_path);
          writeTestArtifacts(state.workspace_path, testResult);
          console.log(`[System] Test run completed.`);

          // Handle test failure gating logic
          if (testResult.exitCode !== 0) {
            const currentFailures = (state.developer_test_failures ?? 0) + 1;
            const failureMessage =
              currentFailures === 1
                ? `Tests failed (${testResult.command}). Staying in developer phase for retry.`
                : `Tests failed again (${testResult.command}). Escalating to architect due to persistent test failures.`;

            history.push({
              phase: "developer",
              model: getPhaseModel(phaseName),
              status: "blocked",
              outputs: failureMessage,
            });

            if (currentFailures >= 2) {
              // Escalate to architect
              state = stateManager.update({
                history,
                current_phase: "architect",
                status: "running",
                developer_test_failures: currentFailures,
              });
              console.log(
                blue(
                  `Tests have failed ${currentFailures} times. Escalating to architect for scope/AC adjustment.`,
                ),
              );
              return;
            } else {
              // Stay in developer phase
              state = stateManager.update({
                history,
                developer_test_failures: currentFailures,
              });
              console.log(
                blue(
                  `Tests failed (${currentFailures} strike). Staying in developer phase.`,
                ),
              );
              return;
            }
          }
          // Tests passed, reset counter
          state = { ...state, developer_test_failures: 0 };
        }

        state = stateManager.update({
          history,
          current_phase: nextPhase,
          developer_test_failures: state.developer_test_failures,
        });
        console.log(
          `Phase ${phaseName} completed successfully. Advancing to ${nextPhase}.`,
        );
      } else {
        state = stateManager.update({ history, status: "completed" });
        console.log(`Phase ${phaseName} completed. Workflow finished.`);
        break; // Exit loop
      }
    } catch (error: any) {
      const history = state.history || [];
      history.push({
        phase: phaseName,
        model: model,
        status: "failed",
        outputs: error.message || String(error),
      });
      stateManager.update({ history });
      // On failure, close and clear any shared client for this run
      if (sharedClient && sharedClientRunId === runId) {
        try {
          await sharedClient.close();
        } catch {
          // Ignore close errors on failure path
        }
        sharedClient = null;
        sharedClientPhase = null;
        sharedClientRunId = null;
      }
      throw error;
    }
  }
}
