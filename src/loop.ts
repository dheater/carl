import { StateManager } from "./state";
import {
  getNextPhase,
  getFallbackPhase,
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

// Shared Auggie client for the current run + phase, so we can:
// - reuse a session across editor gate round-trips for the same phase
// - but avoid sharing a single client across different phases
let sharedClient: any | null = null;
let sharedClientPhase: string | null = null;
let sharedClientRunId: string | null = null;

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
}

function loadSkillFile(name: string): string {
  const candidates = [
    path.join(CARL_SKILLS_DIR, `${name}.md`),
    path.join(GLOBAL_SKILLS_DIR, `${name}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return "";
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

function findDevOnlyTestFiles(workspaceRoot: string): string[] {
  const results: string[] = [];

  function walkDir(dir: string, relativeBase: string = ""): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = relativeBase
          ? path.join(relativeBase, entry.name)
          : entry.name;

        if (entry.isDirectory()) {
          // Skip common directories that shouldn't be searched
          if (
            ["node_modules", ".git", "dist", ".agent", ".tmp"].includes(
              entry.name,
            )
          ) {
            continue;
          }
          walkDir(fullPath, relativePath);
        } else if (entry.name.match(/\.dev\.test\.ts$/)) {
          results.push(relativePath);
        }
      }
    } catch {
      // Ignore errors reading directories
    }
  }

  walkDir(workspaceRoot);
  return results;
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

// What each phase needs to recover from context when resuming or after rejection
const PHASE_CONTEXT_QUERIES: Record<string, string> = {
  architect:
    "scope, clarifying questions, user answers, requirements, constraints",
  developer: "tickets, implementation tasks, technical approach",
  reviewer: "verification results, QA evidence, implementation summary",
};

async function searchContext(ctx: any, phaseName: string): Promise<string> {
  const query =
    PHASE_CONTEXT_QUERIES[phaseName] ?? "prior outputs, decisions, context";
  try {
    return (await ctx.search(query)) ?? "";
  } catch {
    return "";
  }
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

  const { Auggie, DirectContext } = await import("@augmentcode/auggie-sdk");

  const runId = state.run_id;

  // Workflow context: persists across phases in-memory, saved to disk at .agent/context.json
  // between sessions so agents can recover prior decisions without re-running earlier phases.
  const contextPath = path.join(state.workspace_path, ".agent", "context.json");
  let workflowContext: any = null;
  try {
    workflowContext = fs.existsSync(contextPath)
      ? await DirectContext.importFromFile(contextPath)
      : await DirectContext.create();
  } catch (err: any) {
    console.warn(
      yellow(
        `  [System] Context engine unavailable — ${err.message}. Falling back to inline context.`,
      ),
    );
  }

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
      console.log(
        `[Timing] Auggie.create duration ${auggleCreateDuration}ms ${phaseName}/${model}`,
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
        const priorContext = await searchContext(workflowContext, phaseName);
        if (priorContext) {
          instruction += `\n\n# Prior context\n\n${priorContext}`;
        } else if (priorOutput) {
          instruction += `\n\n# Your previous output\n\n${priorOutput.outputs}`;
        }
        instruction += `\n\n# Human reply\n\n${state.pending_reply}\n\nContinue from where you left off using this answer. Do not re-ask questions that have been answered.`;
        state = stateManager.update({ pending_reply: undefined });
      } else if (lastEntry && lastEntry.status === "rejected") {
        const priorContext = await searchContext(workflowContext, phaseName);
        if (priorContext) {
          instruction += `\n\n# Prior context\n\n${priorContext}`;
        } else if (priorOutput) {
          instruction += `\n\n# Your previous output\n\n${priorOutput.outputs}`;
        }
        instruction += `\n\n# Rejection feedback\n\n${lastEntry.outputs}\n\nPlease incorporate this feedback and try again.`;
      } else if (lastEntry && lastEntry.status === "blocked") {
        instruction += `\n\n# Blocker\n\n${lastEntry.outputs}\n\nPlease fix the underlying issues and try again.`;
      } else if (lastEntry && lastEntry.phase !== phaseName) {
        // Fresh cross-phase start — give this phase context about what the prior phase did
        const priorContext = await searchContext(workflowContext, phaseName);
        if (priorContext) {
          instruction += `\n\n# Prior workflow context\n\n${priorContext}`;
        }
      }

      console.log(
        `  [System] Agent initialized. Sending prompt and awaiting response...`,
      );
      console.log(`[Timing] prompt entry ${phaseName}/${model}`);
      const promptStart = Date.now();
      const response = await client.prompt(instruction, { isAnswerOnly: true });
      const promptDuration = Date.now() - promptStart;
      console.log(
        `[Timing] prompt duration ${promptDuration}ms ${phaseName}/${model}`,
      );

      const isBlocked =
        phaseName === "developer" && /block(?:ed|er):/i.test(response);

      history.push({
        phase: phaseName,
        model: model,
        status: isBlocked ? "blocked" : "success",
        outputs: response,
      });

      const agentDir = path.join(state.workspace_path, ".agent");

      if (!isBlocked) {
        if (phaseName === "architect") {
          const notesDir = path.join(agentDir, "notes");
          if (!fs.existsSync(notesDir))
            fs.mkdirSync(notesDir, { recursive: true });
          fs.writeFileSync(
            path.join(notesDir, "architect.md"),
            response,
            "utf-8",
          );
        }

        // Index phase output so future phases and reply turns can search prior decisions
        if (workflowContext) {
          try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            await workflowContext.addToIndex([
              {
                path: `agent-log/${phaseName}-${timestamp}.md`,
                contents: response,
              },
            ]);
            await workflowContext.exportToFile(contextPath);
          } catch {
            // Non-fatal — workflow continues without context persistence
          }
        }
      }

      if (isBlocked) {
        const phaseDuration = Date.now() - phaseStartTime;
        console.log(`[Timing] Phase ${phaseName} duration ${phaseDuration}ms`);
        const fallback = getFallbackPhase(phaseName);
        state = stateManager.update({ history, current_phase: fallback });
        console.log(
          blue(
            `Phase ${phaseName} reported a blocker. Handing back to ${fallback}.`,
          ),
        );
        continue;
      }

      const isGate = GATE_PHASES.has(phaseName);
      const nextPhase = getNextPhase(phaseName);

      if (isGate) {
        const phaseDuration = Date.now() - phaseStartTime;
        console.log(`[Timing] Phase ${phaseName} duration ${phaseDuration}ms`);
        state = stateManager.update({ history, status: "awaiting_approval" });
        console.log(`Phase ${phaseName} completed. Awaiting approval.`);
        break; // Pause loop
      } else if (nextPhase) {
        const phaseDuration = Date.now() - phaseStartTime;
        console.log(`[Timing] Phase ${phaseName} duration ${phaseDuration}ms`);

        // After developer completes, run deterministic format/lint and tests before reviewer
        if (phaseName === "developer") {
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

          // Hygiene check: detect dev-only test files
          console.log(`[System] Checking for dev-only test files...`);
          const devOnlyFiles = findDevOnlyTestFiles(state.workspace_path);
          if (devOnlyFiles.length > 0) {
            const filesStr =
              devOnlyFiles.slice(0, 3).join(", ") +
              (devOnlyFiles.length > 3 ? ", ..." : "");
            const hygienicityFailureMessage = `Dev-only test files found (*.dev.test.ts): ${filesStr}. Please remove or rename these files before approval.`;

            history.push({
              phase: "developer",
              model: getPhaseModel(phaseName),
              status: "blocked",
              outputs: hygienicityFailureMessage,
            });

            const currentFailures = (state.developer_test_failures ?? 0) + 1;
            state = stateManager.update({
              history,
              developer_test_failures: currentFailures,
            });
            console.log(
              blue(`Dev-only test files detected. Staying in developer phase.`),
            );
            return;
          }
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
        const phaseDuration = Date.now() - phaseStartTime;
        console.log(`[Timing] Phase ${phaseName} duration ${phaseDuration}ms`);
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
