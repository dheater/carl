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
  instruction: string;
  excludedTools?: string[];
  effort: EffortLevel;
  onToolCall?: (event: ToolCallEvent) => void;
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
}
