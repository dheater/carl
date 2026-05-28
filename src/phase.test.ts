import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSkillInstruction,
  runPhase,
  parsePrdPhases,
  DEFAULT_MODELS,
} from "./phase";

jest.mock("@augmentcode/auggie-sdk");

const mockCreate = jest.requireMock("@augmentcode/auggie-sdk").Auggie
  .create as jest.MockedFunction<any>;

describe("runPhase", () => {
  let workspaceRoot: string;
  let logSpy: jest.SpyInstance;

  function readEvents(): any[] {
    return fs
      .readFileSync(path.join(workspaceRoot, ".carl", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  function readPhaseEvent(): any {
    return readEvents().find((event) => event.event === "phase");
  }

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-phase-"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockCreate.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("starts chat without eager repo indexing", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("chat response"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "chat",
      "chat",
      "hello",
      "test-model",
    );

    expect(result).toEqual({ status: "success", response: "chat response" });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceRoot,
      model: "test-model",
      allowIndexing: false,
    });
    expect(logSpy).toHaveBeenCalledWith("  [System] Initializing agent...");
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, ".agent", "notes", "chat.md"),
        "utf-8",
      ),
    ).toBe("chat response");
  });

  test("indexes developer sessions by default", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("dev response"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "developer",
      "code",
      "ship it",
      "test-model",
    );

    expect(result).toEqual({ status: "success", response: "dev response" });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceRoot,
      model: "test-model",
      allowIndexing: true,
    });
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, ".agent", "notes", "developer.md"),
        "utf-8",
      ),
    ).toBe("dev response");

    expect(readPhaseEvent().meta).toMatchObject({
      status: "success",
      blocked_reason: null,
      error_type: null,
      retry_count: 0,
      interview_triggered: false,
      output_path: ".agent/notes/developer.md",
      output_exists: true,
    });
  });

  test("writes verify output to .agent/notes/verify.md", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("verify response"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "verify",
      "verify",
      undefined,
      "test-model",
    );

    expect(result).toEqual({ status: "success", response: "verify response" });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceRoot,
      model: "test-model",
      allowIndexing: true,
    });
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, ".agent", "notes", "verify.md"),
        "utf-8",
      ),
    ).toBe("verify response");
  });

  test("writes architect output to .agent/prd.md", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("prd response"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    await runPhase(
      workspaceRoot,
      "architect",
      "plan",
      "design it",
      "test-model",
    );

    expect(
      fs.readFileSync(path.join(workspaceRoot, ".agent", "prd.md"), "utf-8"),
    ).toBe("prd response");
  });

  test("writes blocked architect output to .agent/notes/architect.md", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest
        .fn()
        .mockResolvedValue("# Interview\n\n1. **Question?**\n\n   >\n"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "architect",
      "plan",
      "design it",
      "test-model",
    );

    expect(result.status).toBe("blocked");
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, ".agent", "notes", "architect.md"),
        "utf-8",
      ),
    ).toContain("# Interview");
    expect(fs.existsSync(path.join(workspaceRoot, ".agent", "prd.md"))).toBe(
      false,
    );
  });

  test("does not persist pr-reviewer state outside .agent/pr-review.md", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("review draft updated"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "pr-reviewer",
      "pr-review",
      "review this pr",
      "test-model",
    );

    expect(result).toEqual({ status: "success", response: "review draft updated" });
    expect(
      fs.existsSync(path.join(workspaceRoot, ".agent", "notes", "pr-reviewer.md")),
    ).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, ".carl", "config.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(workspaceRoot, ".carl", "events.jsonl"))).toBe(
      false,
    );
  });

  test("treats interview responses as blocked", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest
        .fn()
        .mockResolvedValue("# Interview\n\n1. **Question?**\n\n   >\n"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    const result = await runPhase(
      workspaceRoot,
      "developer",
      "code",
      "ship it",
      "test-model",
    );

    expect(result.status).toBe("blocked");
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, ".agent", "notes", "developer.md"),
        "utf-8",
      ),
    ).toContain("# Interview");
    expect(readPhaseEvent().meta).toMatchObject({
      status: "blocked",
      blocked_reason: "interview",
      error_type: null,
      interview_triggered: true,
      output_path: ".agent/notes/developer.md",
      output_exists: true,
    });
  });

  test("logs error phase metadata when the prompt fails", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockRejectedValue(new Error("boom")),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    await expect(
      runPhase(
        workspaceRoot,
        "developer",
        "code",
        "ship it",
        "test-model",
        { prdPhaseTitle: "Phase 1: Ship it" },
      ),
    ).rejects.toThrow("boom");

    expect(readPhaseEvent().meta).toMatchObject({
      status: "error",
      blocked_reason: null,
      error_type: "exception",
      retry_count: 0,
      interview_triggered: false,
      output_exists: false,
      prd_phase_title: "Phase 1: Ship it",
    });
  });

  test("reviewer skill content omits YAML frontmatter", () => {
    const instruction = buildSkillInstruction("reviewer", workspaceRoot);
    expect(instruction).not.toContain("# Your skill for this session\n\n---\n");
    expect(instruction).toContain("# Reviewer");
  });

  test("chat includes code-review rules only for explicit review requests", () => {
    const defaultInstruction = buildSkillInstruction("chat", workspaceRoot, "ship it");
    const reviewInstruction = buildSkillInstruction(
      "chat",
      workspaceRoot,
      "review code in this repo",
    );

    expect(defaultInstruction).not.toContain("# Code Review");
    expect(reviewInstruction).toContain("# Code Review");
  });

  test("architect instruction allows repeated interviews before writing the PRD", () => {
    const instruction = buildSkillInstruction("architect", workspaceRoot);

    expect(instruction).toContain(
      "If clarification is still missing, output another `# Interview`",
    );
    expect(instruction).toContain(
      "When the request is clear enough, replace `.agent/prd.md` entirely with a complete PRD",
    );
  });
});

describe("parsePrdPhases", () => {
  test("parses unchecked and checked phases", () => {
    const prd = "## Phases\n\n- [ ] Phase 1: Setup\n- [x] Phase 2: Impl\n";
    const phases = parsePrdPhases(prd);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({
      title: "Phase 1: Setup",
      completed: false,
    });
    expect(phases[1]).toMatchObject({
      title: "Phase 2: Impl",
      completed: true,
    });
  });

  test("stops at next ## section", () => {
    const prd =
      "## Phases\n\n- [ ] Phase 1: Go\n\n## Risks\n\n- [ ] not a phase\n";
    expect(parsePrdPhases(prd)).toHaveLength(1);
  });
});



