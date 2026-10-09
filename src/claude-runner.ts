import assert from "assert";
import type { Options } from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};
import {
  AgentRunError,
  attachUsage,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentRunner,
  type EffortLevel,
  type ToolCallEvent,
  type TurnUsage,
  type UsageSummary,
} from "./types";

/**
 * carl's model aliases mapped to Bedrock catalog ids.
 *
 * The ids are `us.`-prefixed inference profiles because a bare `anthropic.*` id
 * has no on-demand throughput on Bedrock and cannot be invoked at all. The
 * prefix names a cross-region profile, which is priced at the in-region rate
 * with no transfer fee, so routing is free to spread across
 * us-east-1/us-east-2/us-west-2.
 *
 * The table stays in carl because carl prices its own runs, and MODEL_RATES is
 * keyed on these ids.
 */
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  "sonnet5.5": "us.anthropic.claude-sonnet-5-5",
  "haiku5.5": "us.anthropic.claude-haiku-5-5",
  "opus5.5": "us.anthropic.claude-opus-5-5",
};

/** The source every run records. Runs in older logs carry `dsh-bedrock`. */
export const USAGE_SOURCE = "claude-bedrock";

/** Per-run limits, so one runaway run cannot spend a week's budget. */
export const MAX_TURNS = 80;
export const MAX_BUDGET_USD = 10;

/** The tools a skill may call. Everything else Claude Code ships stays off. */
const READ_TOOLS = ["Read", "Glob", "Grep", "Bash"];
const WRITE_TOOLS = [...READ_TOOLS, "Edit", "Write"];

/**
 * The Agent SDK options for one carl run.
 *
 * - `systemPrompt` is carl's persona and nothing else, so Claude Code's own
 *   prompt does not sit ahead of the rules' `[ABSOLUTE — overrides all]` block.
 * - `settingSources: []` keeps the user's `~/.claude` settings, hooks, and
 *   CLAUDE.md out of the run: carl composes its own workspace context.
 * - `includeGitInstructions: false` drops Claude Code's commit and PR workflow
 *   text from every run's prompt. carl's git policy forbids both, so the text
 *   only cost tokens on every turn.
 * - `persistSession: false` because the human, not a transcript, carries state
 *   from one run to the next.
 * - `dontAsk` because nothing can answer a prompt mid-run. The tool list and
 *   the sandbox bound the run instead; carl's approval is the editor.
 * - Read-only skills get no write tools, and the OS sandbox refuses workspace
 *   writes from `bash`, so `tee` cannot route around the missing `write`.
 *   `failIfUnavailable` because a read-only contract the OS does not enforce is
 *   a suggestion.
 * - `maxTurns` and `maxBudgetUsd` stop a runaway run before it spends a week's
 *   budget.
 */
export function buildQueryOptions(opts: {
  workspaceRoot: string;
  modelId: string;
  persona: string;
  effort: EffortLevel;
  readOnly: boolean;
}): Options {
  const { workspaceRoot, modelId, persona, effort, readOnly } = opts;
  const tools = readOnly ? READ_TOOLS : WRITE_TOOLS;
  return {
    cwd: workspaceRoot,
    model: modelId,
    systemPrompt: persona,
    settingSources: [],
    settings: { includeGitInstructions: false },
    persistSession: false,
    tools,
    allowedTools: tools,
    permissionMode: "dontAsk",
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    ...(effort === "default" ? {} : { effort }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      ...(readOnly ? { filesystem: { denyWrite: [workspaceRoot] } } : {}),
    },
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",
      // Every model is invoked through a us-east-1 inference profile.
      AWS_REGION: "us-east-1",
      // Claude Code's background requests default to a model id Bedrock does
      // not serve; point them at the Haiku profile carl already uses.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_MODEL_IDS["haiku5.5"],
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}

/** Minimal shapes for the SDK messages carl reads; the SDK union is larger. */
type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type MessageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type SdkMessage = {
  type?: string;
  subtype?: string;
  message?: {
    id?: string;
    content?: string | ContentBlock[];
    usage?: MessageUsage;
  };
  attempt?: number;
  max_retries?: number;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  modelUsage?: Record<string, ModelUsage>;
};

/** Collapses whitespace and truncates, so any text fits one terminal line. */
export function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** A one-line stand-in for a tool's arguments, for the tool_call event log. */
function summarizeArguments(args: unknown, limit = 200): string {
  return oneLine(
    typeof args === "string" ? args : JSON.stringify(args ?? ""),
    limit,
  );
}

/** Longest progress line carl prints. */
const PROGRESS_LIMIT = 120;

function blocks(message: SdkMessage): ContentBlock[] {
  const content = message.message?.content;
  return Array.isArray(content) ? content : [];
}

function contentBytes(content: unknown): number {
  if (content === undefined) return 0;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return Buffer.byteLength(text, "utf-8");
}

/** Text of a failed result, one line, capped. */
function errorText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: ContentBlock) =>
              typeof block?.text === "string" ? block.text : "",
            )
            .join(" ")
        : "";
  return text.trim().length > 0 ? oneLine(text, 200) : undefined;
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function promptTokens(turn: TurnUsage): number {
  return (
    (turn.inputTokens ?? 0) +
    (turn.cacheReadTokens ?? 0) +
    (turn.cacheWriteTokens ?? 0)
  );
}

