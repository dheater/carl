import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSkill, buildSkillInstruction, computeCost } from "./skill";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResponse,
  UsageSummary,
} from "./runner";

jest.mock("./git", () => ({
  getCurrentBranch: jest.fn().mockReturnValue("main"),
  getGitStatus: jest.fn().mockReturnValue({
    isRepo: true,
    trackedChanged: [],
    untracked: [],
  }),
  getGitDiff: jest.fn().mockReturnValue(""),
}));

class MockRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  response: string;
  usage?: UsageSummary;
  simulatedToolCalls: Array<{
    tool: string;
    inputSummary: string;
    outputBytes: number;
    durationMs: number;
    error: boolean;
  }>;

  constructor(
    response = "# Summary\n\nDone.",
    usage?: UsageSummary,
    simulatedToolCalls: Array<{
      tool: string;
      inputSummary: string;
      outputBytes: number;
      durationMs: number;
      error: boolean;
    }> = [],
  ) {
    this.response = response;
    this.usage = usage;
    this.simulatedToolCalls = simulatedToolCalls;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResponse> {
    this.requests.push(req);
    for (const tc of this.simulatedToolCalls) {
      req.onToolCall?.(tc);
    }
    return { text: this.response, usage: this.usage };
  }
}

describe("buildSkillInstruction", () => {
  test("includes workspace root path and discourages cd prefix", () => {
    const instruction = buildSkillInstruction("code", "/my/project");
    expect(instruction).toContain("# Workspace");
    expect(instruction).toContain("/my/project");
    expect(instruction).toContain("never prefix commands with");
    expect(instruction).toContain("cd /workspace &&");
  });

  test("omits workspace section when workspaceRoot is not provided", () => {
    const instruction = buildSkillInstruction("code");
    expect(instruction).not.toContain("# Workspace");
  });

  test("review: embeds diff section with content when diff is non-empty", () => {
    const git = require("./git") as typeof import("./git");
    (git.getGitDiff as jest.Mock).mockReturnValueOnce(
      "diff --git a/f.ts b/f.ts\n+added",
    );
    (git.getCurrentBranch as jest.Mock).mockReturnValueOnce("fix/TICKET-1");
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Diff");
    expect(instruction).toContain("```diff");
    expect(instruction).toContain("+added");
  });

  test("review: embeds error message when git diff fails", () => {
    const git = require("./git") as typeof import("./git");
    (git.getGitDiff as jest.Mock).mockReturnValueOnce(null);
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Diff");
    expect(instruction).toContain("git diff HEAD failed");
    expect(instruction).not.toContain("```diff");
  });

  test("review: embeds empty-diff message when there is no diff", () => {
    const git = require("./git") as typeof import("./git");
    (git.getGitDiff as jest.Mock).mockReturnValueOnce("");
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Diff");
    expect(instruction).toContain("No diff");
    expect(instruction).not.toContain("```diff");
  });

  test("review: includes commit message guidance for ticket branch", () => {
    const git = require("./git") as typeof import("./git");
    (git.getCurrentBranch as jest.Mock).mockReturnValueOnce("feat/ABC-123");
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Commit message");
    expect(instruction).toContain("ABC-123");
  });

  test("review: includes conventional-commit guidance for main branch", () => {
    const git = require("./git") as typeof import("./git");
    (git.getCurrentBranch as jest.Mock).mockReturnValueOnce("main");
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Commit message");
    expect(instruction).toContain("fix:`/`feat:`/`chore:");
  });
});

