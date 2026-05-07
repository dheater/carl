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

  async function runCli(args: string[]): Promise<void> {
    const phase = require("./phase") as typeof import("./phase");
    const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
    mockRunPhase.mockResolvedValue({ status: "success", response: "done" });

    process.argv = ["node", "carl", ...args];
    const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/carl-workspace");
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      require("./carl");
      await new Promise((resolve) => setImmediate(resolve));
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  test("passes prompt file content to code", async () => {
    await runCli(["code", promptFile]);

    const phase = require("./phase") as typeof import("./phase");
    const mockRunPhase = phase.runPhase as jest.MockedFunction<typeof phase.runPhase>;
    expect(mockRunPhase).toHaveBeenCalledWith(
      "/tmp/carl-workspace",
      "developer",
      "code",
      "ship it",
      undefined,
    );
  });

});
