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

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResponse>;
}
