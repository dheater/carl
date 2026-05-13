import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSkillInstruction,
  buildPrReviewInstruction,
  runPhase,
  parsePrdPhases,
  markPhaseComplete,
  DEFAULT_MODELS,
} from "./phase";
import type { PrMetadata } from "./github";

jest.mock("@augmentcode/auggie-sdk");

const mockCreate = jest.requireMock("@augmentcode/auggie-sdk").Auggie
  .create as jest.MockedFunction<any>;

describe("runPhase", () => {
  let workspaceRoot: string;
  let logSpy: jest.SpyInstance;

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
  });

  test("skill content omits YAML frontmatter", () => {
    const instruction = buildSkillInstruction("reviewer", workspaceRoot);
    expect(instruction).toContain(
      "# Your skill for this session\n\n# Reviewer",
    );
    expect(instruction).not.toContain("# Your skill for this session\n\n---\n");
    expect(instruction).toContain("# Reviewer");
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

  test("reviewer instruction requires acceptance-criteria validation when prd exists", () => {
    fs.mkdirSync(path.join(workspaceRoot, ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, ".agent", "prd.md"),
      "## Acceptance Criteria\n- ships\n",
      "utf-8",
    );

    const instruction = buildSkillInstruction("reviewer", workspaceRoot);

    expect(instruction).toContain("# PRD acceptance criteria");
    expect(instruction).toContain("source of truth for this review");
    expect(instruction).toContain("[met]");
    expect(instruction).toContain("[gap]");
    expect(instruction).toContain("[unknown]");
  });
});

describe("parsePrdPhases", () => {
  test("returns empty array when no Phases section", () => {
    expect(parsePrdPhases("## Goal\n\nship it\n")).toEqual([]);
  });

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

  test("returns empty array when Phases section has no checkboxes", () => {
    expect(parsePrdPhases("## Phases\n\nTBD\n")).toEqual([]);
  });
});

describe("markPhaseComplete", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-mark-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("marks the specified line complete, leaves others unchanged", () => {
    const prdPath = path.join(tmpDir, "prd.md");
    fs.writeFileSync(
      prdPath,
      "## Phases\n\n- [ ] Phase 1: Setup\n- [ ] Phase 2: Impl\n",
    );
    const phases = parsePrdPhases(fs.readFileSync(prdPath, "utf-8"));
    markPhaseComplete(prdPath, phases[0].lineIndex);
    const updated = fs.readFileSync(prdPath, "utf-8");
    expect(updated).toContain("- [x] Phase 1: Setup");
    expect(updated).toContain("- [ ] Phase 2: Impl");
  });
});


const sampleMetadata: PrMetadata = {
  number: 42,
  title: "Fix the bug",
  body: "Closes #1",
  headSha: "abc1234def5678",
  baseSha: "def5678abc1234",
  baseRef: "main",
  headRef: "fix-bug",
  state: "open",
  commits: [
    { sha: "abc1234def5678", message: "Fix the bug", author: "Alice" },
    { sha: "bcd2345ef06789", message: "Add tests", author: "Bob" },
  ],
};

describe("buildPrReviewInstruction", () => {
  test("includes PR number and title", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("PR #42: Fix the bug");
  });

  test("includes repository owner/repo", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("owner/repo");
  });

  test("includes base and head refs", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("main ← fix-bug");
  });

  test("includes abbreviated head SHA", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("abc1234d");
  });

  test("includes PR body when non-empty", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("Closes #1");
  });

  test("omits PR description section when body is empty", () => {
    const meta = { ...sampleMetadata, body: "" };
    const result = buildPrReviewInstruction("owner", "repo", meta, "diff content");
    expect(result).not.toContain("PR description");
  });

  test("lists commits with sha, author, and message", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toContain("abc1234d");
    expect(result).toContain("Alice");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("Bob");
    expect(result).toContain("Add tests");
  });

  test("notes commits are context only", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "diff content");
    expect(result).toMatch(/context only/i);
  });

  test("includes cumulative diff in a diff code block", () => {
    const result = buildPrReviewInstruction("owner", "repo", sampleMetadata, "--- a/foo\n+++ b/foo\n");
    expect(result).toContain("```diff");
    expect(result).toContain("--- a/foo");
    expect(result).toContain("+++ b/foo");
  });
});

describe("pr-review model and indexing defaults", () => {
  test("DEFAULT_MODELS includes pr-review as code-review", () => {
    expect(DEFAULT_MODELS["pr-review"]).toBe("code-review");
  });

  test("pr-review phase does not allow indexing", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("review output"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    let workspaceRoot: string = "";
    let logSpy: jest.SpyInstance | undefined;
    try {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-pr-review-"));
      logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      await runPhase(workspaceRoot, "pr-review", "pr-review", "prompt", "test-model");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ allowIndexing: false }),
      );
    } finally {
      logSpy?.mockRestore();
      if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
