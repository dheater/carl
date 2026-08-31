import assert from "assert";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentRunError,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentRunner,
  type EffortLevel,
  type ToolCallEvent,
  type UsageSummary,
} from "./types";

/**
 * carl's model aliases mapped to Bedrock catalog ids.
 *
 * Every id must be a catalog id, spelled exactly as pi-ai's installed
 * amazon-bedrock catalog spells it: runtime/cordis.yml declares no `models`
 * list, so the route serves that catalog unchanged and anything else — an
 * inference-profile ARN, for instance — fails the run before its first request
 * with UNKNOWN_MODEL, no matter that Bedrock itself would accept it.
 *
 * The ids are `us.`-prefixed inference profiles because a bare `anthropic.*` id
 * has no on-demand throughput on Bedrock and cannot be invoked at all. The
 * prefix names a cross-region profile, which is priced at the in-region rate
 * with no transfer fee, so routing is free to spread across
 * us-east-1/us-east-2/us-west-2.
 *
 * The table stays in carl rather than deferring to the runtime's catalog because
 * carl prices its own runs, and MODEL_RATES is keyed on these ids.
 */
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  sonnet5: "us.anthropic.claude-sonnet-5",
  "sonnet4.6": "us.anthropic.claude-sonnet-4-6",
  "sonnet4.5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "haiku4.5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  opus5: "us.anthropic.claude-opus-5",
  "opus4.8": "us.anthropic.claude-opus-4-8",
  "opus4.7": "us.anthropic.claude-opus-4-7",
  "opus4.6": "us.anthropic.claude-opus-4-6-v1",
  "opus4.5": "us.anthropic.claude-opus-4-5-20251101-v1:0",
  "opus4.1": "us.anthropic.claude-opus-4-1-20250805-v1:0",
  fable5: "us.anthropic.claude-fable-5",
};

/**
 * carl's three effort levels as pi-ai thinking levels.
 *
 * `low` maps to `minimal`, not `off`, for two reasons. pi-ai translates `off`
 * into *omitting* the reasoning parameter, which leaves the provider's own
 * default in force — for a thinking model that is not "do not think". And
 * `us.anthropic.claude-fable-5` does not offer `off` at all, so naming it would
 * fail that model's runs with UNSUPPORTED_REASONING_EFFORT. `minimal` is offered
 * by every Bedrock Claude model in the catalog and says what carl means.
 */
export const REASONING_EFFORT: Record<EffortLevel, string> = {
  low: "minimal",
  medium: "medium",
  high: "high",
};

const REPO_ROOT = path.join(__dirname, "..");
const RUNTIME_CONFIG = path.join(REPO_ROOT, "runtime", "cordis.yml");
const RUNTIME_BIN = path.join(
  REPO_ROOT,
  "node_modules",
  "@deepseek-ai",
  "dsh-sdk-jsonrpc-demo",
  "lib",
  "bin.js",
);

/** Minimal shapes for the session events carl reads; the wire union is larger. */
type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type WireEvent = {
  type?: string;
  time?: number;
  data?: Record<string, unknown>;
};

/** Collapses whitespace and truncates, so any text fits one terminal line. */
export function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** A one-line stand-in for a tool's arguments, for the tool_call event log. */
export function summarizeArguments(args: unknown, limit = 200): string {
  return oneLine(
    typeof args === "string" ? args : JSON.stringify(args ?? ""),
    limit,
  );
}

/**
 * The label for one Code Mode program.
 *
 * A `run_code` call carries the whole program, which is thousands of characters
 * and truncates to noise, so the model's own `description` is what gets logged.
 * Without it every `run_code` row in the metrics DB — the most frequent tool
 * there is — recorded an empty `input_summary` and could not be mined at all.
 */
export function summarizeProgram(args: unknown): string {
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return "";
    }
  }
  const description = (parsed as { description?: unknown } | null | undefined)
    ?.description;
  return typeof description === "string" ? oneLine(description, 200) : "";
}

/** Longest progress line carl prints; a run_code program is far longer. */
const PROGRESS_LIMIT = 120;

/** The visible text of an assistant message, including reasoning and excluding tool calls. */
function assistantText(message: unknown): string {
  const content = (
    message as { content?: Array<{ type?: string; text?: string }> } | undefined
  )?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || block?.type === "reasoning")
    .map((block) => block.text ?? "")
    .join(" ");
}

/**
 * One progress line for a session event, or undefined for events a watching
 * human gains nothing from.
 *
 * Under Code Mode the model's own calls are all `run_code`, so the sub-dispatch
 * events inside the program are what name the actual work (`read src/a.ts`);
 * the outer `run_code` call would only ever print its own name.
 */
