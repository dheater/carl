import {
  BedrockRuntimeClient,
  ConverseCommand,
  Tool,
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  CachePointType,
} from "@aws-sdk/client-bedrock-runtime";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Using US region inference profiles for lower latency.
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  sonnet5: "us.anthropic.claude-sonnet-5",
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

import type {
  EffortLevel,
  ToolCallEvent,
  AgentRunRequest,
  UsageSummary,
  AgentRunResponse,
  AgentRunner,
} from "./types";
import { AgentRunError, attachUsage } from "./types";

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
        const toolName: string = update.title || "unknown";
        console.log(`\n  [${skill}/${model}] Running tool: ${toolName}...`);
        request.onToolCall?.({ tool: toolName, error: false });
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
        "List files in a directory of the workspace, optionally filtered by glob pattern. Excludes node_modules, .git, dist, and directories listed in .gitignore. Use this instead of `find` or `ls -R`.",
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
  {
    toolSpec: {
      name: "find_symbol",
      description:
        "Search for all usages or callers of a symbol (function, class, variable, import) across the workspace using grep. Returns file:line matches. Use this to answer 'who calls/imports/uses X' in one tool call instead of multiple exploratory reads.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            symbol: {
              type: "string",
              description:
                "The symbol name or pattern to search for (passed as a fixed-string grep pattern).",
            },
            include_pattern: {
              type: "string",
              description:
                "Optional glob pattern to restrict which files are searched, e.g. '*.ts' or '*.py'. Defaults to all files.",
            },
            path: {
              type: "string",
              description:
                "Optional subdirectory to search within, relative to workspace root. Defaults to '.' (entire workspace).",
            },
          },
          required: ["symbol"],
        },
      },
    },
  },
];

const DEFAULT_EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist"]);

function resolveInsideWorkspace(
  relPath: string,
  workspaceRoot: string,
): string | null {
  const full = path.resolve(path.join(workspaceRoot, relPath));
  return full.startsWith(path.resolve(workspaceRoot)) ? full : null;
}

// Returns directory names from .gitignore lines ending in "/".
// Only handles the simple "dirname/" form — sufficient for the tool-level
// directories (node_modules, .devbox, .agent, etc.) that inflate file counts.
function parseGitignoreDirs(workspaceRoot: string): Set<string> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return new Set();
  const lines = fs.readFileSync(gitignorePath, "utf-8").split("\n");
  const dirs = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.endsWith("/")) {
      dirs.add(line.replace(/^\/|\/$/g, ""));
    }
  }
  return dirs;
}

const LIST_FILES_MAX_BYTES = 200 * 1024; // 200 KB — ~50K tokens, enough for any real project
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024; // 50 KB — ~12K tokens per tool result
const SPAWN_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

function truncateToolOutput(output: string, label: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_BYTES) return output;
  // Keep 20% head (context / command echo) and 80% tail (errors / results).
  const headBytes = Math.floor(TOOL_OUTPUT_MAX_BYTES * 0.2);
  const tailBytes = TOOL_OUTPUT_MAX_BYTES - headBytes;
  const dropped = output.length - headBytes - tailBytes;
  return (
    output.slice(0, headBytes) +
    `\n[... ${dropped} bytes omitted. ${label}]\n` +
    output.slice(output.length - tailBytes)
  );
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

  const excludeDirs = new Set([
    ...DEFAULT_EXCLUDE_DIRS,
    ...parseGitignoreDirs(workspaceRoot),
  ]);

  // Walk the tree with a queue, pruning excluded dirs before descending.
  // This keeps memory proportional to tree width, not total file count.
  // Contrast: fs.readdirSync({recursive:true}) materialises the entire tree
  // into one array before we can filter anything — fatal on large workspaces.
  const files: string[] = [];
  let truncated = false;
  let outputBytes = 0;
  const queue: string[] = [resolved];

  outer: while (queue.length > 0) {
    const currentDir = queue.shift()!;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (recursive && !excludeDirs.has(entry.name)) {
          queue.push(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const abs = path.join(currentDir, entry.name);
        const rel = path.relative(workspaceRoot, abs);
        const relFromDir = path.relative(resolved, abs);
        if (pattern && !path.matchesGlob(relFromDir, pattern)) continue;
        const line = rel + "\n";
        if (outputBytes + line.length > LIST_FILES_MAX_BYTES) {
          truncated = true;
          break outer;
        }
        files.push(rel);
        outputBytes += line.length;
      }
    }
  }

  if (files.length === 0 && !truncated) return "No files found.";

  files.sort();
  let output = files.join("\n");
  if (truncated) {
    output += `\n[Output truncated: too many files. Use a subdirectory or pattern to narrow results.]`;
  }
  return output;
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

