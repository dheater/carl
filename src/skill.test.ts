import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runSkill,
  runSkillWithValidation,
  resolveValidation,
  buildSkillInstruction,
  buildSkillPersona,
  isReadOnlySkill,
  computeCost,
  loadCarlConfig,
  DEFAULT_MAX_RETRIES,
} from "./skill";
import * as validateModule from "./validate";
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

  test("names the configured validation command carl will run", () => {
    // `feedback` earns the section for the same reason `code` does: it edits the
    // workspace, so the check command is what decides whether it worked.
    for (const skill of ["code", "feedback"]) {
      const instruction = buildSkillInstruction(
        skill,
        "/proj",
        "main",
        "just check",
      );
      expect(instruction).toContain("# Validation");
      expect(instruction).toContain("just check");
      expect(instruction).toContain("starts a new session with the failures");
    }
  });

  test("code: says nothing will check the work when no command is configured", () => {
    const instruction = buildSkillInstruction("code", "/proj", "main");
    expect(instruction).toContain("# Validation");
    expect(instruction).toContain("configures no validation command");
    expect(instruction).toContain(
      "Run the smallest check that would catch a mistake",
    );
  });

  test("read-only skills are told the denial is deliberate", () => {
    // A `carl plan` run that hit a denied write once reported "grant write
    // access" instead of a plan. The sandbox mode is a fact carl knows, so carl
    // states it rather than letting the session infer a misconfiguration.
    for (const skill of ["ask", "plan", "review"]) {
      const instruction = buildSkillInstruction(skill, "/proj");
      expect(instruction).toContain("# Sandbox");
      expect(instruction).toContain("read-only");
      expect(instruction).toContain("do not ask for write access");
      expect(instruction).toContain(`.agent/notes/${skill}.md`);
    }
  });

  test("writable skills get no sandbox section", () => {
    for (const skill of ["code", "feedback", "pr-review"]) {
      expect(buildSkillInstruction(skill, "/proj")).not.toContain("# Sandbox");
    }
  });

  test("read-only skills get no validation section", () => {
    // Only `code` changes code; ask, plan and review are read-only and pr-review
    // only writes a draft, so a validation command would be a lie in all four.
    for (const skill of ["ask", "plan", "review", "pr-review"]) {
      const instruction = buildSkillInstruction(
        skill,
        "/proj",
        "main",
        "just check",
      );
      expect(instruction).not.toContain("# Validation");
    }
  });

  test("review: includes conventional-commit guidance for main branch", () => {
    const git = require("./git") as typeof import("./git");
    (git.getCurrentBranch as jest.Mock).mockReturnValueOnce("main");
    const instruction = buildSkillInstruction("review", "/proj");
    expect(instruction).toContain("# Commit message");
    expect(instruction).toContain("fix:`/`feat:`/`chore:");
  });

  test("includes AGENTS.md content when the file is present in workspaceRoot", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-agents-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "AGENTS.md"),
        "# Project Rules\n\nAlways write tests.",
        "utf-8",
      );
      const instruction = buildSkillInstruction("code", tmpDir);
      expect(instruction).toContain("# Project Rules");
      expect(instruction).toContain("Always write tests.");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("omits AGENTS.md section when the file is absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-agents-"));
    try {
      const instruction = buildSkillInstruction("code", tmpDir);
      expect(instruction).not.toContain("AGENTS.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("omits AGENTS.md section when workspaceRoot is not provided", () => {
    const instruction = buildSkillInstruction("code");
    expect(instruction).not.toContain("AGENTS.md");
  });
});