export function formatProgress(event: WireEvent): string | undefined {
  const data = event.data ?? {};

  switch (event.type) {
    case "step/start":
      return "thinking…";
    case "assistant/message": {
      const text = assistantText(data.message);
      return text.trim() ? oneLine(text, PROGRESS_LIMIT) : undefined;
    }
    case "tool/call": {
      const name = String(data.name ?? "tool");
      if (name === "run_code") return undefined;
      return `${name} ${summarizeArguments(data.arguments, PROGRESS_LIMIT)}`;
    }
    case "tool/code-dispatch-start":
      return `${String(data.name ?? "tool")} ${summarizeArguments(data.arguments, PROGRESS_LIMIT)}`;
    case "tool/code-dispatch":
      return data.isError === true
        ? `${String(data.name ?? "tool")} failed`
        : undefined;
    case "llm/retry":
      return `model request failed, retrying (${data.retry ?? "?"}/${data.maxRetries ?? "?"})…`;
    case "compaction/start":
      return "compacting context…";
    default:
      return undefined;
  }
}

function contentBytes(content: unknown): number {
  if (content === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(content), "utf-8");
}

/**
 * Folds one activity interval's events into the usage summary carl records.
 *
 * `turns` counts model requests (`step/end`), which is what the previous
 * Bedrock loop's turn counter measured; the harness's own `turn` is one whole
 * user-message-to-idle interval and would read as 1 for every run.
 */
export function summarizeUsage(
  events: WireEvent[],
  modelId: string,
): UsageSummary {
  const usage: UsageSummary = { source: "dsh-bedrock", modelId, turns: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const event of events) {
    if (event.type === "step/end") usage.turns = (usage.turns ?? 0) + 1;
    if (event.type !== "assistant/message") continue;
    const stepUsage = event.data?.usage as Usage | undefined;
    if (!stepUsage) continue;
    inputTokens += stepUsage.inputTokens ?? 0;
    outputTokens += stepUsage.outputTokens ?? 0;
    cacheReadTokens += stepUsage.cacheReadTokens ?? 0;
    cacheWriteTokens += stepUsage.cacheWriteTokens ?? 0;
  }

  if (inputTokens) usage.inputTokens = inputTokens;
  if (outputTokens) usage.outputTokens = outputTokens;
  if (cacheReadTokens) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens) usage.cacheWriteTokens = cacheWriteTokens;
  return usage;
}

/**
 * Replays tool activity as carl's `tool_call` events.
 *
 * Under Code Mode every model-emitted call is `run_code`, so the outer calls
 * measure model round-trips while the inner `tool/code-dispatch` entries — the
 * `tools.read(...)` calls the program made — measure the work. Both are
 * reported, under their real names, because the ratio between them is the whole
 * point of moving to Code Mode.
 */
export function replayToolCalls(
  events: WireEvent[],
  onToolCall: (event: ToolCallEvent) => void,
): void {
  const startedAt = new Map<string, number>();
  const programLabels = new Map<string, string>();

  for (const event of events) {
    const data = event.data ?? {};

    if (event.type === "tool/call") {
      startedAt.set(String(data.callId), event.time ?? 0);
      programLabels.set(String(data.callId), summarizeProgram(data.arguments));
      continue;
    }

    if (event.type === "tool/code-dispatch-start") {
      startedAt.set(String(data.subCallId), event.time ?? 0);
      continue;
    }

    if (event.type === "tool/code-dispatch") {
      const start = startedAt.get(String(data.subCallId));
      onToolCall({
        tool: String(data.name ?? "unknown"),
        inputSummary: summarizeArguments(data.arguments),
        outputBytes: contentBytes(data.content),
        durationMs: start ? (event.time ?? start) - start : undefined,
        error: data.isError === true,
      });
      continue;
    }

    if (event.type === "tool/result") {
      const message = data.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const result = message?.content?.[0];
      const callId = String(result?.toolCallId ?? "");
      const start = startedAt.get(callId);
      onToolCall({
        tool: "run_code",
        inputSummary: programLabels.get(callId) ?? "",
        outputBytes: contentBytes(result?.content),
        durationMs: start ? (event.time ?? start) - start : undefined,
        error: result?.isError === true,
      });
    }
  }
}

/**
 * The last turn's outcome, or undefined when the interval logged no turn end.
 */
export function finalTurnReason(
  events: WireEvent[],
): { kind?: string; error?: { message?: string; code?: string } } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "turn/end") continue;
    return events[i].data?.reason as
      | { kind?: string; error?: { message?: string; code?: string } }
      | undefined;
  }
  return undefined;
}

/**
 * Mirrors dsh-session-persistence-jsonl's `encodeSegment`. Translates a raw
 * string into a single filesystem-safe path segment; the only unsafe character
 * in a standard UUID is nothing — all hex digits and `-` are safe — so for
 * session ids generated by `randomUUID()` this is an identity transform.
 */
