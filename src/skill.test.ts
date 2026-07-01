import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSkill, buildSkillInstruction } from "./skill";
import type { AgentRunner, AgentRunRequest, AgentRunResponse } from "./runner";

class MockRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  response: string;
  usage?: Record<string, unknown>;

  constructor(
    response = "# Summary\n\nDone.",
    usage?: Record<string, unknown>,
  ) {
    this.response = response;
    this.usage = usage;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResponse> {
    this.requests.push(req);
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

  test("appends usage summary with token counts to output file", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("Completed in");
    expect(content).toContain("1,000in / 500out tokens");
  });

  test("omits token line in output file when outputTokens is missing", async () => {
    const runner = new MockRunner("# Summary\n\nDone.", {
      inputTokens: 1000,
    });
    await runSkill(workspaceRoot, "review", undefined, "test-model", runner);

    const outputPath = path.join(workspaceRoot, ".agent/notes/review.md");
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("Completed in");
    expect(content).not.toContain("tokens");
  });
});
