import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildSkillInstruction, runPhase } from "./phase";

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
    expect(fs.readFileSync(
      path.join(workspaceRoot, ".agent", "notes", "chat.md"),
      "utf-8",
    )).toBe("chat response");
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
    expect(fs.readFileSync(
      path.join(workspaceRoot, ".agent", "notes", "developer.md"),
      "utf-8",
    )).toBe("dev response");
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

    expect(fs.readFileSync(
      path.join(workspaceRoot, ".agent", "prd.md"),
      "utf-8",
    )).toBe("prd response");
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