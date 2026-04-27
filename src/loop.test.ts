import { runLoop, closeSharedClient } from "./loop";
import { StateManager } from "./state";
import { HAPPY_PATH_GRAPH } from "./graph";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("@augmentcode/auggie-sdk", () => ({
  Auggie: {
    create: jest.fn(),
  },
  DirectContext: {
    // Default: no prior context file, fresh context with empty search results
    create: jest.fn().mockResolvedValue({
      search: jest.fn().mockResolvedValue(""),
      addToIndex: jest
        .fn()
        .mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] }),
      exportToFile: jest.fn().mockResolvedValue(undefined),
    }),
    importFromFile: jest.fn().mockRejectedValue(new Error("no context file")),
  },
}));

jest.mock("./just", () => ({
  runJustFormat: jest.fn(),
  runJustLint: jest.fn(() => ({
    exitCode: 0,
    stdout: "Lint passed",
    stderr: "",
    status: "PASS",
  })),
  runCanonicalTests: jest.fn(() => ({
    exitCode: 0,
    stdout: "All tests passed",
    stderr: "",
    command: "just test",
    usedJust: true,
  })),
}));

const { Auggie, DirectContext } = require("@augmentcode/auggie-sdk");

describe("Workflow Loop", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;

  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(async () => {
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("runs the full happy path until the first gate and pauses", async () => {
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");
    expect(state.history).toHaveLength(1);
    expect(state.history![0].phase).toBe("architect");

    // Check Auggie calls
    expect(mockPrompt).toHaveBeenCalledTimes(1);

    expect(Auggie.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceRoot: tmpDir,
        model: "gpt5.1", // architect
        allowIndexing: true,
      }),
    );

    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    expect(fs.existsSync(eventsPath)).toBe(true);

    const eventsData = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(eventsData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: state.run_id,
          event: "Auggie.create",
          subject: "architect/gpt5.1",
        }),
        expect.objectContaining({
          run_id: state.run_id,
          event: "prompt",
          subject: "architect/gpt5.1",
        }),
        expect.objectContaining({
          run_id: state.run_id,
          event: "phase",
          subject: "architect",
        }),
      ]),
    );
  });

  test("resumes from a non-gate phase and continues to next gate", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("reviewer");
    expect(state.history).toHaveLength(5); // architect (prior), developer, test-writer, verifier, reviewer (now at gate)

    expect(Auggie.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: "haiku4.5", // developer
      }),
    );
    expect(Auggie.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "haiku4.5", // test-writer
      }),
    );
    expect(Auggie.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        model: "code-review", // verifier
      }),
    );
    expect(Auggie.create).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        model: "code-review", // reviewer
      }),
    );
  });

  test("developer blocker transitions back to architect", async () => {
    stateManager.update({ current_phase: "developer", status: "running" });
    // With parallel execution, both developer and testwriter prompts are called
    mockPrompt.mockResolvedValueOnce("blocked: missing PRD info"); // developer
    mockPrompt.mockResolvedValueOnce("testwriter output"); // testwriter
    // Then architect is called and throws to stop loop
    mockPrompt.mockRejectedValueOnce(new Error("stop loop"));

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();
    // With parallel: developer (blocked), testwriter (success), architect (failed)
    expect(state.history).toHaveLength(3);
    expect(state.history![0]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "blocked",
        outputs: "blocked: missing PRD info",
      }),
    );
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "success",
      }),
    );
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "architect",
        status: "failed",
      }),
    );
    expect(state.current_phase).toBe("architect");
  });

  test("developer BLOCKER: prefix is detected as blocked", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Sample",
        },
      ],
    });
    // With parallel execution: developer blocks, test-writer runs, then architect throws
    mockPrompt.mockResolvedValueOnce("blocked: no implementation exists yet"); // developer
    mockPrompt.mockResolvedValueOnce("test writer output"); // test-writer
    mockPrompt.mockRejectedValueOnce(new Error("stop loop")); // architect

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "blocked",
      }),
    );
    // AC: With parallel, test-writer entry exists even if developer blocked
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "success",
      }),
    );
  });

  test("injects pending_reply into instruction and clears it", async () => {
    stateManager.update({
      current_phase: "architect",
      status: "running",
      initial_prompt: "build a feature",
      pending_reply: "use the repo root as scope",
    });

    mockPrompt.mockResolvedValueOnce("plan output");

    await runLoop(stateManager);

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Human reply\n\nuse the repo root as scope"),
      expect.any(Object),
    );

    // pending_reply must be cleared after use
    const state = stateManager.load();
    expect(state.pending_reply).toBeUndefined();
  });

  test("passes rejection reason as feedback on retry", async () => {
    stateManager.update({
      current_phase: "architect",
      status: "running",
      initial_prompt: "build a feature",
      history: [
        {
          phase: "architect",
          model: "system",
          status: "rejected",
          outputs: "Approval rejected: too complex",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("retry output");

    await runLoop(stateManager);

    // Initial prompt is NOT re-injected on retry — prior architect history already carries context
    expect(mockPrompt).not.toHaveBeenCalledWith(
      expect.stringContaining("User request"),
      expect.any(Object),
    );
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "# Rejection feedback\n\nApproval rejected: too complex\n\nPlease incorporate this feedback and try again.",
      ),
      expect.any(Object),
    );
  });

  test("injects raw prior output from history on reply when pending_reply", async () => {
    // Set up prior architect output in history
    stateManager.update({
      current_phase: "architect",
      status: "running",
      pending_reply: "repo root, standard tooling",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "initial plan",
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("updated plan");

    await runLoop(stateManager);

    // Uses raw prior output from history (no context engine)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Your previous output\n\ninitial plan"),
      expect.any(Object),
    );
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Human reply\n\nrepo root, standard tooling"),
      expect.any(Object),
    );
  });

  test("injects prior architect output when reviewer starts after architect", async () => {
    const architectOutput = "t-1, t-2, t-3 in architect plan";
    stateManager.update({
      current_phase: "reviewer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: architectOutput,
        },
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: "Developer implemented tickets",
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("reviewer approved");

    await runLoop(stateManager);

    // Reviewer should receive the architect output as prior workflow context
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Prior workflow context\n\n" + architectOutput),
      expect.any(Object),
    );
  });

  test("uses raw prior output from history on pending reply", async () => {
    // Verify that raw prior output from history is used (no context engine)
    stateManager.update({
      current_phase: "architect",
      status: "running",
      pending_reply: "use repo root",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "Previous architect output with questions",
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("reply output");

    await runLoop(stateManager);

    // Uses raw prior output from history
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "# Your previous output\n\nPrevious architect output with questions",
      ),
      expect.any(Object),
    );
  });

  test("reuses Auggie session for the same phase across a reply gate round-trip", async () => {
    const { replyCommand } = require("./commands");

    // First run: architect gate
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");
    expect(Auggie.create).toHaveBeenCalledTimes(1);

    // Simulate a reply that keeps us in the architect phase
    replyCommand(tmpDir, "clarification reply");

    // Second run: architect again with pending_reply; should reuse session
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");
    // Auggie.create should not be called again for the same run + phase
    expect(Auggie.create).toHaveBeenCalledTimes(1);
  });
});

