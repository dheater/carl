import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StateManager } from "./state";

jest.mock("./loop", () => ({
  runLoop: jest.fn().mockResolvedValue(undefined),
  closeSharedClient: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("child_process", () => ({
  spawnSync: jest.fn(),
}));

const { runLoop, closeSharedClient } = require("./loop");
const { spawnSync } = require("child_process");

describe("carl CLI gate round-trip", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let originalArgv: string[];
  let originalCwd: string;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  const flushCli = async () => {
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const runCli = async (editFile: (current: string) => string) => {
    (spawnSync as jest.Mock).mockImplementation(
      (_editor: string, [tmpFile]) => {
        const current = fs.readFileSync(tmpFile, "utf-8");
        fs.writeFileSync(tmpFile, editFile(current), "utf-8");
        return { status: 0 };
      },
    );

    process.argv = ["node", "carl", "run"];
    jest.isolateModules(() => {
      require("./carl");
    });
    await flushCli();
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-cli-test-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);
    originalArgv = [...process.argv];
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    (runLoop as jest.Mock).mockResolvedValue(undefined);
    (closeSharedClient as jest.Mock).mockResolvedValue(undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      });
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    jest.clearAllMocks();
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("unchanged slice-plan buffer advances to developer", async () => {
    const slicePlan = "# Feature\n\n## [ ] t-1: Build thing\n\nAC:\n- It works";
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: slicePlan,
        },
      ],
    });

    await runCli((current) => current);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");
    expect(state.pending_reply).toBeUndefined();
  });

  test("unchanged architect question buffer is fed back as reply", async () => {
    const question = "## Question\n\nUse repo root?";
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: question,
        },
      ],
    });

    await runCli((current) => current);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");
    expect(state.pending_reply).toBe(question);
  });

  test("approved marker added to architect question buffer is fed back as reply", async () => {
    const question = "## Question\n\nUse repo root?";
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: question,
        },
      ],
    });

    await runCli((current) => `${current}\n\napproved\n`);

    const state = stateManager.load();
    expect(state.pending_reply).toBe(`${question}\n\napproved`);
  });

  test("inline annotated feedback uses reply path through the CLI", async () => {
    const question = "## Question\n\nUse repo root?";
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: question,
        },
      ],
    });

    await runCli((current) =>
      current.replace("Use repo root?", "Use repo root?\n\n- repo: ./api"),
    );

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");
    expect(state.pending_reply).toBe(
      "## Question\n\nUse repo root?\n\n- repo: ./api",
    );
  });
});
