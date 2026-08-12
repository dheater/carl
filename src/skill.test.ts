import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runSkill,
  buildSkillInstruction,
  computeCost,
  loadCarlConfig,
} from "./skill";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResponse,
  UsageSummary,
} from "./types";
import { AgentRunError } from "./types";

jest.mock("./git", () => ({
  getCurrentBranch: jest.fn().mockReturnValue("main"),
  getHeadShaOrNull: jest.fn().mockReturnValue("abc123"),
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
  let configDir: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-config-"));
    process.env.CARL_CONFIG_DIR = configDir;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.CARL_CONFIG_DIR;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("excludes write tools for review skill", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
      "medium",
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
      "high",
      runner,
    );

    expect(runner.requests[0].excludedTools ?? []).toEqual([]);
  });

  test("appends usage summary to output file when usage is absent", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

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
    await runSkill(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
    );

    const eventsPath = path.join(configDir, "events.jsonl");
    const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
    const toolEvents = lines
      .map((l) => JSON.parse(l))
      .filter((e: any) => e.event === "tool_call");

    expect(toolEvents).toHaveLength(3);

    expect(toolEvents[0].subject).toBe("read_file");
    expect(toolEvents[0].meta.input_summary).toBe("src/foo.ts");
    expect(toolEvents[0].meta.output_bytes).toBe(512);
    expect(toolEvents[0].meta.error).toBe(false);

    expect(toolEvents[1].subject).toBe("bash");
    expect(toolEvents[1].meta.error).toBe(false);

    expect(toolEvents[2].subject).toBe("bash");
    expect(toolEvents[2].meta.error).toBe(true);

    for (const e of toolEvents) {
      expect(e.meta.tool).toBeUndefined();
      expect(e.skill).toBe("code");
      expect(e.run_id).toBeDefined();
      expect(e.timestamp).toBeDefined();
    }

    // All events in a run (prompt + tool_calls) must share the same run_id
    // so downstream telemetry can group them correctly.
    const allEvents = lines.map((l) => JSON.parse(l));
    const runIds = new Set(allEvents.map((e: any) => e.run_id));
    expect(runIds.size).toBe(1);
  });

  function readEvents(): any[] {
    const eventsPath = path.join(configDir, "events.jsonl");
    return fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  test("emits skill and prompt events for pr-review", async () => {
    await runSkill(
      workspaceRoot,
      "pr-review",
      "review this",
      "test-model",
      "high",
      new MockRunner("draft updated", {
        source: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
      }),
    );

    const events = readEvents();
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("skill");
    expect(kinds).toContain("prompt");

    const prompt = events.find((e) => e.event === "prompt");
    expect(prompt.meta.usage.inputTokens).toBe(100);
    expect(computeCost(prompt.meta.usage)).toBeGreaterThan(0);
  });

  test("stamps workspace, git context, effort, and invocation_id on every event", async () => {
    await runSkill(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "low",
      new MockRunner("# Summary\n\nDone.", undefined, [
        {
          tool: "bash",
          inputSummary: "ls",
          outputBytes: 4,
          durationMs: 1,
          error: false,
        },
      ]),
    );

    const events = readEvents();
    expect(events.length).toBeGreaterThan(1);
    for (const e of events) {
      expect(e.workspace).toBe(workspaceRoot);
      expect(e.git_branch).toBe("main");
      expect(e.git_sha).toBe("abc123");
      expect(e.effort).toBe("low");
      expect(e.invocation_id).toBeDefined();
    }
    // One process is one invocation, even across event types.
    expect(new Set(events.map((e) => e.invocation_id)).size).toBe(1);
  });

  test("two runs in one process share invocation_id but not run_id", async () => {
    for (const prompt of ["first", "second"]) {
      await runSkill(
        workspaceRoot,
        "pr-review",
        prompt,
        "test-model",
        "high",
        new MockRunner("draft"),
      );
    }

    const events = readEvents();
    expect(new Set(events.map((e) => e.invocation_id)).size).toBe(1);
    expect(new Set(events.map((e) => e.run_id)).size).toBe(2);
  });

  test("records tokens spent by a run that fails at max turns", async () => {
    const spentBeforeFailure: UsageSummary = {
      source: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 5000,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 20_000,
      turns: 80,
    };
    const runner: AgentRunner = {
      async run() {
        throw new AgentRunError(
          "Exceeded maximum conversation turns (80).",
          spentBeforeFailure,
        );
      },
    };

    await expect(
      runSkill(
        workspaceRoot,
        "code",
        "loop forever",
        "test-model",
        "medium",
        runner,
      ),
    ).rejects.toThrow("Exceeded maximum conversation turns");

    const skillEvent = readEvents().find((e) => e.event === "skill");
    expect(skillEvent.meta.status).toBe("error");
    expect(skillEvent.meta.usage).toEqual(spentBeforeFailure);
    expect(computeCost(skillEvent.meta.usage)).toBeGreaterThan(0);
  });

  test("records tokens spent before a non-runner error", async () => {
    const runner: AgentRunner = {
      async run() {
        const err: any = new Error("boom");
        err.usage = {
          source: "bedrock",
          modelId: "us.anthropic.claude-sonnet-4-6",
          inputTokens: 42,
        };
        throw err;
      },
    };

    await expect(
      runSkill(workspaceRoot, "code", "x", "test-model", "medium", runner),
    ).rejects.toThrow("boom");

    const skillEvent = readEvents().find((e) => e.event === "skill");
    expect(skillEvent.meta.usage.inputTokens).toBe(42);
  });

  test("omits usage from the skill event when a failure spent nothing", async () => {
    const runner: AgentRunner = {
      async run() {
        throw new Error("config error before any request");
      },
    };

    await expect(
      runSkill(workspaceRoot, "code", "x", "test-model", "medium", runner),
    ).rejects.toThrow("config error");

    const skillEvent = readEvents().find((e) => e.event === "skill");
    expect(skillEvent.meta.status).toBe("error");
    expect(skillEvent.meta.usage).toBeUndefined();
  });
});