function executeFindSymbol(
  toolInput: { symbol: string; include_pattern?: string; path?: string },
  workspaceRoot: string,
): string {
  const { symbol, include_pattern, path: subPath } = toolInput;
  if (!symbol || !symbol.trim()) return "Error: symbol is required.";

  const searchDir = subPath ? subPath.trim() : ".";
  const resolvedDir = resolveInsideWorkspace(searchDir, workspaceRoot);
  if (!resolvedDir) return "Error: path is outside the workspace root.";
  if (!fs.existsSync(resolvedDir)) {
    return `Error: directory not found: ${searchDir}`;
  }

  const grepArgs = [
    "-rn",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "-F", // fixed string — no regex surprises
    symbol,
  ];
  if (include_pattern) grepArgs.push(`--include=${include_pattern}`);
  grepArgs.push(resolvedDir);

  const result = spawnSync("grep", grepArgs, {
    cwd: workspaceRoot,
    encoding: "utf-8",
    maxBuffer: SPAWN_MAX_BUFFER,
    timeout: 30000,
  });
  if (result.error)
    return `Error executing find_symbol: ${result.error.message}`;
  // grep exits 1 when no matches found — that's not an error.
  if (result.status !== 0 && result.status !== 1)
    return `Error executing find_symbol: exited ${result.status}`;
  if (!result.stdout.trim()) return "No matches found.";

  const relResult = result.stdout
    .split("\n")
    .map((line) =>
      line.startsWith(workspaceRoot + "/")
        ? line.slice(workspaceRoot.length + 1)
        : line,
    )
    .join("\n");
  return truncateToolOutput(
    relResult.trimEnd() || "No matches found.",
    "Narrow the search with include_pattern or path.",
  );
}

// Returns a shallow copy of messages with a cachePoint appended to the last
// message's content. Never mutates the input array — callers pass this only
// to ConverseCommand and continue appending to the original messages.
function withTrailingCachePoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const content = last.content ?? [];
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [...content, { cachePoint: { type: CachePointType.DEFAULT } }],
    },
  ];
}

function effortBudget(effort: "medium" | "high"): number {
  return effort === "high" ? 16000 : 8192;
}