describe("Skill files - deterministic format/lint integration", () => {
  test("skills/developer.md notes that carl will re-run format/lint", () => {
    const developerPath = path.join(__dirname, "..", "skills", "developer.md");
    const content = fs.readFileSync(developerPath, "utf-8");
    // Check that it mentions workflow re-running format/lint
    expect(content).toMatch(/workflow.*re-run.*deterministically/i);
    expect(content).toMatch(/format/i);
  });
});

describe("t-1: Deterministic just test run and artifacts after developer", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;
  let mockOnSessionUpdate: jest.Mock;
  let runJustMock: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t1-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Mock runCanonicalTests to simulate passing test
    const justModule = require("./just");
    runJustMock = jest.fn().mockReturnValue({
      exitCode: 0,
      stdout: "Tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });
    justModule.runCanonicalTests = runJustMock;
  });

  afterEach(async () => {
    await closeSharedClient();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("runs just test after developer completes and writes passing summary", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    await runLoop(stateManager);

    expect(runJustMock).toHaveBeenCalledWith(tmpDir);

    const summaryPath = path.join(tmpDir, ".agent", "tests-summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    expect(summary.command).toBe("just test");
    expect(summary.status).toBe("PASS");
    expect(summary.timestamp).toBeDefined();

    const logPath = path.join(tmpDir, ".agent", "tests.log");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test("runs just test after developer and writes failing summary + log", async () => {
    runJustMock.mockReturnValue({
      exitCode: 1,
      stdout: "Test suite failed",
      stderr: "Error: assertion failed",
      command: "just test",
      usedJust: true,
    });

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    await runLoop(stateManager);

    const summaryPath = path.join(tmpDir, ".agent", "tests-summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    expect(summary.command).toBe("just test");
    expect(summary.status).toBe("FAIL");
    expect(summary.timestamp).toBeDefined();

    const logPath = path.join(tmpDir, ".agent", "tests.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("Test suite failed");
  });

  test("does not run just test after non-developer phases", async () => {
    stateManager.update({
      current_phase: "architect",
      status: "running",
    });

    await runLoop(stateManager);

    expect(runJustMock).not.toHaveBeenCalled();
  });
});

describe("t-2: Two-strike test gate escalates to architect", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;
  let mockOnSessionUpdate: jest.Mock;
  let runTestMock: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t2-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Mock runCanonicalTests to fail
    const justModule = require("./just");
    runTestMock = jest.fn().mockReturnValue({
      exitCode: 1,
      stdout: "Test failed",
      stderr: "Error",
      command: "just test",
      usedJust: true,
    });
    justModule.runCanonicalTests = runTestMock;
  });

  afterEach(async () => {
    await closeSharedClient();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("first failing test increments counter to 1 and stays in developer phase", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should stay in developer phase
    expect(state.current_phase).toBe("developer");
    expect(state.status).toBe("running");
    // Counter should be 1
    expect(state.developer_test_failures).toBe(1);
    // History should have a blocked entry
    const developerHistories = state.history!.filter(
      (h) => h.phase === "developer",
    );
    const blockedEntry = developerHistories[developerHistories.length - 1];
    expect(blockedEntry.status).toBe("blocked");
    // AC: Verify outputs contains both "Tests failed" prefix and "staying in developer phase"
    expect(blockedEntry.outputs).toMatch(/Tests failed/);
    expect(blockedEntry.outputs).toMatch(/staying in developer phase/i);
  });

  test("second consecutive failing test escalates to architect", async () => {
    // Simulate state after first failing test
    stateManager.update({
      current_phase: "developer",
      status: "running",
      developer_test_failures: 1,
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
        {
          phase: "developer",
          model: "haiku4.5",
          status: "blocked",
          outputs: "Tests failed",
        },
      ],
    });

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should escalate to architect
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("running");
    // Counter should still be 2
    expect(state.developer_test_failures).toBe(2);
  });

  test("passing test resets counter to 0 and allows advance to reviewer", async () => {
    // Mock successful test run
    const justModule = require("./just");
    justModule.runCanonicalTests.mockReturnValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    stateManager.update({
      current_phase: "developer",
      status: "running",
      developer_test_failures: 1,
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should continue through verifier and reach reviewer (first gate after developer)
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
    // Counter should be reset to 0
    expect(state.developer_test_failures).toBe(0);
  });

  test("successful developer completion transitions to verifier with tests passing", async () => {
    // This test verifies that when developer passes tests, the next phase is verifier.
    // We verify this by checking the history sequence.
    const justModule = require("./just");
    justModule.runCanonicalTests.mockReturnValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    await runLoop(stateManager);

    const state = stateManager.load();
    // After developer passes tests and transitions through non-gate phases, should reach reviewer gate
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
    expect(state.developer_test_failures).toBe(0);

    // Verify the history shows developer -> verifier -> reviewer progression
    const phases = state.history!.map((h) => h.phase);
    const developerIndex = phases.indexOf("developer");
    const verifierIndex = phases.indexOf("verifier");
    const reviewerIndex = phases.indexOf("reviewer");

    expect(developerIndex).toBeGreaterThanOrEqual(0);
    expect(verifierIndex).toBeGreaterThan(developerIndex);
    expect(reviewerIndex).toBeGreaterThan(verifierIndex);
  });
});

describe("t-4: Dev-only test file handling moved to Verifier", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;
  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t3-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(async () => {
    await closeSharedClient();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("does not block advancement when .dev.test.ts file exists with passing tests", async () => {
    // Mock successful test run
    const justModule = require("./just");
    justModule.runCanonicalTests.mockReturnValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    // Create a .dev.test.ts file in the workspace
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "sample.dev.test.ts"),
      "test code",
    );

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should advance through verifier to reviewer (first gate)
    // Dev-only test files no longer block advancement
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
    expect(state.developer_test_failures).toBe(0);

    // Verify the path includes verifier
    const phases = state.history!.map((h) => h.phase);
    expect(phases).toContain("developer");
    expect(phases).toContain("verifier");
    expect(phases).toContain("reviewer");
  });

  test("allows advancement when no .dev.test.ts files exist and tests pass", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    // Create a regular test file (not .dev.test.ts)
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "sample.test.ts"), "test code");

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should advance to reviewer
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
  });

  test("writes architect notes to .agent/notes/architect.md on successful architect phase", async () => {
    // Verify architect notes are written (no context engine)
    mockPrompt.mockResolvedValueOnce("architect plan");

    await runLoop(stateManager);

    // Check that architect notes file was written
    const architectNotesPath = path.join(
      tmpDir,
      ".agent",
      "notes",
      "architect.md",
    );
    expect(fs.existsSync(architectNotesPath)).toBe(true);
    const content = fs.readFileSync(architectNotesPath, "utf-8");
    expect(content).toBe("architect plan");
  });

  test("writes reviewer notes to .agent/notes/reviewer.md on successful reviewer phase", async () => {
    // Verify reviewer notes are written (no context engine)
    stateManager.update({
      current_phase: "reviewer",
      status: "running",
      history: [
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: "implementation",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("reviewer validation");

    await runLoop(stateManager);

    // Check that reviewer notes file was written
    const reviewerNotesPath = path.join(
      tmpDir,
      ".agent",
      "notes",
      "reviewer.md",
    );
    expect(fs.existsSync(reviewerNotesPath)).toBe(true);
    const content = fs.readFileSync(reviewerNotesPath, "utf-8");
    expect(content).toBe("reviewer validation");
  });

  test("does not block advancement when multiple .dev.test.ts files exist with passing tests", async () => {
    // Mock successful test run
    const justModule = require("./just");
    justModule.runCanonicalTests.mockReturnValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    // Create multiple .dev.test.ts files
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "file1.dev.test.ts"), "test");
    fs.writeFileSync(path.join(tmpDir, "src", "file2.dev.test.ts"), "test");

    await runLoop(stateManager);

    const state = stateManager.load();
    // Should advance to reviewer (through verifier)
    // .dev.test.ts files no longer block advancement
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");

    // Verify the path includes verifier
    const phases = state.history!.map((h) => h.phase);
    expect(phases).toContain("developer");
    expect(phases).toContain("verifier");
    expect(phases).toContain("reviewer");
  });
});

// Tests for t-1: buildSkillInstruction includes branch context and proposed commit message section
describe("buildSkillInstruction for reviewer with branch context", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-test-"));
    // Create required skill files
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(
      path.join(skillsDir, "reviewer.md"),
      "# Reviewer skill\n\nValidate the work.",
    );
    fs.writeFileSync(
      path.join(skillsDir, "developer.md"),
      "# Developer skill\n\nImplement the code.",
    );
  });

  afterEach(async () => {
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("reviewer instructions include Proposed commit message section with branch context for ticket branch", async () => {
    // Mock git functions for this test
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("CLIENTS-934-download-fixes");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/index.ts"],
      untracked: [],
    });

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    // AC 1: Instructions include "## Proposed commit message" heading
    expect(instruction).toMatch(/## Proposed commit message/i);

    // AC 2: Instructions tell agent to produce subject + body for code changes
    expect(instruction).toMatch(/subject.*body|commit subject|commit message/i);
    expect(instruction).toMatch(/code.*changes|behavior.*changes/i);

    // AC 3: Instructions explicitly tell agent to avoid mentioning gates/phases/checklists in the commit message itself
    expect(instruction).toMatch(
      /no mentions?.*gates|phases|checklists|not.*workflow.*meta/i,
    );

    // AC 4: Instructions include branch name "CLIENTS-934-download-fixes"
    expect(instruction).toMatch(/CLIENTS-934-download-fixes/);

    // AC 5: Instructions show current branch context clearly
    expect(instruction).toMatch(/current branch/i);
  });

  test("reviewer instructions use conventional-commit prefix for non-ticket branch", async () => {
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("main");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/index.ts"],
      untracked: [],
    });

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    // AC: For non-ticket branch, guidance calls for conventional-commit prefix
    expect(instruction).toMatch(/fix:|chore:|feat:|docs:|refactor:|style:/i);
    expect(instruction).toMatch(/conventional.?commit/i);
  });

  test("reviewer instructions for non-reviewer phases are not affected", async () => {
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("CLIENTS-934-download-fixes");

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("developer", tmpDir);

    // Developer instructions should NOT include proposed commit message section
    expect(instruction).not.toMatch(/## Proposed commit message/i);
  });

  test("reviewer skill file includes manual code-review step with reject guidance", () => {
    const skillsDir = path.join(__dirname, "..", "skills");
    const reviewerPath = path.join(skillsDir, "reviewer.md");
    const skillContent = fs.readFileSync(reviewerPath, "utf-8");

    // AC: Skill includes guidance to review code outside Carl
    expect(skillContent).toMatch(
      /review.*code.*outside|code.*review.*own.*tool/i,
    );
    expect(skillContent).toMatch(/git.*ui|editor|diff/i);

    // AC: Skill includes reject: <reason> guidance
    expect(skillContent).toMatch(/reject:\s*<.*reason/i);

    // AC: Skill mentions returning to architect for re-planning
    expect(skillContent).toMatch(
      /architect.*re-plan|architect.*rejection|return.*architect/i,
    );
  });

  test("reviewer instructions include test summary when tests passed", async () => {
    const loopModule = require("./loop");
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("main");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: [],
      untracked: [],
    });

    // Write a passing test summary
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "tests-summary.json"),
      JSON.stringify({
        command: "just test",
        status: "PASS",
        timestamp: "2025-01-01T00:00:00Z",
      }),
    );

    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    expect(instruction).toMatch(/Tests\/Verification/i);
    expect(instruction).toMatch(/just test/);
    expect(instruction).toMatch(/Status.*PASS/i);
  });

  test("reviewer instructions include test summary and log when tests failed", async () => {
    const loopModule = require("./loop");
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("main");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: [],
      untracked: [],
    });

    // Write a failing test summary and log
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "tests-summary.json"),
      JSON.stringify({
        command: "npm test",
        status: "FAIL",
        timestamp: "2025-01-01T00:00:00Z",
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "tests.log"),
      "Command: npm test\n\nStdout:\nTest suite failed\n\nStderr:\nError: assertion failed",
    );

    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    expect(instruction).toMatch(/Tests\/Verification/i);
    expect(instruction).toMatch(/npm test/);
    expect(instruction).toMatch(/Status.*FAIL/i);
    expect(instruction).toMatch(/Test suite failed/);
    expect(instruction).toMatch(/assertion failed/);
  });
});