describe("loadCarlConfig two-file merge", () => {
  let workspaceRoot: string;
  let configDir: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-ws-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-cfg-"));
    process.env.CARL_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    delete process.env.CARL_CONFIG_DIR;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("local nested field does not drop unrelated global nested fields", () => {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        backend: "bedrock",
        efforts: { code: "high", review: "high" },
        models: { code: "opus", review: "haiku" },
        backends: { code: "auggie" },
        providers: { bedrock: { region: "us-west-2" } },
      }),
      "utf-8",
    );

    const localConfigDir = path.join(workspaceRoot, ".carl");
    fs.mkdirSync(localConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(localConfigDir, "config.json"),
      JSON.stringify({
        efforts: { review: "low" },
        models: { review: "sonnet" },
        backends: { review: "bedrock" },
        providers: { bedrock: { region: "eu-west-1" } },
      }),
      "utf-8",
    );

    const config = loadCarlConfig(workspaceRoot);

    // local field wins
    expect(config.efforts?.review).toBe("low");
    expect(config.models?.review).toBe("sonnet");
    expect(config.backends?.review).toBe("bedrock");
    expect(config.providers?.bedrock?.region).toBe("eu-west-1");

    // global field not touched by local survives
    expect(config.efforts?.code).toBe("high");
    expect(config.models?.code).toBe("opus");
    expect(config.backends?.code).toBe("auggie");

    // scalar top-level: local wins
    expect(config.backend).toBe("bedrock");
  });

  test("providers deep merge: local sub-field wins, unset global sub-field survives", () => {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: {
          bedrock: { region: "us-east-1", timeout: 30 },
          auggie: { endpoint: "https://example.com" },
        },
      }),
      "utf-8",
    );

    const localConfigDir = path.join(workspaceRoot, ".carl");
    fs.mkdirSync(localConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(localConfigDir, "config.json"),
      JSON.stringify({
        providers: { bedrock: { region: "eu-west-1" } },
      }),
      "utf-8",
    );

    const config = loadCarlConfig(workspaceRoot);
    // Local sub-field wins.
    expect(config.providers?.bedrock?.region).toBe("eu-west-1");
    // Global sub-field not overridden by local survives.
    expect((config.providers?.bedrock as any)?.timeout).toBe(30);
    // Unrelated global provider key survives.
    expect((config.providers as any)?.auggie?.endpoint).toBe(
      "https://example.com",
    );
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
    // base rates: 0.1 in + 0.05 out + 0.025 cache write + 0.005 cache read
    expect(cost).toBeCloseTo(0.18, 5);
  });

  test("opus: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5.0, 5);
  });

  test("fable: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-fable-5",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(10.0, 5);
  });

  test("cache multipliers are 1.25x input for write and 0.1x for read", () => {
    for (const modelId of [
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-fable-5",
    ]) {
      const input = computeCost({ source: "b", modelId, inputTokens: 1e6 })!;
      const write = computeCost({
        source: "b",
        modelId,
        cacheWriteTokens: 1e6,
      })!;
      const read = computeCost({ source: "b", modelId, cacheReadTokens: 1e6 })!;
      expect(write).toBeCloseTo(input * 1.25, 5);
      expect(read).toBeCloseTo(input * 0.1, 5);
    }
  });

  test("returns null for an unpriced model and warns once", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const usage = { source: "openai", modelId: "gpt5.4", inputTokens: 1000 };
    expect(computeCost(usage)).toBeNull();
    expect(computeCost(usage)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