/**
 * Folds one run's SDK message stream into what carl records: progress lines as
 * they happen, tool calls as they settle, and the usage summary at the end.
 */
export class RunRecorder {
  private readonly pending = new Map<
    string,
    { tool: string; inputSummary: string; startedAt: number }
  >();
  /** Per model request, in request order, keyed by message id. */
  private readonly requests = new Map<string, TurnUsage>();
  private compactions = 0;
  private result: SdkMessage | undefined;

  constructor(
    private readonly modelId: string,
    private readonly onProgress?: (line: string) => void,
    private readonly onToolCall?: (event: ToolCallEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.onProgress?.("thinking…");
  }

  record(message: SdkMessage): void {
    switch (message.type) {
      case "assistant":
        this.recordAssistant(message);
        return;
      case "user":
        this.recordToolResults(message);
        return;
      case "result":
        this.result = message;
        return;
      case "system":
        if (message.subtype === "api_retry") {
          this.onProgress?.(
            `model request failed, retrying (${message.attempt ?? "?"}/${message.max_retries ?? "?"})…`,
          );
        } else if (message.subtype === "compact_boundary") {
          this.compactions += 1;
          this.onProgress?.("compacted context");
        }
        return;
    }
  }

  private recordAssistant(message: SdkMessage): void {
    const id = message.message?.id;
    const usage = message.message?.usage;
    // The SDK emits one message per content block, all sharing the request's
    // id. Input and cache counts are final on the first; output is not, which
    // is why the run's totals come from the result's modelUsage instead.
    if (id && usage) {
      this.requests.set(id, {
        ...(usage.input_tokens && { inputTokens: usage.input_tokens }),
        ...(usage.output_tokens && { outputTokens: usage.output_tokens }),
        ...(usage.cache_read_input_tokens && {
          cacheReadTokens: usage.cache_read_input_tokens,
        }),
        ...(usage.cache_creation_input_tokens && {
          cacheWriteTokens: usage.cache_creation_input_tokens,
        }),
      });
    }

    for (const block of blocks(message)) {
      if (block.type === "text" && block.text?.trim()) {
        this.onProgress?.(oneLine(block.text, PROGRESS_LIMIT));
      } else if (block.type === "tool_use" && block.id) {
        // The log, `carl stats`, and the mutation gate key on lowercase names.
        const tool = (block.name ?? "unknown").toLowerCase();
        this.pending.set(block.id, {
          tool,
          inputSummary: summarizeArguments(block.input),
          startedAt: this.now(),
        });
        this.onProgress?.(
          `${tool} ${summarizeArguments(block.input, PROGRESS_LIMIT)}`,
        );
      }
    }
  }

  private recordToolResults(message: SdkMessage): void {
    let settled = false;
    for (const block of blocks(message)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const call = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      settled = true;
      const error = block.is_error === true;
      const tool = call?.tool ?? "unknown";
      if (error) this.onProgress?.(`${tool} failed`);
      this.onToolCall?.({
        tool,
        inputSummary: call?.inputSummary ?? "",
        outputBytes: contentBytes(block.content),
        durationMs: call ? this.now() - call.startedAt : undefined,
        error,
        errorMessage: error ? errorText(block.content) : undefined,
      });
    }
    // The next model request starts once every call it is waiting on settles.
    if (settled && this.pending.size === 0) this.onProgress?.("thinking…");
  }

  usage(latencyMs?: number): UsageSummary {
    const usage: UsageSummary = {
      source: USAGE_SOURCE,
      modelId: this.modelId,
      turns: this.requests.size,
    };
    const turns = [...this.requests.values()];
    // A stream that threw has no result, so the per-request counts are the only
    // record of what the run spent. Their output counts may run low.
    const modelUsage = this.result?.modelUsage;
    const totals: TurnUsage[] = modelUsage
      ? Object.values(modelUsage).map((m) => ({
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheReadTokens: m.cacheReadInputTokens,
          cacheWriteTokens: m.cacheCreationInputTokens,
        }))
      : turns;
    const inputTokens = sum(totals.map((m) => m.inputTokens));
    const outputTokens = sum(totals.map((m) => m.outputTokens));
    const cacheReadTokens = sum(totals.map((m) => m.cacheReadTokens));
    const cacheWriteTokens = sum(totals.map((m) => m.cacheWriteTokens));
    if (inputTokens) usage.inputTokens = inputTokens;
    if (outputTokens) usage.outputTokens = outputTokens;
    if (cacheReadTokens) usage.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens) usage.cacheWriteTokens = cacheWriteTokens;
    if (turns.length > 0) {
      usage.firstTurn = turns[0];
      usage.turnPromptTokens = turns.map(promptTokens);
    }
    // Always recorded, including as 0: "this run did not compact" is the
    // measurement, and an absent field would read as "not measured".
    usage.compactions = this.compactions;
    if (latencyMs !== undefined) usage.latencyMs = latencyMs;
    return usage;
  }

