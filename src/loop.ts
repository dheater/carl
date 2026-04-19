import { StateManager } from "./state";
import {
  getNextPhase,
  getFallbackPhase,
  getPhaseModel,
  HAPPY_PATH_GRAPH,
  GATE_PHASES,
} from "./graph";
import { blue, yellow } from "./colors";
import { runJustFormat, runJustLint } from "./just";
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

function parsePrerequisites(skillContent: string): string[] {
  const frontmatter = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return [];
  const block = frontmatter[1].match(
    /prerequisites:\s*\n((?:[ \t]+-[ \t]+\S+\n?)+)/,
  );
  if (!block) return [];
  return (block[1].match(/\S+/g) ?? []).filter((s) => s !== "-");
}

function buildSkillInstruction(phaseName: string, workspaceRoot?: string): string {
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

  // For reviewer phase, include lint results if available
  if (phaseName === "reviewer" && workspaceRoot) {
    const lintLogPath = path.join(workspaceRoot, ".agent", "lint.log");
    if (fs.existsSync(lintLogPath)) {
      const lintContent = fs.readFileSync(lintLogPath, "utf-8");
      instruction += `\n\n---\n\n# Lint results\n\n\`\`\`\n${lintContent}\n\`\`\``;
    }
  }

  return instruction;
}

// What each phase needs to recover from context when resuming or after rejection
const PHASE_CONTEXT_QUERIES: Record<string, string> = {
  architect:
    "scope, clarifying questions, user answers, requirements, constraints",
  developer: "tickets, implementation tasks, technical approach",
  verifier:
    "implementation results, completed tickets, code changes, test commands",
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
        (phaseName === "developer" || phaseName === "verifier") &&
        /block(?:ed|er):/i.test(response);

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
        } else if (phaseName === "verifier") {
          fs.writeFileSync(
            path.join(agentDir, "qa-report.md"),
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

        // After developer completes, run deterministic format/lint before verifier
        if (phaseName === "developer") {
          console.log(`[System] Running deterministic format and lint checks...`);
          runJustFormat(state.workspace_path);
          runJustLint(state.workspace_path);
          console.log(`[System] Format and lint checks completed.`);
        }

        state = stateManager.update({ history, current_phase: nextPhase });
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