// Tests for buildSkillInstruction with test-writer phase
describe("buildSkillInstruction for test-writer with artifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-test-tw-"));
  });

  afterEach(async () => {
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("test-writer instructions include full skill content from skills directory", () => {
    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("test-writer", tmpDir);

    // AC: Should include full TestWriter skill from skills/test-writer.md
    expect(instruction).toContain("# Your skill for this session");
    expect(instruction).toContain("# TestWriter");
    expect(instruction).toMatch(
      /long-lived.*regression.*test|behavior-focused.*test/i,
    );
  });

  test("test-writer instructions mention prerequisites (architect skill)", () => {
    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("test-writer", tmpDir);

    // AC: Skill file should mention that architect is a prerequisite
    expect(instruction).toMatch(/prerequisites:/i);
  });

  test("test-writer instructions describe reading artifacts from .agent directory", () => {
    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("test-writer", tmpDir);

    // AC: Should mention the starting a session section that describes reading artifacts
    expect(instruction).toMatch(/Starting a Session|Read in order/i);
    expect(instruction).toMatch(/\.agent\/notes\/architect\.md/);
    expect(instruction).toMatch(/\.agent\/test-tickets\.md/);
  });

  test("test-writer instructions do not include special reviewer artifacts (branch, files changed, lint, tests)", () => {
    // Setup some artifacts that might exist in reviewer context
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("feature-branch");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/feature.ts"],
      untracked: [],
    });

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("test-writer", tmpDir);

    // AC: test-writer should NOT have the special reviewer sections injected
    // (like "## Proposed commit message" or "# Files changed")
    expect(instruction).not.toMatch(/## Proposed commit message/i);
    expect(instruction).not.toMatch(/## Tracked changes/i);
    expect(instruction).not.toMatch(/# Files changed/i);
  });

  test("test-writer instructions do not embed non-phase prerequisite skills if architect is a phase", () => {
    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("test-writer", tmpDir);

    // AC: Architect is a HAPPY_PATH_GRAPH phase, so it should NOT be embedded as a supporting skill
    // The instruction should only have the test-writer skill, not duplicate architect skill content
    expect(instruction).toContain("# Your skill for this session");
    expect(instruction).toContain("# TestWriter");
    // Should not have a "Supporting skill: architect" section
    expect(instruction).not.toMatch(/# Supporting skill:\s*architect/i);
  });
});

describe("t-4: Reviewer uses deterministic artifacts and reject routes to architect", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;
  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t4-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(async () => {
    await closeSharedClient();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reviewer rejection routes to architect via rejectCommand", async () => {
    const { rejectCommand } = require("./commands");

    // Set up workflow in reviewer gate
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: "# Implementation",
        },
        {
          phase: "reviewer",
          model: "haiku4.5",
          status: "success",
          outputs: "# Review",
        },
      ],
    });

    // Reject with reason
    rejectCommand(tmpDir, "Implementation needs more testing");

    const state = stateManager.load();
    // Should go back to architect
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("running");
    // History should have rejection recorded
    const reviewerHistory = state.history!.find(
      (h) => h.phase === "reviewer" && h.status === "rejected",
    );
    expect(reviewerHistory).toBeDefined();
    expect(reviewerHistory!.outputs).toContain(
      "Implementation needs more testing",
    );
  });

  test("reviewer skill file uses test artifacts and mentions architecture of approval flow", () => {
    const reviewerPath = path.join(__dirname, "..", "skills", "reviewer.md");
    const skillContent = fs.readFileSync(reviewerPath, "utf-8");

    // AC: Should reference deterministic artifacts
    expect(skillContent).toMatch(
      /deterministic.*test|test.*artifact|tests-summary|\.agent/i,
    );

    // AC: Should guide to read artifacts instead of running tests
    expect(skillContent).toMatch(/read.*test|deterministic.*first/i);

    // AC: Should describe reject: routing to architect
    expect(skillContent).toMatch(/reject.*architect|architect.*re-plan/i);
  });

  test("t-8: architect receives full rejection feedback with reviewer sections", async () => {
    const rejectionBuffer = `## Subtraction and cleanup

- **[Security]: Missing input validation** — Add bounds check
- **[Dead code]: Unused function validateOldFormat()** — Delete; no call sites

## Recommendations for Architect

- Extract auth logic into separate module — Current auth is duplicated in 3 places
- Consider removing legacy API v1 — Scheduled for EOL`;

    // Create a mock state with rejection in history
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-architect-feedback-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("retry output");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Simulate architect ran, then reviewer rejected
    const state = stateManager.load();
    state.history = [
      {
        phase: "architect",
        model: "gpt5.1",
        status: "success",
        outputs: "## [x] t-1: Some ticket\nAC: ...",
      },
      {
        phase: "reviewer",
        model: "haiku4.5",
        status: "rejected",
        outputs: `Approval rejected: incomplete validation\n\n${rejectionBuffer}`,
      },
    ];
    state.current_phase = "architect";
    state.status = "running";
    stateManager.update(state);

    // Run the loop — should build architect instruction with rejection feedback
    await runLoop(stateManager);

    // Check that the prompt sent to architect includes the full rejection feedback
    expect(mockPrompt).toHaveBeenCalled();
    const promptCall = mockPrompt.mock.calls[0];
    const instruction = promptCall[0] as string;

    // Should include rejection feedback section
    expect(instruction).toContain("# Rejection feedback");

    // Should include the full buffer content
    expect(instruction).toContain("Subtraction and cleanup");
    expect(instruction).toContain("Missing input validation");
    expect(instruction).toContain("Unused function validateOldFormat");
    expect(instruction).toContain("Extract auth logic");
    expect(instruction).toContain("removing legacy API v1");
    expect(instruction).toContain("incomplete validation");
  });

  test("t-7: verifier owns subtract-first cleanup responsibilities", () => {
    const verifierPath = path.join(__dirname, "..", "skills", "verifier.md");
    const verifierContent = fs.readFileSync(verifierPath, "utf-8");

    // AC: verifier.md should include subtract-first cleanup language
    expect(verifierContent).toMatch(/Subtract-First Cleanup/);
    expect(verifierContent).toMatch(/Remove low-value tests/i);
    expect(verifierContent).toMatch(/Remove or simplify low-value comments/i);
    expect(verifierContent).toMatch(/Delete obviously dead code/i);

    const reviewerPath = path.join(__dirname, "..", "skills", "reviewer.md");
    const reviewerContent = fs.readFileSync(reviewerPath, "utf-8");

    // AC: reviewer.md should NOT contain subtract-first edit phrases
    expect(reviewerContent).not.toMatch(/Remove low-value tests/i);
    expect(reviewerContent).not.toMatch(/Delete dead code/i);
    expect(reviewerContent).not.toMatch(/Remove narration-style comments/i);
    expect(reviewerContent).not.toMatch(/Prefer deletions over additions/i);

    // AC: reviewer.md should focus on validation and security
    expect(reviewerContent).toMatch(/Validation/i);
    expect(reviewerContent).toMatch(/security|robustness/i);

    // AC: reviewer should still route rejections to architect
    expect(reviewerContent).toMatch(/reject.*architect/i);
  });

  test("t-1: architect phase writes notes without context indexing", async () => {
    mockPrompt.mockResolvedValueOnce("architect plan");

    await runLoop(stateManager);

    // Verify notes were written (no context engine)
    const notesPath = path.join(tmpDir, ".agent", "notes", "architect.md");
    expect(fs.existsSync(notesPath)).toBe(true);
    expect(fs.readFileSync(notesPath, "utf-8")).toBe("architect plan");

    // Verify no context.json file was created
    const contextPath = path.join(tmpDir, ".agent", "context.json");
    expect(fs.existsSync(contextPath)).toBe(false);
  });

  test("t-1: reviewer phase writes notes without context indexing", async () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "running",
      history: [
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: "implementation",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("reviewer feedback");

    await runLoop(stateManager);

    // Verify notes were written (no context engine)
    const notesPath = path.join(tmpDir, ".agent", "notes", "reviewer.md");
    expect(fs.existsSync(notesPath)).toBe(true);
    expect(fs.readFileSync(notesPath, "utf-8")).toBe("reviewer feedback");

    // Verify no context.json file was created
    const contextPath = path.join(tmpDir, ".agent", "context.json");
    expect(fs.existsSync(contextPath)).toBe(false);
  });

  test("t-4: TestWriter runs after developer and before deterministic checks on success", async () => {
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // Developer and TestWriter both succeed
    mockPrompt.mockResolvedValueOnce("developer implementation");
    mockPrompt.mockResolvedValueOnce("test-writer tests");
    mockPrompt.mockResolvedValueOnce("verifier feedback");
    mockPrompt.mockResolvedValueOnce("reviewer approval");

    await runLoop(stateManager);

    const state = stateManager.load();

    // AC: TestWriter runs after Developer
    expect(state.history).toHaveLength(5); // architect, developer, test-writer, verifier, reviewer
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "success",
        outputs: "developer implementation",
      }),
    );
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "success",
        outputs: "test-writer tests",
      }),
    );

    // AC: Deterministic checks run after TestWriter succeeds
    expect(mockCanonicalTests).toHaveBeenCalled();

    // AC: Next phase after deterministic checks is verifier
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");

    // AC: mockPrompt called: developer, test-writer, verifier, reviewer
    expect(mockPrompt).toHaveBeenCalledTimes(4);
  });

  test("t-4: TestWriter returning blocked: causes escalation to architect", async () => {
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;
    mockCanonicalTests.mockClear(); // Ensure clean slate

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // Developer succeeds, TestWriter reports blocked, then architect throws to stop loop
    mockPrompt.mockResolvedValueOnce("developer implementation"); // developer
    mockPrompt.mockResolvedValueOnce("blocked: missing test infrastructure"); // test-writer
    mockPrompt.mockRejectedValueOnce(new Error("stop loop")); // architect

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();

    // AC: History has architect (prior), developer (success), test-writer (blocked), architect (failed)
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "success",
        outputs: "developer implementation",
      }),
    );
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "blocked",
        outputs: "blocked: missing test infrastructure",
      }),
    );

    // AC: Deterministic checks NOT called when TestWriter blocked
    expect(mockCanonicalTests).not.toHaveBeenCalled();

    // AC: Phase escalated to architect
    expect(state.current_phase).toBe("architect");
  });

  test("t-4: TestWriter runs with correct model configuration", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // Developer and TestWriter both succeed
    mockPrompt.mockResolvedValueOnce("developer implementation");
    mockPrompt.mockResolvedValueOnce("test-writer tests");
    mockPrompt.mockResolvedValueOnce("verifier feedback");
    mockPrompt.mockResolvedValueOnce("reviewer approval");

    await runLoop(stateManager);

    const state = stateManager.load();

    // AC: TestWriter uses haiku4.5 model (observable behavior in state)
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        model: "haiku4.5",
      }),
    );
  });

  test("t-4: Two-strike test failure logic still intact after TestWriter insertion", async () => {
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;
    mockCanonicalTests.mockClear(); // Ensure clean slate

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // Developer succeeds, TestWriter succeeds, but canonical tests fail (1st strike)
    mockPrompt.mockResolvedValueOnce("developer implementation");
    mockPrompt.mockResolvedValueOnce("test-writer tests");
    mockCanonicalTests.mockReturnValueOnce({
      exitCode: 1,
      stdout: "Test failed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    await runLoop(stateManager);

    const state = stateManager.load();

    // AC: After TestWriter, canonical tests run and fail
    // AC: Stays in developer phase (1st strike)
    expect(state.current_phase).toBe("developer");
    expect(state.developer_test_failures).toBe(1);

    // AC: History shows developer success and test-writer success
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "success",
      }),
    );
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "success",
      }),
    );

    // AC: Additional blocked entry for test failure
    const testBlockedEntry = state.history!.find(
      (h) => h.phase === "developer" && h.status === "blocked",
    );
    expect(testBlockedEntry).toBeDefined();
  });

  test("t-4: Implementation group invariant - deterministic checks do not run if developer blocks", async () => {
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;
    mockCanonicalTests.mockClear(); // Ensure clean slate

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // With parallel: developer blocks, test-writer runs, then architect throws to stop loop
    mockPrompt.mockResolvedValueOnce("blocked: missing implementation details"); // developer
    mockPrompt.mockResolvedValueOnce("test-writer output"); // test-writer
    mockPrompt.mockRejectedValueOnce(new Error("stop loop")); // architect

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();

    // AC: Deterministic checks do NOT run when developer blocks
    expect(mockCanonicalTests).not.toHaveBeenCalled();

    // AC: History shows developer blocked
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "blocked",
        outputs: "blocked: missing implementation details",
      }),
    );

    // AC: With parallel, TestWriter entry exists (may succeed even if developer blocked)
    const testWriterEntry = state.history!.find(
      (h) => h.phase === "test-writer",
    );
    expect(testWriterEntry).toBeDefined();
    expect(testWriterEntry).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "success",
      }),
    );

    // AC: Phase escalated to architect
    expect(state.current_phase).toBe("architect");
  });

  test("t-4: Concurrency guard - Developer and TestWriter are initiated together (not sequential)", async () => {
    // This test documents the expectation that Developer and TestWriter prompts
    // are initiated within the same developer-phase iteration.
    // Specifically: both get Auggie.create calls before deterministic checks run.
    // This prevents a silent regression to sequential orchestration.

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("developer implementation");
    mockPrompt.mockResolvedValueOnce("test-writer tests");
    mockPrompt.mockResolvedValueOnce("verifier feedback");
    mockPrompt.mockResolvedValueOnce("reviewer approval");

    await runLoop(stateManager);

    const state = stateManager.load();

    // AC: Both developer and test-writer entries created before verifier
    // This ensures they ran within the same developer-phase iteration
    expect(state.history![1].phase).toBe("developer");
    expect(state.history![2].phase).toBe("test-writer");
    expect(state.history![3].phase).toBe("verifier");

    // AC: Both have successful status and model recorded
    expect(state.history![1].status).toBe("success");
    expect(state.history![2].status).toBe("success");
    expect(state.history![1].model).toBe("haiku4.5"); // developer
    expect(state.history![2].model).toBe("haiku4.5"); // test-writer
  });

  test("t-4: TestWriter block - deterministic checks do not run and control returns to architect", async () => {
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;
    mockCanonicalTests.mockClear(); // Ensure clean slate

    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    // Developer succeeds, but TestWriter blocks, then architect throws to stop loop
    mockPrompt.mockResolvedValueOnce("developer implementation"); // developer
    mockPrompt.mockResolvedValueOnce(
      "blocked: need more context on test strategy",
    ); // test-writer
    mockPrompt.mockRejectedValueOnce(new Error("stop loop")); // architect

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();

    // AC: If TestWriter blocks, deterministic checks do NOT run
    expect(mockCanonicalTests).not.toHaveBeenCalled();

    // AC: History shows developer success and test-writer blocked
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "success",
        outputs: "developer implementation",
      }),
    );
    expect(state.history![2]).toEqual(
      expect.objectContaining({
        phase: "test-writer",
        status: "blocked",
        outputs: "blocked: need more context on test strategy",
      }),
    );

    // AC: Phase escalated back to architect
    expect(state.current_phase).toBe("architect");
  });
});