export const BEDROCK_SYSTEM_PROMPT =
  "Issue all independent tool calls in the same turn — never wait for one result before requesting the next.\n\n" +
  "Prefer write_file over repeated str_replace when making many edits to a file.";

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
  ): { result: string; error: boolean; inputSummary: string } {
    const toolDetailField: Record<string, string> = {
      bash: "command",
      read_file: "path",
      write_file: "path",
      str_replace: "path",
      create_directory: "path",
      list_files: "directory",
      find_symbol: "symbol",
    };
    const field = toolDetailField[toolName];
    const inputSummary = field
      ? (toolInput[field] ?? (field === "directory" ? "." : ""))
      : "";
    console.log(
      `\n  [${skill}/${model}] Running tool: ${toolName}${inputSummary ? `: ${inputSummary}` : ""}...`,
    );

    try {
      if (toolName === "bash") {
        const { command } = toolInput;
        if (isBlockedBashCommand(command)) {
          return { result: BLOCKED_COMMAND_ERROR, error: true, inputSummary };
        }
        const raw = execSync(command, {
          cwd: workspaceRoot,
          encoding: "utf-8",
          maxBuffer: SPAWN_MAX_BUFFER,
          timeout: 30000, // 30s
        });
        return {
          result: truncateToolOutput(
            raw,
            "Pipe through head/tail/grep to reduce output.",
          ),
          error: false,
          inputSummary,
        };
      } else if (toolName === "read_file") {
        const { path: filePath } = toolInput;
        const fullPath = resolveInsideWorkspace(filePath, workspaceRoot);
        if (!fullPath)
          return {
            result: "Error: path is outside the workspace root.",
            error: true,
            inputSummary,
          };
        if (!fs.existsSync(fullPath))
          return {
            result: `Error: file not found: ${filePath}`,
            error: true,
            inputSummary,
          };
        return {
          result: truncateToolOutput(
            fs.readFileSync(fullPath, "utf-8"),
            "Use bash with grep/sed to read specific sections.",
          ),
          error: false,
          inputSummary,
        };
      } else if (toolName === "write_file") {
        const result = executeWriteFile(toolInput, workspaceRoot);
        return { result, error: result.startsWith("Error:"), inputSummary };
      } else if (toolName === "str_replace") {
        const result = executeStrReplace(toolInput, workspaceRoot);
        return { result, error: result.startsWith("Error:"), inputSummary };
      } else if (toolName === "create_directory") {
        const result = executeCreateDirectory(toolInput, workspaceRoot);
        return { result, error: result.startsWith("Error:"), inputSummary };
      } else if (toolName === "list_files") {
        const result = executeListFiles(toolInput, workspaceRoot);
        return { result, error: result.startsWith("Error:"), inputSummary };
      } else if (toolName === "find_symbol") {
        const result = executeFindSymbol(toolInput, workspaceRoot);
        return { result, error: result.startsWith("Error:"), inputSummary };
      } else {
        return {
          result: `Unknown tool: ${toolName}`,
          error: true,
          inputSummary,
        };
      }
    } catch (err: any) {
      return {
        result: `Error executing ${toolName}: ${err.message}`,
        error: true,
        inputSummary,
      };
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const { workspaceRoot, skill, model, instruction, excludedTools, effort } =
      request;
    const modelId = BEDROCK_MODEL_IDS[model] ?? model;
    const start = Date.now();

    let messages: Message[] = [
      {
        role: "user",
        content: [{ text: instruction }],
      },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    const maxTurns = 80;

    const filteredTools = excludedTools?.length
      ? BEDROCK_TOOLS.filter(
          (t) => !excludedTools.includes(t.toolSpec?.name ?? ""),
        )
      : BEDROCK_TOOLS;

    // failure paths below, so a run that throws still reports what it cost.
    const usageSoFar = (turns: number): UsageSummary => ({
      source: "bedrock",
      modelId,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      latencyMs: Date.now() - start,
      turns,
    });

    for (let turn = 0; turn < maxTurns; turn++) {
      let response;
      try {
        response = await this.client.send(
          new ConverseCommand({
            modelId,
            system: [{ text: BEDROCK_SYSTEM_PROMPT }],
            messages: withTrailingCachePoint(messages),
            ...(effort !== "low" && {
              additionalModelRequestFields: {
                thinking: {
                  type: "enabled",
                  budget_tokens: effortBudget(effort),
                },
              },
            }),
            // Omit toolConfig entirely when no tools remain after filtering,
            // rather than sending a tools array with only a cachePoint entry.
            ...(filteredTools.length > 0 && {
              toolConfig: {
                // static tools array; same prefix each turn
                tools: [
                  ...filteredTools,
                  { cachePoint: { type: CachePointType.DEFAULT } },
                ],
              },
            }),
          }),
        );
      } catch (err) {
        // Preserve spend from earlier turns; a mid-run network failure is not free.
        throw attachUsage(err, usageSoFar(turn));
      }

      totalInputTokens += response.usage?.inputTokens ?? 0;
      totalOutputTokens += response.usage?.outputTokens ?? 0;
      totalCacheReadTokens += response.usage?.cacheReadInputTokens ?? 0;
      totalCacheWriteTokens += response.usage?.cacheWriteInputTokens ?? 0;

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

        return { text, usage: usageSoFar(turn + 1) };
      } else if (stopReason === "tool_use") {
        const toolResults: ContentBlock[] = [];

        for (const block of assistantContent) {
          if ("toolUse" in block) {
            const toolUse = block.toolUse as ToolUseBlock;
            const toolName = toolUse.name ?? "unknown";
            const toolInput = toolUse.input ?? {};
            const toolUseId = toolUse.toolUseId ?? "";

            const toolStart = Date.now();
            const { result, error, inputSummary } = this.executeTool(
              toolName,
              toolInput,
              workspaceRoot,
              skill,
              model,
            );
            request.onToolCall?.({
              tool: toolName,
              inputSummary,
              outputBytes: Buffer.byteLength(result, "utf-8"),
              durationMs: Date.now() - toolStart,
              error,
            });

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
        throw new AgentRunError(
          `Unexpected stop reason: ${stopReason}`,
          usageSoFar(turn + 1),
        );
      }
    }

    throw new AgentRunError(
      `Exceeded maximum conversation turns (${maxTurns}). Break the task into smaller steps or use --model to select a larger model.`,
      usageSoFar(maxTurns),
    );
  }
}
