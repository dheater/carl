import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("./phase", () => ({
  runPhase: jest.fn(),
  DEFAULT_MODELS: {
    architect: "gpt5.4",
    developer: "sonnet4.6",
    reviewer: "sonnet4.6",
    chat: "gpt5.4",
  },
  parsePrdPhases: jest.requireActual("./phase").parsePrdPhases,
  markPhaseComplete: jest.requireActual("./phase").markPhaseComplete,
}));

describe("carl CLI", () => {
  const originalArgv = process.argv;
  let promptFile: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    promptFile = path.join(os.tmpdir(), `carl-prompt-${Date.now()}.md`);
    fs.writeFileSync(promptFile, "ship it\n", "utf-8");
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
    if (fs.existsSync(promptFile)) {
      fs.unlinkSync(promptFile);
    }
  });

  async function runCli(
    args: string[],
    opts: { cwd?: string; runPhaseResult?: { status: "success" | "blocked"; response: string } } = {},
  ): Promise<jest.MockedFunction<typeof import("./phase").runPhase>> {
    const cwd = opts.cwd ?? "/tmp/carl-workspace";
    const phase = require("./phase") as typeof import("./phase");
    const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
    mockRunPhase.mockResolvedValue(opts.runPhaseResult ?? { status: "success", response: "done" });

    process.argv = ["node", "carl", ...args];
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(cwd);
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      require("./carl");
      await new Promise((resolve) => setImmediate(resolve));
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    return mockRunPhase;
  }

  test("passes prompt file content to code", async () => {
    const mockRunPhase = await runCli(["code", promptFile]);
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "developer",
      "code",
      "ship it",
      undefined,
    );
  });

  test("passes prompt file content to chat", async () => {
    const mockRunPhase = await runCli(["chat", promptFile]);
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "chat",
      "chat",
      "ship it",
      undefined,
    );
  });

  describe("code with PRD phases", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-prd-cli-"));
      fs.mkdirSync(path.join(tmpDir, ".agent"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("runs first incomplete phase and marks it complete", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [ ] Phase 1: Setup\n- [ ] Phase 2: Impl\n");

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        expect.stringContaining("Phase 1: Setup"),
        undefined,
      );
      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [x] Phase 1: Setup");
      expect(prd).toContain("- [ ] Phase 2: Impl");
    });

    test("skips already-complete phases and runs the next one", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [x] Phase 1: Setup\n- [ ] Phase 2: Impl\n");

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).toHaveBeenCalledWith(
        tmpDir,
        "developer",
        "code",
        expect.stringContaining("Phase 2: Impl"),
        undefined,
      );
      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [x] Phase 2: Impl");
    });

    test("does not mark phase complete when developer is blocked", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [ ] Phase 1: Setup\n");

      await runCli(["code"], { cwd: tmpDir, runPhaseResult: { status: "blocked", response: "BLOCKED: missing info" } });

      const prd = fs.readFileSync(prdPath, "utf-8");
      expect(prd).toContain("- [ ] Phase 1: Setup");
    });

    test("does nothing when all phases are complete", async () => {
      const prdPath = path.join(tmpDir, ".agent", "prd.md");
      fs.writeFileSync(prdPath, "## Phases\n\n- [x] Phase 1: Setup\n- [x] Phase 2: Impl\n");

      const mockRunPhase = await runCli(["code"], { cwd: tmpDir });

      expect(mockRunPhase).not.toHaveBeenCalled();
    });
  });

});