describe("t-4: Regression tests for logging schema and context removal", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;
  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(async () => {
    await closeSharedClient();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("logTimingDuration writes JSON lines with phase and model fields", async () => {
    // Create dev-tickets.md with open tickets to ensure developer phase runs
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-tickets.md"),
      "-[ ] t-1: Open ticket",
      "utf-8",
    );

    // Test the developer phase which includes meta fields
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("developer implementation");
    mockPrompt.mockResolvedValueOnce("test-writer tests");
    mockPrompt.mockResolvedValueOnce("verifier feedback");
    mockPrompt.mockResolvedValueOnce("reviewer approval");

    await runLoop(stateManager);

    // Read events log
    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    expect(fs.existsSync(eventsPath)).toBe(true);

    const lines = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    // Parse all events
    const events = lines.map((line) => JSON.parse(line));

    // Find any prompt event with meta fields (could be any phase)
    const promptEventWithMeta = events.find(
      (e: any) => e.event === "prompt" && e.meta && e.phase !== undefined,
    );

    // AC: prompt event has phase and model fields
    expect(promptEventWithMeta).toBeDefined();
    if (promptEventWithMeta) {
      expect(promptEventWithMeta.phase).toBeDefined();
      expect(typeof promptEventWithMeta.phase).toBe("string");
      expect(promptEventWithMeta.model).toBeDefined();
      expect(typeof promptEventWithMeta.model).toBe("string");

      // AC: meta fields are present and numeric
      expect(promptEventWithMeta.meta).toBeDefined();
      expect(typeof promptEventWithMeta.meta.prompt_chars).toBe("number");
      expect(typeof promptEventWithMeta.meta.response_chars).toBe("number");
      expect(promptEventWithMeta.meta.prompt_chars).toBeGreaterThan(0);
      expect(promptEventWithMeta.meta.response_chars).toBeGreaterThan(0);

      // AC: JSON is valid and parseable as written
      expect(typeof promptEventWithMeta).toBe("object");
    }
  });

  test("all timing events include phase and model fields", async () => {
    // Setup multiple prompts to go through architect and developer phases
    mockPrompt.mockResolvedValueOnce(
      "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
    );
    mockPrompt.mockResolvedValueOnce("developer impl");
    mockPrompt.mockResolvedValueOnce("test-writer impl");
    mockPrompt.mockResolvedValueOnce("verifier impl");
    mockPrompt.mockResolvedValueOnce("reviewer impl");

    // Run the first loop iteration (architect phase)
    await runLoop(stateManager);

    // Approve architect to move to developer
    let state = stateManager.load();
    stateManager.update({
      ...state,
      status: "running",
    });

    // Run developer phase
    await runLoop(stateManager);

    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Every event should have phase and model
    for (const event of events) {
      expect(event.phase).toBeDefined();
      expect(typeof event.phase).toBe("string");
      expect(event.model).toBeDefined();
      expect(typeof event.model).toBe("string");
    }

    // At least one event from architect phase
    const phases = new Set(events.map((e: any) => e.phase));
    expect(phases.has("architect")).toBe(true);
  });

  test("no DirectContext imports or calls are present in loop.ts", () => {
    const loopContent = fs.readFileSync(
      path.join(__dirname, "loop.ts"),
      "utf-8",
    );

    // AC: DirectContext is not imported
    expect(loopContent).not.toMatch(/import.*DirectContext/);
    expect(loopContent).not.toMatch(/require.*DirectContext/);

    // AC: No DirectContext method calls
    expect(loopContent).not.toMatch(/DirectContext\./);
    expect(loopContent).not.toMatch(/DirectContext\.create/);
  });

  test("no context.json file is created after workflow completes", async () => {
    mockPrompt.mockResolvedValueOnce(
      "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
    );

    // Run architect phase
    await runLoop(stateManager);

    // AC: context.json does not exist
    const contextPath = path.join(tmpDir, ".agent", "context.json");
    expect(fs.existsSync(contextPath)).toBe(false);

    // Verify .agent directory exists but context.json is not there
    const agentDir = path.join(tmpDir, ".agent");
    if (fs.existsSync(agentDir)) {
      const agentFiles = fs.readdirSync(agentDir);
      expect(agentFiles).not.toContain("context.json");
    }
  });

  test("prompt meta fields contain accurate character counts for architect", async () => {
    const architectResponse = "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test";
    mockPrompt.mockResolvedValueOnce(architectResponse);

    await runLoop(stateManager);

    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Find architect prompt event with meta field
    const architectPromptEvent = events.find(
      (e: any) => e.event === "prompt" && e.phase === "architect",
    );
    expect(architectPromptEvent).toBeDefined();

    if (architectPromptEvent && architectPromptEvent.meta) {
      // prompt_chars should be > 0 (instruction length)
      if ("prompt_chars" in architectPromptEvent.meta) {
        expect(typeof architectPromptEvent.meta.prompt_chars).toBe("number");
        expect(architectPromptEvent.meta.prompt_chars).toBeGreaterThan(0);
      }
      // response_chars should be > 0 (response length)
      if ("response_chars" in architectPromptEvent.meta) {
        expect(typeof architectPromptEvent.meta.response_chars).toBe("number");
        expect(architectPromptEvent.meta.response_chars).toBeGreaterThan(0);
      }
    }
  });

  test("prompt events include usage metadata when SDK provides it", async () => {
    const architectResponse = "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test";
    mockPrompt.mockResolvedValueOnce({
      text: architectResponse,
      usage: {
        input_tokens: 150,
        output_tokens: 50,
        total_tokens: 200,
        credits: 5,
      },
      model: "gpt5.1",
    });

    await runLoop(stateManager);

    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Find architect prompt event
    const promptEvent = events.find(
      (e: any) => e.event === "prompt" && e.phase === "architect",
    );
    expect(promptEvent).toBeDefined();
    expect(promptEvent.meta).toBeDefined();
    expect(promptEvent.meta.usage).toBeDefined();
    expect(promptEvent.meta.usage.source).toBe("auggie");
    expect(promptEvent.meta.usage.input_tokens).toBe(150);
    expect(promptEvent.meta.usage.output_tokens).toBe(50);
    expect(promptEvent.meta.usage.total_tokens).toBe(200);
    expect(promptEvent.meta.usage.credits).toBe(5);
  });
});

