import {
  BedrockRuntimeClient,
  ConverseCommand,
  Tool,
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Using US region inference profiles for lower latency.
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  "sonnet4.6": "us.anthropic.claude-sonnet-4-6",
  "sonnet4.5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  sonnet4: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  "haiku4.5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "opus4.8": "us.anthropic.claude-opus-4-8",
  "opus4.7": "us.anthropic.claude-opus-4-7",
  "opus4.6": "us.anthropic.claude-opus-4-6-v1",
  "opus4.5": "us.anthropic.claude-opus-4-5-20251101-v1:0",
  "opus4.1": "us.anthropic.claude-opus-4-1-20250805-v1:0",
  fable5: "us.anthropic.claude-fable-5",
};

// Models not listed here will have estimatedCostUsd omitted from usage.
const BEDROCK_PRICING: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number }
> = {
  "sonnet4.6": { inputPerMillion: 3.6, outputPerMillion: 18.0 },
  "sonnet4.5": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  sonnet4: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "haiku4.5": { inputPerMillion: 1.2, outputPerMillion: 6.0 },
  "opus4.7": { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  "opus4.6": { inputPerMillion: 6.0, outputPerMillion: 30.0 },
  "opus4.5": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "opus4.1": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
};

export interface AgentRunRequest {
  workspaceRoot: string;
  skill: string;
  model: string;
  instruction: string;
  excludedTools?: string[];
}

export interface AgentRunResponse {
  text: string;
  usage?: Record<string, unknown>;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResponse>;
}

export class AuggieRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const { Auggie } = await import("@augmentcode/auggie-sdk");
    const { workspaceRoot, skill, model, instruction, excludedTools } = request;

    console.log(`  [System] Initializing agent...`);
    const client = await Auggie.create({
      workspaceRoot,
      model: model as any,
      allowIndexing: true,
      excludedTools: excludedTools ?? [],
    });

    client.onSessionUpdate((notification: any) => {
      const update = notification.update;
      if (!update) return;
      if (update.sessionUpdate === "tool_call") {
        console.log(
          `\n  [${skill}/${model}] Running tool: ${update.title || "unknown"}...`,
        );
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        if (update.content?.text) {
          process.stdout.write(`\x1b[90m${update.content.text}\x1b[0m`);
        }
      }
    });

    try {
      const raw: any = await client.prompt(instruction, { isAnswerOnly: true });
      if (typeof raw === "string") {
        return { text: raw };
      }
      return {
        text: raw.text,
        usage: raw.usage ? { source: "auggie", ...raw.usage } : undefined,
      };
    } finally {
      try {
        await client.close();
      } catch {}
    }
  }
}

const BEDROCK_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "bash",
      description:
        "Execute a bash command in the workspace directory. Returns stdout/stderr.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The bash command to execute",
            },
          },
          required: ["command"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "read_file",
      description: "Read the contents of a file from the workspace.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file from workspace root",
            },
          },
          required: ["path"],
        },
      },
    },
  },
];

export class BedrockRunner implements AgentRunner {
  private readonly client: BedrockRuntimeClient;

  constructor(region: string) {
    this.client = new BedrockRuntimeClient({ region });
  }

  private executeTool(
    toolName: string,
    toolInput: any,
    workspaceRoot: string,
    skill: string,
    model: string,
  ): string {
    const toolDetail =
      toolName === "bash"
        ? (toolInput.command ?? "")
        : toolName === "read_file"
          ? (toolInput.path ?? "")
          : "";
    console.log(
      `\n  [${skill}/${model}] Running tool: ${toolName}${toolDetail ? `: ${toolDetail}` : ""}...`,
    );

    try {
      if (toolName === "bash") {
        const { command } = toolInput;
        const result = execSync(command, {
          cwd: workspaceRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB
          timeout: 30000, // 30s
        });
        return result;
      } else if (toolName === "read_file") {
        const { path: filePath } = toolInput;
        const fullPath = path.join(workspaceRoot, filePath);
        const content = fs.readFileSync(fullPath, "utf-8");
        return content;
      }
      return `Unknown tool: ${toolName}`;
    } catch (err: any) {
      return `Error executing ${toolName}: ${err.message}`;
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const { workspaceRoot, skill, model, instruction, excludedTools } = request;
    const modelId = BEDROCK_MODEL_IDS[model] ?? model;

    const start = Date.now();
    const pricing = BEDROCK_PRICING[model];

    let messages: Message[] = [
      { role: "user", content: [{ text: instruction }] },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const maxTurns = 50;

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.client.send(
        new ConverseCommand({
          modelId,
          messages,
          toolConfig: {
            tools: excludedTools?.length
              ? BEDROCK_TOOLS.filter(
                  (t) => !excludedTools.includes(t.toolSpec?.name ?? ""),
                )
              : BEDROCK_TOOLS,
          },
        }),
      );

      totalInputTokens += response.usage?.inputTokens ?? 0;
      totalOutputTokens += response.usage?.outputTokens ?? 0;

      const stopReason = response.stopReason;
      const assistantContent = response.output?.message?.content ?? [];

      messages.push({
        role: "assistant",
        content: assistantContent,
      });

      if (stopReason === "end_turn") {
        const text = assistantContent
          .filter((block): block is { text: string } => "text" in block)
          .map((block) => block.text)
          .join("");

        const estimatedCostUsd = pricing
          ? (totalInputTokens / 1_000_000) * pricing.inputPerMillion +
            (totalOutputTokens / 1_000_000) * pricing.outputPerMillion
          : undefined;

        return {
          text,
          usage: {
            source: "bedrock",
            modelId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            estimatedCostUsd,
            latencyMs: Date.now() - start,
            turns: turn + 1,
          },
        };
      } else if (stopReason === "tool_use") {
        const toolResults: ContentBlock[] = [];

        for (const block of assistantContent) {
          if ("toolUse" in block) {
            const toolUse = block.toolUse as ToolUseBlock;
            const toolName = toolUse.name ?? "unknown";
            const toolInput = toolUse.input ?? {};
            const toolUseId = toolUse.toolUseId ?? "";

            const result = this.executeTool(
              toolName,
              toolInput,
              workspaceRoot,
              skill,
              model,
            );

            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: result }],
              } as ToolResultBlock,
            });
          }
        }

        messages.push({
          role: "user",
          content: toolResults,
        });
      } else {
        throw new Error(`Unexpected stop reason: ${stopReason}`);
      }
    }

    throw new Error(`Exceeded maximum conversation turns (${maxTurns})`);
  }
}