  /** The final answer, or a failure that names why the run ended without one. */
  outcome(): { text: string } | { failure: string } {
    const result = this.result;
    if (!result) return { failure: "The agent ended without a result." };
    if (result.subtype === "success" && !result.is_error) {
      return { text: result.result ?? "" };
    }
    return { failure: describeFailure(result) };
  }
}

export function describeFailure(result: SdkMessage): string {
  if (result.subtype === "error_max_turns") {
    return `The agent hit its ${MAX_TURNS}-turn limit before finishing the skill. Split the request into smaller steps and re-run.`;
  }
  if (result.subtype === "error_max_budget_usd") {
    return `The agent hit its $${MAX_BUDGET_USD} spend limit before finishing the skill. Split the request into smaller steps and re-run.`;
  }
  const reason = result.terminal_reason ?? result.subtype ?? "unknown";
  const detail =
    result.errors?.filter(Boolean).join("; ") ||
    (result.is_error ? result.result : undefined);
  return `The agent turn ended as ${reason}${detail ? `: ${oneLine(detail, 500)}` : ""}`;
}

/**
 * Runs one skill as one Claude Agent SDK query against Bedrock.
 *
 * One query per run, with no session saved: the persona, the tool set, and the
 * sandbox are all per-run choices, and the next run starts from what the human
 * hands it rather than from this one's transcript.
 */
export class ClaudeRunner implements AgentRunner {
  constructor(private readonly modelId: string) {
    assert(modelId, "ClaudeRunner: a Bedrock model id is required");
  }

  describeRoute(): string {
    return `Bedrock (${this.modelId})`;
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

    const started = Date.now();
    // Imported dynamically because the SDK is ESM-only while this source tree
    // compiles as CommonJS for jest and tsc; the shipped bundle is ESM either
    // way.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const recorder = new RunRecorder(this.modelId, onProgress, onToolCall);
    recorder.start();
    try {
      for await (const message of query({
        prompt: instruction,
        options: buildQueryOptions({
          workspaceRoot,
          modelId: this.modelId,
          persona,
          effort,
          readOnly,
        }),
      })) {
        recorder.record(message as SdkMessage);
      }
    } catch (err) {
      throw attachUsage(err, recorder.usage(Date.now() - started));
    }

    const usage = recorder.usage(Date.now() - started);
    const outcome = recorder.outcome();
    if ("failure" in outcome) throw new AgentRunError(outcome.failure, usage);
    return { text: outcome.text, usage };
  }
}