describe("runSkill", () => {
  let workspaceRoot: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("excludes write tools for review skill", async () => {
    const runner = new MockRunner();
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    expect(runner.requests[0].excludedTools).toEqual(
      expect.arrayContaining([
        "remove-files",
        "save-file",
        "str-replace-editor",
      ]),
    );
  });

  test("does not exclude write tools for code skill", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "code",
      "implement this",
      "test-model",
      runner,
    );

    expect(runner.requests[0].excludedTools ?? []).toEqual([]);
  });

  test("does not exclude write tools for pr-review skill", async () => {
    const runner = new MockRunner("draft updated");
    await runSkill(
      workspaceRoot,
      "pr-review",
      "review this",
      "test-model",
      runner,
    );

    expect(runner.requests[0].excludedTools ?? []).toEqual([]);
  });

  test("appends usage summary to output file when usage is absent", async () => {
    const runner = new MockRunner();
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("Completed in");
    expect(content).not.toContain("tokens");
    expect(content).not.toContain("$");
  });

  test("appends turns count to output file when turns is present", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      turns: 7,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("7 turns");
  });

  test("uses singular 'turn' when turns is 1", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      turns: 1,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("1 turn");
    expect(content).not.toContain("1 turns");
  });

  test("omits turns from output file when turns is absent", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      inputTokens: 100,
      outputTokens: 50,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).not.toMatch(/\d+ turns?/);
  });

  test("appends usage summary with token counts to output file", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("Completed in");
    expect(content).toContain("1,000 in / 500 out tokens");
    expect(content).toContain("800 cache read / 200 cache write tokens");
  });

  test("omits token lines when outputTokens and cache fields are absent", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      inputTokens: 1000,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("Completed in");
    expect(content).not.toContain("in / ");
    expect(content).not.toContain("cache read");
  });

  test("appends cost to output file for a known sonnet model", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      inputTokens: 100_000,
      outputTokens: 5_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 10_000,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toMatch(/\$\d+\.\d{4}/);
  });

  test("omits cost from output file when model is unrecognized", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      source: "bedrock",
      modelId: "test-model-id",
      inputTokens: 1000,
      outputTokens: 500,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).not.toContain("$");
  });

  test("writes tool_call events to events.jsonl for each tool invocation", async () => {
    const toolCalls: Array<{
      tool: string;
      inputSummary: string;
      outputBytes: number;
      durationMs: number;
      error: boolean;
    }> = [
      {
        tool: "read_file",
        inputSummary: "src/foo.ts",
        outputBytes: 512,
        durationMs: 10,
        error: false,
      },
      {
        tool: "bash",
        inputSummary: "npm test",
        outputBytes: 1024,
        durationMs: 200,
        error: false,
      },
      {
        tool: "bash",
        inputSummary: "find . -type f",
        outputBytes: 80,
        durationMs: 5,
        error: true,
      },
    ];
    const runner = new MockRunner("# Summary\n\nDone.", undefined, toolCalls);
    await runSkill(workspaceRoot, "code", "build it", "test-model", runner);

    const eventsPath = path.join(workspaceRoot, ".carl/events.jsonl");
    const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
    const toolEvents = lines
      .map((l) => JSON.parse(l))
      .filter((e: any) => e.event === "tool_call");

    expect(toolEvents).toHaveLength(3);

    expect(toolEvents[0].subject).toBe("read_file");
    expect(toolEvents[0].meta.tool).toBe("read_file");
    expect(toolEvents[0].meta.input_summary).toBe("src/foo.ts");
    expect(toolEvents[0].meta.output_bytes).toBe(512);
    expect(toolEvents[0].meta.error).toBe(false);

    expect(toolEvents[1].meta.tool).toBe("bash");
    expect(toolEvents[1].meta.error).toBe(false);

    expect(toolEvents[2].meta.tool).toBe("bash");
    expect(toolEvents[2].meta.error).toBe(true);

    for (const e of toolEvents) {
      expect(e.skill).toBe("code");
      expect(e.run_id).toBeDefined();
      expect(e.timestamp).toBeDefined();
    }
  });

  test("all tool_call events for a run share the same run_id as prompt/skill events", async () => {
    const toolCalls = [
      {
        tool: "read_file",
        inputSummary: "a.ts",
        outputBytes: 10,
        durationMs: 1,
        error: false,
      },
    ];
    const runner = new MockRunner("# Summary\n\nDone.", undefined, toolCalls);
    await runSkill(workspaceRoot, "code", "go", "test-model", runner);

    const eventsPath = path.join(workspaceRoot, ".carl/events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const runIds = [...new Set(events.map((e: any) => e.run_id))];
    expect(runIds).toHaveLength(1);
  });
});

describe("computeCost", () => {
  test("returns null for unknown model", () => {
    expect(
      computeCost({ source: "bedrock", modelId: "unknown-model-xyz" }),
    ).toBeNull();
  });

  test("returns null when modelId is absent", () => {
    expect(computeCost({ source: "auggie" })).toBeNull();
  });

  test("sonnet: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.0, 5);
  });

  test("sonnet: output only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15.0, 5);
  });

  test("sonnet: cache write only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75, 5);
  });

  test("sonnet: cache read only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3, 5);
  });

  test("haiku: all token types", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheWriteTokens: 20_000,
      cacheReadTokens: 50_000,
    });
    expect(cost).toBeCloseTo(0.144, 5);
  });

  test("opus: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15.0, 5);
  });
});