describe("buildSkillPersona", () => {
  const rulesDir = path.join(__dirname, "..", "rules");
  const skills = fs
    .readdirSync(path.join(__dirname, "..", "skills"))
    .map((f) => path.basename(f, ".md"));

  test("the writing skills carry the rules only a writing session can act on", () => {
    for (const skill of ["code", "feedback"]) {
      const persona = buildSkillPersona(skill);
      expect(persona).toContain("# Git Policy");
      expect(persona).toContain("# Error Messages");
    }
  });

  test("read-only skills do not carry the git policy", () => {
    // They cannot run a git command that lands, so the rule would be dead text
    // in every one of their prompts.
    for (const skill of skills.filter(isReadOnlySkill)) {
      expect(buildSkillPersona(skill)).not.toContain("# Git Policy");
    }
  });

  test("every rules file reaches at least one skill", () => {
    // `help-error-messages.md` shipped in v7 and no skill ever loaded it. A rule
    // nobody reads is a rule nobody follows, and nothing else would notice.
    const personas = skills.map((s) => buildSkillPersona(s)).join("\n");
    for (const file of fs.readdirSync(rulesDir)) {
      const heading = fs
        .readFileSync(path.join(rulesDir, file), "utf-8")
        .split("\n")[0];
      expect(personas).toContain(heading);
    }
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

  test("runs the review skill read-only", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "review",
      undefined,
      "test-model",
      "high",
      runner,
    );

    expect(runner.requests[0].readOnly).toBe(true);
  });

  test("runs ask and plan read-only, so neither can touch the workspace", async () => {
    // These two are the whole contract of `carl ask` and `carl plan`. The skill
    // files say "writes nothing"; the sandbox is what makes that true.
    for (const skill of ["ask", "plan"]) {
      const runner = new MockRunner();
      await runSkill(
        workspaceRoot,
        skill,
        "a question",
        "test-model",
        "medium",
        runner,
      );
      expect(runner.requests[0].readOnly).toBe(true);
    }
  });

  test("writes ask and plan answers where the editor and --plan look for them", async () => {
    for (const skill of ["ask", "plan"]) {
      await runSkill(
        workspaceRoot,
        skill,
        "a question",
        "test-model",
        "medium",
        new MockRunner(`# ${skill} output`),
      );
      const outputPath = path.join(workspaceRoot, `.agent/notes/${skill}.md`);
      expect(fs.readFileSync(outputPath, "utf-8")).toContain(
        `# ${skill} output`,
      );
    }
  });

  test("runs the code skill writable", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "code",
      "implement this",
      "test-model",
      "medium",
      runner,
    );

    expect(runner.requests[0].readOnly).toBe(false);
  });

  test("runs the feedback skill writable, because applying a comment means editing", async () => {
    const runner = new MockRunner();
    await runSkill(
      workspaceRoot,
      "feedback",
      "review says the guard is wrong",
      "test-model",
      "medium",
      runner,
    );

    expect(runner.requests[0].readOnly).toBe(false);
  });

  test("runs the pr-review skill writable so it can edit the draft", async () => {
    const runner = new MockRunner("draft updated");
    await runSkill(
      workspaceRoot,
      "pr-review",
      "review this",
      "test-model",
      "high",
      runner,
    );

    expect(runner.requests[0].readOnly).toBe(false);
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

describe("runSkill retries a poisoned session", () => {
  let workspaceRoot: string;
  let configDir: string;
  let logSpy: jest.SpyInstance;

  // What Bedrock says once a hallucinated dotted tool name is in the transcript:
  // the rejection is about a past turn's toolUse block, so every later request
  // fails the same way and the session cannot be continued.
  const POISON_MESSAGE =
    "ValidationException: 1 validation error detected: Value 'tools.write' at " +
    "'messages.12.content.1.toolUse.name' failed to satisfy constraint: " +
    "Member must satisfy regular expression pattern: [a-zA-Z0-9_-]+";

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-poison-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-poison-cfg-"));
    process.env.CARL_CONFIG_DIR = configDir;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.CARL_CONFIG_DIR;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("re-runs in a fresh session and succeeds", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        if (calls === 1) throw new Error(POISON_MESSAGE);
        return { text: "# Summary\n\nDone." };
      },
    };

    const result = await runSkill(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
    );

    expect(result.response).toContain("Done.");
    expect(calls).toBe(2);
    const events = fs
      .readFileSync(path.join(configDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const skillEvent = events.find((e) => e.event === "skill");
    expect(skillEvent.meta.status).toBe("success");
    expect(skillEvent.meta.retry_count).toBe(1);
  });

  test("gives up after one fresh session and explains it is the model", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        throw new Error(POISON_MESSAGE);
      },
    };

    await expect(
      runSkill(
        workspaceRoot,
        "code",
        "build it",
        "test-model",
        "medium",
        runner,
      ),
    ).rejects.toThrow(/invalid tool name/);
    expect(calls).toBe(2);
  });

  test("does not retry an unrelated provider error", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        throw new Error("AccessDeniedException: you do not have access");
      },
    };

    await expect(
      runSkill(
        workspaceRoot,
        "code",
        "build it",
        "test-model",
        "medium",
        runner,
      ),
    ).rejects.toThrow(/AccessDenied/);
    expect(calls).toBe(1);
  });
});

