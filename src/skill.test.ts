import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSkill, buildSkillInstruction } from "./skill";
import type { AgentRunner, AgentRunRequest, AgentRunResponse } from "./runner";

class MockRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  response: string;

  constructor(response = "# Summary\n\nDone.") {
    this.response = response;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResponse> {
    this.requests.push(req);
    return { text: this.response };
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
});