function encodeSegment(raw: string): string {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/**
 * Mirrors dsh-session-persistence-jsonl's `projectKey`. Converts a workspace
 * path to the human-readable directory name the persistence layer uses as the
 * per-project namespace under the session root.
 */
function projectKey(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      const code = cwd.charCodeAt(i);
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * The on-disk path the persistence layer assigns to one session.
 * Exported for tests; not part of the public AgentRunner contract.
 */
export function sessionDirPath(
  sessionRoot: string,
  workspaceRoot: string,
  sessionId: string,
): string {
  return path.join(
    sessionRoot,
    projectKey(workspaceRoot),
    encodeSegment(sessionId),
  );
}

/**
 * Runs one skill as one turn of a DeepSeek Harness runtime.
 *
 * The runtime is a subprocess composed by `runtime/cordis.yml` and driven over
 * stdio JSON-RPC. One subprocess per run: every per-run choice that the harness
 * treats as deployment configuration — the persona, the sandbox mode, the
 * reasoning effort — is process-wide, and a fresh process is a cheaper way to
 * vary them than a reload would be.
 */
export class DshRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const {
      workspaceRoot,
      model,
      instruction,
      persona,
      effort,
      readOnly,
      onToolCall,
      onProgress,
    } = request;

    const modelId = BEDROCK_MODEL_IDS[model];
    assert(
      modelId,
      `DshRunner.run: unknown model alias "${model}" — validate in createRunner before constructing DshRunner`,
    );

    const started = Date.now();

    // Imported dynamically because the SDK is ESM-only while this source tree
    // compiles as CommonJS for jest and tsc; the shipped bundle is ESM either
    // way. Nothing here is exercised by the unit tests, so the pure helpers
    // below stay importable without pulling the SDK in.
    const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");

    // os.tmpdir() is the right place: sessions are always deleted after the
    // run, so the config dir adds no value and the OS owns cleanup on failure.
    const sessionRoot = path.join(os.tmpdir(), "carl-sessions");
    // Pre-generate the session id so the cleanup path is known even if the run
    // throws before returning a result.
    const sessionId = randomUUID();

    // try/finally rather than `await using`: the syntax needs Node 24, and carl
    // is a CLI people install on whatever Node they have. `close()` is the same
    // teardown the disposer calls.
    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [RUNTIME_BIN, RUNTIME_CONFIG],
        cwd: workspaceRoot,
        env: {
          ...process.env,
          CARL_PERSONA: persona,
          CARL_CWD: workspaceRoot,
          CARL_SANDBOX_MODE: readOnly ? "read-only" : "workspace-write",
          CARL_REASONING: REASONING_EFFORT[effort],
          CARL_SESSION_ROOT: sessionRoot,
        },
      },
      cwd: workspaceRoot,
      provider: "amazon-bedrock",
      model: modelId,
    });

    try {
      // The notification stream is the only in-flight view of the run: the
      // returned events arrive minutes later, all at once.
      const result = await harness.run(instruction, {
        sessionId,
        onNotification: onProgress
          ? (notification) => {
              if (notification.method !== "session.event") return;
              if (notification.params.sessionId !== sessionId) return;
              const line = formatProgress(
                notification.params.event as WireEvent,
              );
              if (line) onProgress(line);
            }
          : undefined,
      });
      const events: WireEvent[] = Array.isArray(result.events)
        ? (result.events as WireEvent[])
        : [];

      const usage = summarizeUsage(events, modelId);
      usage.latencyMs = Date.now() - started;

      if (onToolCall) replayToolCalls(events, onToolCall);

      const reason = finalTurnReason(events);
      if (reason && reason.kind !== "completed") {
        throw new AgentRunError(describeFailure(reason), usage);
      }

      return { text: result.finalResponse, usage };
    } finally {
      await harness.close();
      // Delete the session directory the runtime created. Session transcripts
      // are the harness's internal replay state, not data the user or carl
      // needs after the run; they accumulate indefinitely otherwise.
      try {
        fs.rmSync(sessionDirPath(sessionRoot, workspaceRoot, sessionId), {
          recursive: true,
          force: true,
        });
      } catch {
        // Best-effort: a missing directory or a permission error must not
        // fail the run.
      }
    }
  }
}

export function describeFailure(reason: {
  kind?: string;
  error?: { message?: string; code?: string };
}): string {
  if (reason.kind === "max-tokens") {
    return "The model hit its output token limit before finishing the skill.";
  }
  const detail = reason.error?.message;
  const code = reason.error?.code;
  const suffix = detail ? `: ${detail}` : "";
  return `The agent turn ended as ${reason.kind ?? "unknown"}${code ? ` (${code})` : ""}${suffix}`;
}
