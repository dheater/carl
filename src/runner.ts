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

// Patterns that enumerate all files without meaningful filtering.
// Blocked at execution time — use list_files instead.
const RECURSIVE_LIST_PATTERN =
  /(?:^|\s)(?:find\s+\.\/?\s+-type\s+f(?!\s+-name\b)(?!\s+-path\b)|find\s+\.\/?\s+-maxdepth\s+\d+\s+-type\s+f(?!\s+-name\b)(?!\s+-path\b)|ls\s+-[a-zA-Z]*R[a-zA-Z]*(?:\s+\.\s*)?)$/;

export const BLOCKED_COMMAND_ERROR =
  "Error: unfiltered recursive file listing is blocked. Use the list_files tool instead.";

export function isBlockedBashCommand(command: string): boolean {
  return RECURSIVE_LIST_PATTERN.test(command.trim());
}

export const BEDROCK_TOOLS: Tool[] = [
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
  {
    toolSpec: {
      name: "write_file",
      description:
        "Write content to a file in the workspace, creating it (and any parent directories) if it does not exist, or overwriting it if it does.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file from workspace root",
            },
            content: {
              type: "string",
              description: "The full content to write to the file",
            },
          },
          required: ["path", "content"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "str_replace",
      description:
        "Replace the first occurrence of an exact string in a file. The old_str must match the file content exactly, including whitespace and indentation.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file from workspace root",
            },
            old_str: {
              type: "string",
              description: "The exact string to find and replace",
            },
            new_str: {
              type: "string",
              description: "The string to replace it with",
            },
          },
          required: ["path", "old_str", "new_str"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "create_directory",
      description:
        "Create a directory (and any missing parent directories) in the workspace.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Relative path to the directory to create from workspace root",
            },
          },
          required: ["path"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "list_files",
      description:
        "List files in a directory of the workspace, optionally filtered by glob pattern. Excludes node_modules, .git, and dist by default. Use this instead of `find` or `ls -R`.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              description:
                "Directory to list, relative to workspace root. Defaults to '.' (workspace root).",
            },
            pattern: {
              type: "string",
              description:
                "Optional glob pattern to filter results, e.g. '*.ts' or '**/*.test.ts'.",
            },
            recursive: {
              type: "boolean",
              description:
                "Whether to list files recursively. Defaults to false.",
            },
          },
          required: [],
        },
      },
    },
  },
];

const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist"];

function resolveInsideWorkspace(
  relPath: string,
  workspaceRoot: string,
): string | null {
  const full = path.resolve(path.join(workspaceRoot, relPath));
  return full.startsWith(path.resolve(workspaceRoot)) ? full : null;
}

function executeListFiles(
  toolInput: { directory?: string; pattern?: string; recursive?: boolean },
  workspaceRoot: string,
): string {
  const dir = path.join(workspaceRoot, toolInput.directory ?? ".");
  const recursive = toolInput.recursive ?? false;
  const pattern = toolInput.pattern;

  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(workspaceRoot))) {
    return "Error: directory is outside the workspace root.";
  }

  if (!fs.existsSync(resolved)) {
    return `Error: directory not found: ${toolInput.directory ?? "."}`;
  }

  const entries = fs.readdirSync(resolved, {
    recursive,
    withFileTypes: true,
  }) as fs.Dirent[];

  const files = entries
    .filter((e) => {
      if (!e.isFile()) return false;
      const rel = path.relative(resolved, path.join(e.parentPath, e.name));
      const parts = rel.split(path.sep);
      if (parts.some((p) => DEFAULT_EXCLUDE_DIRS.includes(p))) return false;
      if (pattern && !path.matchesGlob(e.name, pattern)) return false;
      return true;
    })
    .map((e) => {
      const abs = path.join(e.parentPath, e.name);
      return path.relative(workspaceRoot, abs);
    })
    .sort();

  if (files.length === 0) return "No files found.";
  return files.join("\n");
}

function executeWriteFile(
  toolInput: { path: string; content: string },
  workspaceRoot: string,
): string {
  const fullPath = resolveInsideWorkspace(toolInput.path, workspaceRoot);
  if (!fullPath) return "Error: path is outside the workspace root.";
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, toolInput.content, "utf-8");
  return `Written: ${toolInput.path}`;
}

function executeStrReplace(
  toolInput: { path: string; old_str: string; new_str: string },
  workspaceRoot: string,
): string {
  const fullPath = resolveInsideWorkspace(toolInput.path, workspaceRoot);
  if (!fullPath) return "Error: path is outside the workspace root.";
  if (!fs.existsSync(fullPath)) {
    return `Error: file not found: ${toolInput.path}`;
  }
  const content = fs.readFileSync(fullPath, "utf-8");
  const idx = content.indexOf(toolInput.old_str);
  if (idx === -1) {
    return `Error: old_str not found in ${toolInput.path}`;
  }
  const updated =
    content.slice(0, idx) +
    toolInput.new_str +
    content.slice(idx + toolInput.old_str.length);
  fs.writeFileSync(fullPath, updated, "utf-8");
  return `Replaced in: ${toolInput.path}`;
}

function executeCreateDirectory(
  toolInput: { path: string },
  workspaceRoot: string,
): string {
  const fullPath = resolveInsideWorkspace(toolInput.path, workspaceRoot);
  if (!fullPath) return "Error: path is outside the workspace root.";
  fs.mkdirSync(fullPath, { recursive: true });
  return `Created: ${toolInput.path}`;
}

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
        : toolName === "read_file" ||
            toolName === "write_file" ||
            toolName === "str_replace" ||
            toolName === "create_directory"
          ? (toolInput.path ?? "")
          : toolName === "list_files"
            ? (toolInput.directory ?? ".")
            : "";
    console.log(
      `\n  [${skill}/${model}] Running tool: ${toolName}${toolDetail ? `: ${toolDetail}` : ""}...`,
    );

    try {
      if (toolName === "bash") {
        const { command } = toolInput;
        if (isBlockedBashCommand(command)) {
          return BLOCKED_COMMAND_ERROR;
        }
        const result = execSync(command, {
          cwd: workspaceRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB
          timeout: 30000, // 30s
        });
        return result;
      } else if (toolName === "read_file") {
        const { path: filePath } = toolInput;
        const fullPath = resolveInsideWorkspace(filePath, workspaceRoot);
        if (!fullPath) return "Error: path is outside the workspace root.";
        if (!fs.existsSync(fullPath))
          return `Error: file not found: ${filePath}`;
        return fs.readFileSync(fullPath, "utf-8");
      } else if (toolName === "write_file") {
        return executeWriteFile(toolInput, workspaceRoot);
      } else if (toolName === "str_replace") {
        return executeStrReplace(toolInput, workspaceRoot);
      } else if (toolName === "create_directory") {
        return executeCreateDirectory(toolInput, workspaceRoot);
      } else if (toolName === "list_files") {
        return executeListFiles(toolInput, workspaceRoot);
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
