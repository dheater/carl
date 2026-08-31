export type EffortLevel = "low" | "medium" | "high";

export interface ToolCallEvent {
  tool: string;
  inputSummary?: string;
  outputBytes?: number;
  durationMs?: number;
  error: boolean;
}

export interface AgentRunRequest {
  workspaceRoot: string;
  skill: string;
  model: string;
  /**
   * Who the agent is and how it works: carl's rules plus the skill definition.
   * Carried as the deployment persona, which is an order-0 system-prompt
   * section — the reason the rules' `[ABSOLUTE — overrides all]` framing is
   * true rather than aspirational.
   */
  persona: string;
  /** The request and its context: workspace, diff, and the user's prompt. */
  instruction: string;
  effort: EffortLevel;
  /**
   * Reviewing skills must not change the workspace. Enforced by the runtime's
   * sandbox rather than by withholding write tools, so `bash` cannot route
   * around it.
   */
  readOnly: boolean;
  onToolCall?: (event: ToolCallEvent) => void;
  onProgress?: (line: string) => void;
}

/** One model request's usage, as the provider reported it. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageSummary {
  source: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  turns?: number;
  /**
   * The first model request's usage — the cold-start tax.
   *
   * carl starts every run from an empty conversation, so turn 1 pays to
   * establish the whole prefix: persona, workspace context, instruction. A
   * harness that preserved the session across prompts would read most of that
   * from cache instead. The totals cannot separate the two, because a long run
   * writes cache on later turns as well, so the tax is only visible if turn 1 is
   * recorded on its own.
   */
  firstTurn?: TurnUsage;
  /**
   * Billed prompt size per turn — input + cache read + cache write — in request
   * order. The run's context-growth curve, and the counterweight to the tax
   * above: a preserved context starts every curve where the last one ended.
   */
  turnPromptTokens?: number[];
  /**
   * Compactions during the run. Zero on every Bedrock run measured so far, which
   * is itself the finding: one-shot runs do not live long enough to compact.
   */
  compactions?: number;
}

export interface AgentRunResponse {
  text: string;
  usage?: UsageSummary;
}

export class AgentRunError extends Error {
  readonly usage: UsageSummary;

  constructor(message: string, usage: UsageSummary) {
    super(message);
    this.name = "AgentRunError";
    this.usage = usage;
  }
}

/**
 * Attaches rather than wraps so transient-fetch detection keeps working.
 */
export function attachUsage<E>(err: E, usage: UsageSummary): E {
  if (err && typeof err === "object" && !("usage" in err)) {
    (err as { usage?: UsageSummary }).usage = usage;
  }
  return err;
}

export function usageFromError(err: unknown): UsageSummary | undefined {
  if (err instanceof AgentRunError) return err.usage;
  const usage = (err as { usage?: UsageSummary })?.usage;
  if (usage && typeof usage === "object") return usage;
  return undefined;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResponse>;
  /**
   * Where this run's model is served, for the line carl prints before it starts.
   *
   * Optional so a test double stays a runner, but worth having: the model name
   * carl resolved and the route it resolved to are the two facts a run cannot
   * afford to be silent about — a config value read where an override was
   * expected can otherwise cost half an hour on the wrong model.
   */
  describeRoute?(): string;
}