describe("runSkillWithValidation", () => {
  let workspaceRoot: string;
  let configDir: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-valrun-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-valrun-cfg-"));
    process.env.CARL_CONFIG_DIR = configDir;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    logSpy.mockRestore();
    delete process.env.CARL_CONFIG_DIR;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  class ScriptedRunner implements AgentRunner {
    requests: AgentRunRequest[] = [];
    constructor(
      private onAttempt: (attempt: number) => void = () => {},
      private editsOnAttempt: (attempt: number) => boolean = () => true,
    ) {}
    async run(req: AgentRunRequest): Promise<AgentRunResponse> {
      this.requests.push(req);
      const attempt = this.requests.length;
      if (this.editsOnAttempt(attempt)) {
        req.onToolCall?.({
          tool: "edit",
          inputSummary: "src/thing.ts",
          outputBytes: 12,
          durationMs: 3,
          error: false,
        });
      }
      this.onAttempt(attempt);
      return { text: `summary of attempt ${attempt}` };
    }
  }

  function eventsOfType(type: string): any[] {
    return fs
      .readFileSync(path.join(configDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === type);
  }

  const validateEvents = () => eventsOfType("validate");
  const summaryEvent = () => eventsOfType("validation")[0];

  test("runs the skill once and reports the pass", async () => {
    const runner = new ScriptedRunner();
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 0", maxRetries: 1 },
    );

    expect(result.validation).toMatchObject({
      ok: true,
      runs: 1,
      stopped: "passed",
    });
    expect(runner.requests).toHaveLength(1);
    expect(summaryEvent().meta).toMatchObject({
      command: "exit 0",
      runs: 1,
      repairs: 0,
      passed: true,
      timed_out: false,
      max_retries: 1,
      stopped: "passed",
    });
  });

  test("re-runs with the failure and stops once the check passes", async () => {
    const marker = path.join(workspaceRoot, "fixed.txt");
    const runner = new ScriptedRunner((attempt) => {
      if (attempt === 2) fs.writeFileSync(marker, "", "utf-8");
    });

    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "test -f fixed.txt", maxRetries: 1 },
    );

    expect(result.validation).toMatchObject({ ok: true, runs: 2 });
    expect(runner.requests).toHaveLength(2);
    // The repair session gets the request, the previous summary, and the failure.
    const repair = runner.requests[1].instruction;
    expect(repair).toContain("# Original request");
    expect(repair).toContain("build it");
    expect(repair).toContain("summary of attempt 1");
    expect(repair).toContain("# Validation failure");
    expect(repair).toContain("test -f fixed.txt");
  });

  test("stops at maxRetries and reports the failure with its output", async () => {
    const runner = new ScriptedRunner();
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "echo still-broken >&2; exit 1", maxRetries: 1 },
    );

    expect(result.validation?.ok).toBe(false);
    expect(result.validation?.runs).toBe(2);
    expect(result.validation?.stopped).toBe("budget");
    expect(result.validation?.result.output).toContain("still-broken");
    expect(runner.requests).toHaveLength(2);
    expect(summaryEvent().meta).toMatchObject({
      runs: 2,
      repairs: 1,
      passed: false,
      stopped: "budget",
    });
  });

  test("stops after a repair session that changed no files", async () => {
    // The budget says 3 repairs are allowed. A repair that edited nothing cannot
    // have changed the outcome, so spending them would be a paid re-roll.
    const runner = new ScriptedRunner(
      () => {},
      (attempt) => attempt === 1,
    );
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 1", maxRetries: 3 },
    );

    expect(result.validation).toMatchObject({
      ok: false,
      runs: 2,
      stopped: "stalled",
    });
    expect(runner.requests).toHaveLength(2);
    expect(summaryEvent().meta).toMatchObject({
      runs: 2,
      repairs: 1,
      passed: false,
      max_retries: 3,
      stopped: "stalled",
    });
  });

  test("a first session that changed nothing still gets its repair", async () => {
    // The gate judges repairs, not the initial run: a BLOCKED-style first session
    // that only asked questions is exactly the case a repair prompt can rescue.
    const runner = new ScriptedRunner(
      () => {},
      (attempt) => attempt === 2,
    );
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 1", maxRetries: 1 },
    );

    expect(runner.requests).toHaveLength(2);
    expect(result.validation).toMatchObject({ runs: 2, stopped: "budget" });
  });

  test("records how many files each checked session changed", async () => {
    const runner = new ScriptedRunner(
      () => {},
      (attempt) => attempt === 1,
    );
    await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 1", maxRetries: 3 },
    );

    expect(validateEvents().map((e) => e.meta.session_mutations)).toEqual([
      1, 0,
    ]);
  });

  test("tells the second repair session that the first repair already failed", async () => {
    const runner = new ScriptedRunner();
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 1", maxRetries: 2 },
    );

    expect(result.validation).toMatchObject({ ok: false, runs: 3 });
    expect(runner.requests[1].instruction).not.toContain("repair attempt");
    expect(runner.requests[2].instruction).toContain("repair attempt 2 of 2");
    // The last summary carried forward is the most recent one, not the first.
    expect(runner.requests[2].instruction).toContain("summary of attempt 2");
  });

  test("maxRetries 0 validates once and reports without repairing", async () => {
    const runner = new ScriptedRunner();
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 1", maxRetries: 0 },
    );

    expect(result.validation).toMatchObject({
      ok: false,
      runs: 1,
      stopped: "budget",
    });
    expect(runner.requests).toHaveLength(1);
    expect(validateEvents()).toHaveLength(1);
    expect(summaryEvent().meta).toMatchObject({
      runs: 1,
      repairs: 0,
      max_retries: 0,
      stopped: "budget",
    });
  });

  test("does not retry a timeout, since the killed command left no output", async () => {
    // A real 15-minute timeout is not testable, so the result is stubbed; what
    // matters is that carl does not spend another run on a failure it cannot show.
    jest.spyOn(validateModule, "runValidation").mockReturnValue({
      command: "just test",
      ok: false,
      exitCode: null,
      timedOut: true,
      output: "",
      durationMs: 900_000,
    });
    const runner = new ScriptedRunner();

    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "just test", maxRetries: 3 },
    );

    expect(result.validation).toMatchObject({
      ok: false,
      runs: 1,
      stopped: "timeout",
    });
    expect(runner.requests).toHaveLength(1);
    expect(validateEvents()[0].meta.timed_out).toBe(true);
    expect(summaryEvent().meta).toMatchObject({
      timed_out: true,
      stopped: "timeout",
    });
  });

  test("skips validation entirely when the project configured none", async () => {
    const runner = new ScriptedRunner();
    const result = await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
    );

    expect(result.validation).toBeUndefined();
    expect(runner.requests[0].instruction).toContain(
      "configures no validation command",
    );
    expect(eventsOfType("validation")).toHaveLength(0);
  });

  test("logs one validate event per attempt, tied to the run it checked", async () => {
    const runner = new ScriptedRunner();
    await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "exit 4", maxRetries: 1 },
    );

    const events = validateEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.meta.attempt)).toEqual([0, 1]);
    for (const e of events) {
      expect(e.meta.command).toBe("exit 4");
      expect(e.meta.passed).toBe(false);
      expect(e.meta.exit_code).toBe(4);
      expect(e.skill).toBe("code");
    }
    // Each attempt is its own run, so its validate event carries its own run_id.
    expect(new Set(events.map((e) => e.run_id)).size).toBe(2);
  });

  test("tells the first session which command carl will run", async () => {
    const runner = new ScriptedRunner();
    await runSkillWithValidation(
      workspaceRoot,
      "code",
      "build it",
      "test-model",
      "medium",
      runner,
      { command: "just verify", maxRetries: 0 },
    );

    expect(runner.requests[0].instruction).toContain("just verify");
  });
});

