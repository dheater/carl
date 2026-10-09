import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  BEDROCK_MODEL_IDS,
  buildQueryOptions,
  describeFailure,
  type SdkMessage,
} from "./claude-runner";
import { buildSkillPersona } from "./skill";

const MENTOR_MODEL = "sonnet5.5";

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

type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

/**
 * The questions the human types, as the SDK's streaming input: one live
 * conversation, fed a message at a time, ended by `close()`.
 */
export class Inbox implements AsyncIterable<UserMessage> {
  private readonly queued: UserMessage[] = [];
  private waiting: ((result: IteratorResult<UserMessage>) => void) | undefined;
  private closed = false;

  push(content: string): void {
    const message: UserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      this.waiting({ value: message, done: false });
      this.waiting = undefined;
    } else {
      this.queued.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * `carl mentor`: a non-agentic pairing chat. One live session for the whole
 * terminal split, fixed to Haiku on Bedrock, always read-only — the human types
 * the code, the model only answers.
 */
export async function runMentorRepl(workspaceRoot: string): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const inbox = new Inbox();
  const session = query({
    prompt: inbox,
    options: buildQueryOptions({
      workspaceRoot,
      modelId: BEDROCK_MODEL_IDS[MENTOR_MODEL],
      persona: buildSkillPersona("mentor"),
      effort: "low",
      readOnly: true,
    }),
  });
  const replies = session[Symbol.asyncIterator]();

  /** Everything up to this question's result, then the answer or the failure. */
  async function answer(): Promise<string> {
    for (;;) {
      const next = await replies.next();
      if (next.done) return "(session ended)";
      const message = next.value as SdkMessage;
      if (message.type !== "result") continue;
      return message.subtype === "success" && !message.is_error
        ? message.result || "(no response)"
        : describeFailure(message);
    }
  }

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
        inbox.push(
          first
            ? `${openingNote(workspaceRoot)}\n\n---\n\n${question}`
            : question,
        );
        first = false;

        try {
          console.log(await answer());
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
    inbox.close();
    session.close();
  }
}