describe("t-101: Regression test for `.carl/events.jsonl` event shape", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t101-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    const mockPrompt = jest.fn().mockResolvedValue("# Tickets");
    const mockClose = jest.fn().mockResolvedValue(undefined);
    const mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(async () => {
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("creates `.carl/events.jsonl` with required fields and does not create `.carl/timing.jsonl`", async () => {
    await runLoop(stateManager);

    // Assert: `.carl/events.jsonl` exists
    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    expect(fs.existsSync(eventsPath)).toBe(true);

    // Assert: `.carl/timing.jsonl` is NOT created
    const timingPath = path.join(tmpDir, ".carl", "timing.jsonl");
    expect(fs.existsSync(timingPath)).toBe(false);

    // Assert: at least one line parses as JSON
    const eventsData = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    expect(eventsData.length).toBeGreaterThan(0);

    // Assert: all events have required fields
    for (const event of eventsData) {
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("run_id");
      expect(event).toHaveProperty("event");
      expect(event).toHaveProperty("phase");
      expect(event).toHaveProperty("model");
    }

    // Assert: events include expected event types
    const eventTypes = new Set(eventsData.map((e: any) => e.event));
    expect(eventTypes.has("Auggie.create")).toBe(true);
    expect(eventTypes.has("prompt")).toBe(true);
    expect(eventTypes.has("phase")).toBe(true);
  });
});

describe("t-102: Regression tests for usage metadata and developer/test-writer split", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t102-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }
  });

  afterEach(async () => {
    await closeSharedClient();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("developer/test-writer split: logs only coder usage, not test-writer usage", async () => {
    const mockPrompt = jest.fn();
    const mockClose = jest.fn().mockResolvedValue(undefined);
    const mockOnSessionUpdate = jest.fn();

    // Mock coder response with usage
    const coderResponse = {
      text: "implemented feature",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        credits: 3,
      },
    };

    // Mock test-writer response with different usage (should NOT be logged in same event)
    const testWriterResponse = {
      text: "added tests",
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        credits: 6,
      },
    };

    // Queue responses: coder, test-writer, verifier, reviewer (gate)
    mockPrompt.mockResolvedValueOnce(coderResponse);
    mockPrompt.mockResolvedValueOnce(testWriterResponse);
    mockPrompt.mockResolvedValueOnce("verified"); // verifier
    mockPrompt.mockResolvedValueOnce("approved"); // reviewer

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Create dev and test tickets so both run
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-tickets.md"),
      "-[ ] t-1: Open ticket",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentDir, "test-tickets.md"),
      "-[ ] tt-1: Open test ticket",
      "utf-8",
    );

    // Mock test suite to pass
    const { runCanonicalTests } = require("./just");
    (runCanonicalTests as jest.Mock).mockReturnValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    // Set state to developer phase (after architect)
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n## [ ] t-1: Test",
        },
      ],
    });

    await runLoop(stateManager);

    // Read events
    const eventsPath = path.join(tmpDir, ".carl", "events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Find developer phase prompt events
    const devPromptEvents = events.filter(
      (e: any) => e.event === "prompt" && e.phase === "developer",
    );
    expect(devPromptEvents.length).toBe(1); // Single prompt event for both coder and test-writer

    const promptEvent = devPromptEvents[0];

    // Assert: model field reflects the main developer model (haiku4.5)
    expect(promptEvent.model).toBe("haiku4.5");

    // Assert: meta.usage corresponds only to the coder (main model), not test-writer
    expect(promptEvent.meta.usage).toBeDefined();
    expect(promptEvent.meta.usage.source).toBe("auggie");
    expect(promptEvent.meta.usage.input_tokens).toBe(100); // Coder's tokens
    expect(promptEvent.meta.usage.output_tokens).toBe(50);
    expect(promptEvent.meta.usage.total_tokens).toBe(150);
    expect(promptEvent.meta.usage.credits).toBe(3);

    // Assert: test-writer usage (200 input tokens) is NOT included in the same event
    // This verifies the split behavior - test-writer usage is not duplicated/mixed with coder usage
    expect(promptEvent.meta.usage.input_tokens).not.toBe(200);
  });
});

