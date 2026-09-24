import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";
import {
  BEDROCK_MODEL_IDS,
  buildHarnessLaunch,
  describeFailure,
  finalTurnReason,
  sessionDirPath,
  type ModelRoute,
} from "./dsh-runner";
import { buildSkillPersona } from "./skill";

const MENTOR_MODEL = "haiku4.5";

/**
 * A short opening note instead of `buildSkillInstruction`: that helper's
 * read-only note claims the run's output lands in `.agent/notes/<skill>.md`,
 * which is true for one-shot skills and false for a live chat.
 */
function openingNote(workspaceRoot: string): string {
  const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");
  let note = `# Workspace\n\nThe workspace root is \`${workspaceRoot}\`.`;
  if (fs.existsSync(agentsMdPath)) {
    const content = fs.readFileSync(agentsMdPath, "utf-8").trim();
    if (content) note += `\n\n---\n\n${content}`;
  }
  note +=
    "\n\n---\n\n# Sandbox\n\nThis session is read-only. The filesystem " +
    "sandbox refuses every write, including through `bash` — that is the " +
    "point of `carl mentor`, not a misconfiguration.";
  return note;
}

/**
 * `carl mentor`: a non-agentic pairing chat. One live dsh session for the
 * whole terminal split, fixed to Haiku on Bedrock, always read-only — the
 * human types the code, the model only answers.
 */
export async function runMentorRepl(workspaceRoot: string): Promise<void> {
  const modelId = BEDROCK_MODEL_IDS[MENTOR_MODEL];
  const route: ModelRoute = { provider: "amazon-bedrock", modelId };

  const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");

  const sessionRoot = path.join(os.tmpdir(), "carl-mentor-sessions");
  const sessionId = randomUUID();

  const harness = new DeepSeekHarness(
    buildHarnessLaunch({
      route,
      workspaceRoot,
      persona: buildSkillPersona("mentor"),
      sandboxMode: "read-only",
      effort: "low",
      sessionRoot,
    }),
  );
  const session = harness.session(sessionId);

  console.log(
    "carl mentor — read-only, syntax help only. Blank line sends, :q quits.\n",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  let buffer: string[] = [];
  let first = true;
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.prompt();
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (buffer.length === 0 && (trimmed === ":q" || trimmed === "exit")) {
        break;
      }
      if (trimmed === "") {
        if (buffer.length === 0) {
          rl.prompt();
          continue;
        }
        const question = buffer.join("\n");
        buffer = [];
        const input = first
          ? `${openingNote(workspaceRoot)}\n\n---\n\n${question}`
          : question;
        first = false;

        try {
          const result = await session.run(input);
          const reason = finalTurnReason(result.events as never);
          console.log(
            reason && reason.kind !== "completed"
              ? describeFailure(reason)
              : result.finalResponse || "(no response)",
          );
        } catch (err) {
          console.error((err as Error)?.message ?? String(err));
        }
        console.log();
        if (!closed) rl.prompt();
        continue;
      }
      buffer.push(line);
      rl.prompt();
    }
  } catch (err) {
    // stdin can reach EOF while the await above is in flight — a pipe or
    // redirected input drains immediately, unlike a real terminal, where EOF
    // only happens when the human closes the pane. Once that happens,
    // pulling the next line throws instead of draining what was buffered.
    // Treat that as the session ending, not a crash; anything else is real.
    if (!closed) throw err;
  } finally {
    rl.close();
    await harness.close();
    try {
      fs.rmSync(sessionDirPath(sessionRoot, workspaceRoot, sessionId), {
        recursive: true,
        force: true,
      });
    } catch {
      // Best-effort: a missing directory or a permission error must not
      // fail the exit.
    }
  }
}