describe("resolveValidation", () => {
  test("is undefined when no command is configured", () => {
    expect(resolveValidation({})).toBeUndefined();
    expect(resolveValidation(undefined)).toBeUndefined();
  });

  test("defaults maxRetries when only a command is configured", () => {
    expect(resolveValidation({ validate: "npm test" })).toEqual({
      command: "npm test",
      maxRetries: DEFAULT_MAX_RETRIES,
    });
  });

  test("keeps an explicit maxRetries of 0", () => {
    expect(resolveValidation({ validate: "npm test", maxRetries: 0 })).toEqual({
      command: "npm test",
      maxRetries: 0,
    });
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
        effort: "high",
        efforts: { code: "high", review: "high" },
        models: { code: "opus", review: "haiku" },
      }),
      "utf-8",
    );

    const localConfigDir = path.join(workspaceRoot, ".carl");
    fs.mkdirSync(localConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(localConfigDir, "config.json"),
      JSON.stringify({
        effort: "low",
        efforts: { review: "low" },
        models: { review: "sonnet" },
      }),
      "utf-8",
    );

    const config = loadCarlConfig(workspaceRoot);

    // local field wins
    expect(config.efforts?.review).toBe("low");
    expect(config.models?.review).toBe("sonnet");

    // global field not touched by local survives
    expect(config.efforts?.code).toBe("high");
    expect(config.models?.code).toBe("opus");

    // scalar top-level: local wins
    expect(config.effort).toBe("low");
  });

  function writeGlobal(config: unknown): void {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(config),
      "utf-8",
    );
  }

  function writeLocal(config: unknown): void {
    const localConfigDir = path.join(workspaceRoot, ".carl");
    fs.mkdirSync(localConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(localConfigDir, "config.json"),
      JSON.stringify(config),
      "utf-8",
    );
  }

  test("accepts a validation command and retry budget", () => {
    writeGlobal({ validate: "npm test", maxRetries: 3 });
    const config = loadCarlConfig(workspaceRoot);
    expect(config.validate).toBe("npm test");
    expect(config.maxRetries).toBe(3);
  });

  test.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a number", 1],
    ["an array of commands", ["npm test"]],
  ])('rejects "validate" set to %s', (_label, value) => {
    writeGlobal({ validate: value });
    // An empty command would run a shell that always succeeds, i.e. silently
    // report every run as validated.
    expect(() => loadCarlConfig(workspaceRoot)).toThrow(/Invalid "validate"/);
  });

  test.each([
    ["a string", "2"],
    ["a fraction", 1.5],
    ["a negative count", -1],
  ])('rejects "maxRetries" set to %s', (_label, value) => {
    writeGlobal({ validate: "npm test", maxRetries: value });
    expect(() => loadCarlConfig(workspaceRoot)).toThrow(/Invalid "maxRetries"/);
  });

  test("accepts a large retry budget, which the stall gate bounds anyway", () => {
    writeGlobal({ validate: "npm test", maxRetries: 25 });
    expect(loadCarlConfig(workspaceRoot).maxRetries).toBe(25);
  });

  test("names the file that has the bad value", () => {
    writeGlobal({ validate: "npm test" });
    writeLocal({ maxRetries: -3 });
    expect(() => loadCarlConfig(workspaceRoot)).toThrow(/\.carl\/config\.json/);
  });

  test("keys carl no longer reads are ignored rather than rejected", () => {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        backend: "bedrock",
        backends: { code: "dsh" },
        providers: { bedrock: { region: "us-west-2" } },
        models: { code: "opus" },
      }),
      "utf-8",
    );

    // An existing config.json written by carl 7.x must keep working: the
    // runtime is no longer selectable and its region comes from the model
    // catalog, so these keys are dead, not invalid.
    const config = loadCarlConfig(workspaceRoot);
    expect(config.models?.code).toBe("opus");
  });
});

describe("computeCost", () => {
  test("returns null for unknown model", () => {
    expect(
      computeCost({ source: "bedrock", modelId: "unknown-model-xyz" }),
    ).toBeNull();
  });

  test("returns null when modelId is absent", () => {
    expect(computeCost({ source: "dsh" })).toBeNull();
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

  test("opus 4.x: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5.0, 5);
  });

  test("opus 5.5: input only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-opus-5-5",
      inputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4.0, 5);
  });

  test("opus 5.5: output only", () => {
    const cost = computeCost({
      source: "bedrock",
      modelId: "us.anthropic.claude-opus-5-5",
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(20.0, 5);
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