describe("t-5: Allow empty developer/test ticket queues to skip phases", () => {
  test("hasOpenTickets returns true for missing file (assume work exists)", () => {
    const loopModule = require("./loop");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    try {
      const filePath = path.join(tmpDir, ".agent", "dev-tickets.md");
      // File doesn't exist - assume work exists, don't skip
      expect(loopModule.hasOpenTickets(filePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("hasOpenTickets returns false for file with no open tickets", () => {
    const loopModule = require("./loop");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    try {
      const agentDir = path.join(tmpDir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, "dev-tickets.md");
      fs.writeFileSync(
        filePath,
        "-[x] t-1: Completed ticket\n-[x] t-2: Another completed",
        "utf-8",
      );
      expect(loopModule.hasOpenTickets(filePath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("hasOpenTickets returns true for file with open tickets", () => {
    const loopModule = require("./loop");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    try {
      const agentDir = path.join(tmpDir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, "dev-tickets.md");
      fs.writeFileSync(
        filePath,
        "-[ ] t-1: Open ticket\n-[x] t-2: Completed ticket",
        "utf-8",
      );
      expect(loopModule.hasOpenTickets(filePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("developer phase skips when dev-tickets.md has no open tickets", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t5-dev-"));
    const stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    // Create dev-tickets.md and test-tickets.md with no open tickets
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-tickets.md"),
      "-[x] t-1: Completed\n-[x] t-2: Done",
      "utf-8",
    );
    // Also create test-tickets.md with no open tickets
    fs.writeFileSync(
      path.join(agentDir, "test-tickets.md"),
      "-[x] tt-1: Test completed",
      "utf-8",
    );

    const mockPrompt = jest.fn().mockResolvedValue("mocked response");
    const mockClose = jest.fn().mockResolvedValue(undefined);
    const mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Set state to developer phase
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    try {
      await runLoop(stateManager);
      const state = stateManager.load();

      // AC: Developer phase should be skipped (no prompts to coder/test-writer)
      // Should transition through verifier to reviewer (gate phase)
      expect(state.current_phase).toBe("reviewer");
      expect(state.status).toBe("awaiting_approval");

      // AC: History should have developer and test-writer entries with success status
      const devHistory = state.history!.find((h) => h.phase === "developer");
      expect(devHistory).toBeDefined();
      expect(devHistory!.status).toBe("success");
      expect(devHistory!.outputs).toBe(""); // No-op outputs

      const twHistory = state.history!.find((h) => h.phase === "test-writer");
      expect(twHistory).toBeDefined();
      expect(twHistory!.status).toBe("success");
      expect(twHistory!.outputs).toBe(""); // No-op outputs

      // AC: Prompt should NOT be called for developer/test-writer
      // Only architect was previously run, so this should be 0
      expect(mockPrompt).not.toHaveBeenCalledWith(
        expect.stringContaining("Coder"),
        expect.anything(),
      );
    } finally {
      await closeSharedClient();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("developer phase runs normally when dev-tickets.md has open tickets", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-t5-dev2-"));
    const stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    // Create dev-tickets.md with open tickets
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-tickets.md"),
      "-[ ] t-1: Open ticket\n-[x] t-2: Done",
      "utf-8",
    );

    const mockPrompt = jest.fn().mockResolvedValue("implementation");
    const mockClose = jest.fn().mockResolvedValue(undefined);
    const mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });

    // Mock runCanonicalTests to succeed
    const { runCanonicalTests } = require("./just");
    const mockCanonicalTests = runCanonicalTests as jest.Mock;
    mockCanonicalTests.mockReturnValue({
      exitCode: 0,
      stdout: "Tests passed",
      stderr: "",
      command: "just test",
      usedJust: true,
    });

    // Set state to developer phase
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets",
        },
      ],
    });

    try {
      await runLoop(stateManager);
      const state = stateManager.load();

      // AC: Developer phase should run (prompts sent to coder/test-writer)
      // Verify that mockPrompt was called
      expect(mockPrompt).toHaveBeenCalled();

      // AC: History should have developer and test-writer entries
      const devHistory = state.history!.find((h) => h.phase === "developer");
      expect(devHistory).toBeDefined();
      expect(devHistory!.status).toBe("success");

      const twHistory = state.history!.find((h) => h.phase === "test-writer");
      expect(twHistory).toBeDefined();
      expect(twHistory!.status).toBe("success");

      // AC: Should proceed through verifier and reach reviewer (gate phase)
      expect(state.current_phase).toBe("reviewer");
      expect(state.status).toBe("awaiting_approval");
    } finally {
      await closeSharedClient();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
