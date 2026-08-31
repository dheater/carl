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
 * Where carl looks for a locally hosted model. Any server answering OpenAI's
 * `GET /models` and chat-completions will do; the default is the address mtplx
 * serves on.
 */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:8000/v1";

/** How long carl waits for the local server before deciding there isn't one. */
const LOCAL_DISCOVERY_TIMEOUT_MS = 1500;

export function localBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARL_LOCAL_BASE_URL?.trim() || DEFAULT_LOCAL_BASE_URL;
}

/**
 * One model a local server says it can serve. The capacities are optional
 * because most listings disclose an id and nothing else.
 */
export type LocalModel = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
};

/** Which route serves this run, and everything that route needs to be built. */
export type ModelRoute =
  | { provider: "amazon-bedrock"; modelId: string }
  | { provider: "local"; baseURL: string; model: LocalModel };

function firstNumber(entry: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = (entry as Record<string, unknown>)?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The models in an OpenAI `GET /models` body.
 *
 * The capacity keys are the several spellings servers actually use — mtplx
 * reports `context_length` and `max_model_len`, vLLM `max_model_len`, others
 * `context_window` — and an entry with no usable id is skipped rather than
 * failing the whole listing, since one odd row must not hide the model carl was
 * asked for.
 */
export function parseLocalModels(body: unknown): LocalModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: LocalModel[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id.trim()) continue;
    const contextWindow = firstNumber(entry, [
      "context_window",
      "context_length",
      "max_model_len",
    ]);
    const maxTokens = firstNumber(entry, ["max_output_tokens", "max_tokens"]);
    models.push({
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return models;
}

/**
 * What the local server can serve, or `[]` when there is nothing to ask.
 *
 * No local server is the ordinary case rather than an error: carl falls back to
 * Bedrock, so a refused connection, a timeout, an error status, and a body carl
 * cannot read all answer "nothing local" instead of failing the run before it
 * starts. The timeout is short because every run pays it.
 */
export async function listLocalModels(
  baseURL: string,
  timeoutMs = LOCAL_DISCOVERY_TIMEOUT_MS,
): Promise<LocalModel[]> {
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    return parseLocalModels(await response.json());
  } catch {
    return [];
  }
}

/**
 * A model name reduced to what identifies the model.
 *
 * The same model wears three spellings: carl's config says `qwen38-27b`, mtplx's
 * cache says `Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed`, and its server says
 * `mtplx-qwen38-27b-optimized-speed`. Dropping case and everything that is not a
 * letter or digit makes the config name a substring of both, so one name can
 * select a model to start (see src/mtplx.ts) and then recognize what the server
 * ended up serving.
 */
export function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a configured name names this model id.
 *
 * Every part of the name has to appear in the id, in any order and through any
 * punctuation. Order has to be free because the two spellings disagree about it:
 * mtplx's cache says `Qwen3.5-9B-MTPLX-Optimized-Speed` and its server says
 * `mtplx-qwen35-9b-optimized-speed`, so requiring one substring would let a
 * config naming either one fail to find the other.
 *
 * An empty name matches everything, so callers refuse it before asking.
 */
export function matchesModelName(name: string, id: string): boolean {
  const candidate = normalizeModelName(id);
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .every((part) => candidate.includes(normalizeModelName(part)));
}

/**
 * The locally served model a configured name asks for, or undefined for none.
 *
 * A local server names its models whatever it likes — mtplx serves
 * `mtplx-qwen38-27b-optimized-speed` — so an exact id is accepted but not
 * required: a name whose parts the id all carry resolves, which is what lets
 * `"code": "qwen38-27b"` in config.json keep working when the server renames
 * around the part that identifies the model. A name matching several models is
 * refused rather than resolved arbitrarily, because silently picking the wrong
 * one changes what ran without changing what the config says.
 */
export function resolveLocalModel(
  name: string,
  served: LocalModel[],
): LocalModel | undefined {
  const wanted = normalizeModelName(name);
  if (!wanted) return undefined;

  const exact = served.find((model) => normalizeModelName(model.id) === wanted);
  if (exact) return exact;

  const partial = served.filter((model) => matchesModelName(name, model.id));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Model "${name}" matches more than one model on the local server:\n` +
        partial.map((model) => `  - ${model.id}`).join("\n") +
        `\nName the one you want exactly.`,
    );
  }
  return undefined;
}

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
 * A `run_code` call prints nothing itself: the sub-dispatch events inside the
 * program are what name the actual work (`read src/a.ts`), and the outer call
 * would only ever print its own name. A direct tool call has no inner events, so
 * it prints itself — under `both` the two paths interleave and a watching human
 * sees the same line either way.
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

/** The billed prompt for one request: everything that is not output. */
function promptTokens(turn: Usage): number {
  return (
    (turn.inputTokens ?? 0) +
    (turn.cacheReadTokens ?? 0) +
    (turn.cacheWriteTokens ?? 0)
  );
}

/**
 * Folds one activity interval's events into the usage summary carl records.
 *
 * `turns` counts model requests (`step/end`), which is what the previous
 * Bedrock loop's turn counter measured; the harness's own `turn` is one whole
 * user-message-to-idle interval and would read as 1 for every run.
 *
 * The totals are what the run cost; the per-turn fields are what carl's one
 * prompt per subprocess costs. Both are folded here because this is the only
 * place the per-request wire events still exist — the runner discards them as
 * soon as it returns, and `compaction/start` had no reader at all.
 */
export function summarizeUsage(
  events: WireEvent[],
  modelId: string,
  source = "dsh-bedrock",
): UsageSummary {
  const usage: UsageSummary = { source, modelId, turns: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let compactions = 0;
  const turnPromptTokens: number[] = [];

  for (const event of events) {
    if (event.type === "step/end") usage.turns = (usage.turns ?? 0) + 1;
    if (event.type === "compaction/start") compactions += 1;
    if (event.type !== "assistant/message") continue;
    const stepUsage = event.data?.usage as Usage | undefined;
    if (!stepUsage) continue;
    inputTokens += stepUsage.inputTokens ?? 0;
    outputTokens += stepUsage.outputTokens ?? 0;
    cacheReadTokens += stepUsage.cacheReadTokens ?? 0;
    cacheWriteTokens += stepUsage.cacheWriteTokens ?? 0;
    // Recorded in request order, so index 0 is the cold start and the last entry
    // is the largest context the run ever paid to send.
    turnPromptTokens.push(promptTokens(stepUsage));
    if (usage.firstTurn === undefined) {
      usage.firstTurn = {
        ...(stepUsage.inputTokens && { inputTokens: stepUsage.inputTokens }),
        ...(stepUsage.outputTokens && { outputTokens: stepUsage.outputTokens }),
        ...(stepUsage.cacheReadTokens && {
          cacheReadTokens: stepUsage.cacheReadTokens,
        }),
        ...(stepUsage.cacheWriteTokens && {
          cacheWriteTokens: stepUsage.cacheWriteTokens,
        }),
      };
    }
  }

  if (inputTokens) usage.inputTokens = inputTokens;
  if (outputTokens) usage.outputTokens = outputTokens;
  if (cacheReadTokens) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens) usage.cacheWriteTokens = cacheWriteTokens;
  if (turnPromptTokens.length > 0) usage.turnPromptTokens = turnPromptTokens;
  // Always recorded, including as 0: "this run did not compact" is the
  // measurement, and an absent field would read as "not measured".
  usage.compactions = compactions;
  return usage;
}

/**
 * Replays tool activity as carl's `tool_call` events.
 *
 * A model-emitted call measures one model round-trip; a `tool/code-dispatch`
 * entry — the `tools.read(...)` call a program made — measures the work. Both
 * are reported, under their real names, because the ratio between them is what
 * says whether Code Mode is earning the program it costs.
 *
 * Under `both` the model emits `run_code` and plain tool calls side by side, so
 * the outer name comes from the call rather than being assumed: recording a
 * direct `read` as `run_code` would put the two layers in one bucket and make
 * exactly that ratio unmeasurable.
 */
export function replayToolCalls(
  events: WireEvent[],
  onToolCall: (event: ToolCallEvent) => void,
): void {
  const startedAt = new Map<string, number>();
  const calls = new Map<string, { tool: string; inputSummary: string }>();

  for (const event of events) {
    const data = event.data ?? {};

    if (event.type === "tool/call") {
      const callId = String(data.callId);
      const tool = String(data.name ?? "unknown");
      startedAt.set(callId, event.time ?? 0);
      calls.set(callId, {
        tool,
        // A program body is thousands of characters and truncates to noise, so
        // run_code logs the model's own description instead. Every other tool's
        // arguments are the summary.
        inputSummary:
          tool === "run_code"
            ? summarizeProgram(data.arguments)
            : summarizeArguments(data.arguments),
      });
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
      // A resumed or compacted interval can carry a settle whose call landed in
      // an earlier one; naming it "unknown" keeps it out of another tool's row.
      const call = calls.get(callId);
      onToolCall({
        tool: call?.tool ?? "unknown",
        inputSummary: call?.inputSummary ?? "",
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
 * Fallback capacities for a local model whose server discloses none. pi-ai's own
 * route defaults (256K context, 32K output) are sized for a hosted frontier
 * model and would let carl send a request a small local model cannot hold, so
 * carl guesses low instead: an undersized window truncates context, an oversized
 * one fails the request.
 */
const LOCAL_FALLBACK_CONTEXT_WINDOW = 32768;
const LOCAL_FALLBACK_MAX_TOKENS = 8192;

/**
 * What carl sends as the local server's bearer token when nothing else is set.
 * A self-hosted server on loopback normally ignores the header, but pi-ai
 * refuses to send a request with no credential at all, so this stands in.
 */
const LOCAL_PLACEHOLDER_API_KEY = "local";

/**
 * The local route's shape, as environment variables runtime/cordis.yml reads.
 *
 * The route is declared there unconditionally, because a hand-declared pi-ai
 * route with an empty `models` list fails resolution for the whole namespace and
 * would take Bedrock down with it on any machine running no local server. So a
 * Bedrock run leaves these unset and the route resolves to a placeholder model
 * nothing ever addresses; see the comment on that entry.
 */
function localRouteEnv(route: ModelRoute): NodeJS.ProcessEnv {
  if (route.provider !== "local") return {};
  return {
    CARL_LOCAL_BASE_URL: route.baseURL,
    CARL_LOCAL_API_KEY:
      process.env.CARL_LOCAL_API_KEY?.trim() || LOCAL_PLACEHOLDER_API_KEY,
    CARL_LOCAL_MODEL_ID: route.model.id,
    CARL_LOCAL_CONTEXT_WINDOW: String(
      route.model.contextWindow ?? LOCAL_FALLBACK_CONTEXT_WINDOW,
    ),
    CARL_LOCAL_MAX_TOKENS: String(
      route.model.maxTokens ?? LOCAL_FALLBACK_MAX_TOKENS,
    ),
  };
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
  constructor(private readonly route: ModelRoute) {
    assert(
      route?.provider,
      "DshRunner: a resolved ModelRoute is required — resolve it in createRunner",
    );
  }

  /** The route as a human reads it: where the model is, and which model it is. */
  describeRoute(): string {
    return this.route.provider === "amazon-bedrock"
      ? `Bedrock (${this.route.modelId})`
      : `${this.route.baseURL} (${this.route.model.id})`;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const {
      workspaceRoot,
      instruction,
      persona,
      effort,
      readOnly,
      onToolCall,
      onProgress,
    } = request;

    const route = this.route;
    const modelId =
      route.provider === "amazon-bedrock" ? route.modelId : route.model.id;

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
          ...localRouteEnv(route),
        },
      },
      cwd: workspaceRoot,
      provider: route.provider,
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

      // `dsh-bedrock` is kept verbatim so a run recorded today still groups with
      // the ones already in events.jsonl.
      const usage = summarizeUsage(
        events,
        modelId,
        route.provider === "amazon-bedrock" ? "dsh-bedrock" : "dsh-local",
      );
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
