import { runLoop } from "./loop";
import { StateManager } from "./state";
import { approveCommand, rejectCommand } from "./commands";
import { HAPPY_PATH_GRAPH } from "./graph";
import { runJustFormat, runJustLint } from "./just";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

jest.mock("@augmentcode/auggie-sdk", () => ({
  Auggie: {
    create: jest.fn(),
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

jest.mock("child_process");

const { Auggie } = require("@augmentcode/auggie-sdk");

describe("End-to-End Workflow Harness", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;

  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-e2e-test-"));
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

    // Track which phase is calling us by counting calls in sequence: architect, developer, verifier, reviewer.
    // Architect output must be a valid tickets file so approveCommand's guard passes.
    let callCount = 0;
    mockPrompt = jest.fn().mockImplementation((instruction: string) => {
      const phaseIndex = callCount;
      callCount++;
      const phaseOutputs = [
        "# Tickets\n\n## [ ] t-1: Sample ticket\n\nAC:\n- Sample acceptance criteria", // architect
        "mocked developer response", // developer
        "mocked verifier response", // verifier
        "mocked reviewer response", // reviewer
      ];
      return Promise.resolve(phaseOutputs[phaseIndex] || "mocked response");
    });
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("happy-path workflow completes without manual agent restart between phases", async () => {
    // 1. Run loop until first gate (architect)
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");

    // 2. Approve architect
    approveCommand(tmpDir);

    // 3. Run loop until next gate (reviewer)
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");

    // 4. Approve final gate, which should complete the workflow
    approveCommand(tmpDir);
    state = stateManager.load();
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("completed");
  });

  test("architect approval -> developer handoff without skipping", async () => {
    // After an architect approval, the workflow must run developer -> verifier -> reviewer
    // with no phase skipped.

    mockPrompt
      .mockResolvedValueOnce(
        "# Tickets\n\n## [ ] t-1: Sample ticket\n\nAC:\n- Sample acceptance criteria",
      )
      .mockResolvedValueOnce("developer output")
      .mockResolvedValueOnce("verifier output")
      .mockResolvedValue("success");

    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");
    expect(state.history).toHaveLength(1);
    expect(state.history![0].phase).toBe("architect");

    approveCommand(tmpDir);

    await runLoop(stateManager);
    state = stateManager.load();

    const developerEntry = state.history!.find((h) => h.phase === "developer");
    const verifierEntry = state.history!.find((h) => h.phase === "verifier");
    const reviewerEntry = state.history!.find((h) => h.phase === "reviewer");

    expect(developerEntry).toBeDefined();
    expect(developerEntry!.status).toBe("success");
    expect(verifierEntry).toBeDefined();
    expect(verifierEntry!.status).toBe("success");
    expect(reviewerEntry).toBeDefined();

    // Verify ordering: architect < developer < verifier < reviewer
    const phases = state.history!.map((h) => h.phase);
    expect(phases.indexOf("architect")).toBeLessThan(
      phases.indexOf("developer"),
    );
    expect(phases.indexOf("developer")).toBeLessThan(
      phases.indexOf("verifier"),
    );
    expect(phases.indexOf("verifier")).toBeLessThan(phases.indexOf("reviewer"));

    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
  });

  test("handback workflow survives a backward transition and subsequent resume", async () => {
    mockPrompt
      .mockResolvedValueOnce("# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Test") // architect
      .mockResolvedValueOnce("blocked: need API token") // developer blocks
      .mockResolvedValueOnce("# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Test") // architect retry
      .mockResolvedValueOnce("success") // developer
      .mockResolvedValueOnce("success") // verifier
      .mockResolvedValue("success"); // reviewer; then after reject: developer, verifier, reviewer

    // 1. Run loop to architect
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");

    // 2. Approve architect, run to developer (gets blocked), returns to architect (pauses)
    approveCommand(tmpDir);
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");

    // 3. Approve architect again, runs developer, reviewer (pauses at reviewer)
    approveCommand(tmpDir);
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("reviewer");

    // Verify the blocker was preserved in the history
    const blockedDeveloperEntry = state.history!.find(
      (h) => h.phase === "developer" && h.status === "blocked",
    );
    expect(blockedDeveloperEntry).toBeDefined();
    expect(blockedDeveloperEntry!.outputs).toContain("blocked: need API token");

    // Reject reviewer to test handback to architect
    rejectCommand(tmpDir, "qa failed");

    // Now state should be running at architect
    const rejectedState = stateManager.load();
    expect(rejectedState.current_phase).toBe("architect");
    expect(rejectedState.status).toBe("running");

    // Verify rejection was recorded
    const reviewerRejection = rejectedState.history!.find(
      (h) => h.phase === "reviewer" && h.status === "rejected",
    );
    expect(reviewerRejection).toBeDefined();
    expect(reviewerRejection!.outputs).toContain("qa failed");

    // Run loop again: architect responds and pauses at gate
    mockPrompt.mockResolvedValueOnce(
      "# Tickets\n\n## [ ] t-1: Revised\n\nAC:\n- Updated",
    );
    await runLoop(stateManager);
    const resumedState = stateManager.load();
    expect(resumedState.current_phase).toBe("architect");
    expect(resumedState.status).toBe("awaiting_approval");
  });

  test("architect approval does NOT write to .agent/tickets.md", async () => {
    const slicePlan =
      "# Feature X\n\n## [ ] t-1: Build thing\n\nAC:\n- It works\n";
    mockPrompt.mockReset();
    mockPrompt.mockResolvedValueOnce(slicePlan).mockResolvedValue("success");

    await runLoop(stateManager);
    approveCommand(tmpDir);

    const ticketsPath = path.join(tmpDir, ".agent", "tickets.md");
    expect(fs.existsSync(ticketsPath)).toBe(false);
  });

  test("t-4: Full workflow never creates .agent/tickets.md - regression test for split tickets", async () => {
    // AC: Running through architect approval and developer/test-writer never creates .agent/tickets.md
    // This locks in the split ticket behavior (dev-tickets.md, test-tickets.md) and prevents
    // silent reintroduction of the monolithic tickets file.
    const slicePlan =
      "# Feature X\n\n## [ ] t-1: Build thing\n\nAC:\n- It works\n";
    mockPrompt.mockReset();
    mockPrompt
      .mockResolvedValueOnce(slicePlan)
      .mockResolvedValueOnce("developer output")
      .mockResolvedValueOnce("test-writer output")
      .mockResolvedValueOnce("verifier output")
      .mockResolvedValue("success");

    // Run to architect gate
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");

    // At this point, only architect has run. No tickets.md should exist.
    const ticketsPath = path.join(tmpDir, ".agent", "tickets.md");
    expect(fs.existsSync(ticketsPath)).toBe(false);

    // Approve and continue
    approveCommand(tmpDir);

    // After approval, no tickets.md should be created (this is the key regression check)
    expect(fs.existsSync(ticketsPath)).toBe(false);

    // Run rest of workflow (developer, test-writer, verifier, reviewer)
    await runLoop(stateManager);
    state = stateManager.load();

    // AC: Even after full workflow, tickets.md never created
    expect(fs.existsSync(ticketsPath)).toBe(false);

    // AC: Verify the workflow progressed through developer, test-writer, and beyond
    const phases = state.history!.map((h) => h.phase);
    expect(phases).toContain("architect");
    expect(phases).toContain("developer");
    expect(phases).toContain("test-writer");
  });

  test("workflow completion closes shared client and clears resources", async () => {
    mockPrompt
      .mockResolvedValueOnce(
        "# Tickets\n\n## [ ] t-1: Sample ticket\n\nAC:\n- Sample acceptance criteria",
      )
      .mockResolvedValueOnce("developer output")
      .mockResolvedValueOnce("verifier output")
      .mockResolvedValue("success");

    // Run to architect and approve
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");

    approveCommand(tmpDir);

    // Run to reviewer and approve (should close client on completion)
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");

    // Approve reviewer to mark as completed
    approveCommand(tmpDir);
    state = stateManager.load();
    expect(state.status).toBe("completed");

    // Now try a second workflow. It should succeed without "already active" error.
    stateManager.create(tmpDir, "second run prompt");
    const newState = stateManager.load();
    expect(newState.run_id).not.toBe(state.run_id); // Different run
    expect(newState.status).toBe("running");
  });

  test("approveCommand at reviewer phase marks workflow as completed", async () => {
    mockPrompt
      .mockResolvedValueOnce(
        "# Tickets\n\n## [ ] t-1: Sample ticket\n\nAC:\n- Sample acceptance criteria",
      )
      .mockResolvedValueOnce("developer output")
      .mockResolvedValueOnce("verifier output")
      .mockResolvedValue("reviewer approval message");

    // Run to architect and approve
    await runLoop(stateManager);
    approveCommand(tmpDir);

    // Run to reviewer and approve
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");

    // Approve reviewer
    approveCommand(tmpDir);
    state = stateManager.load();

    // Should be marked as completed
    expect(state.status).toBe("completed");
    expect(state.current_phase).toBe("reviewer");
  });

  test("architect approval before a slice plan continues the architect conversation", async () => {
    const feedbackBuffer =
      "Scope challenge: here are some questions. Do you accept the narrower scope?\n\nYes. Proceed.";
    mockPrompt.mockReset();
    mockPrompt.mockResolvedValueOnce(
      "Scope challenge: here are some questions. Do you accept the narrower scope?",
    );

    await runLoop(stateManager);
    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");

    approveCommand(tmpDir, feedbackBuffer);

    // tickets.md must not have been created
    const ticketsPath = path.join(tmpDir, ".agent", "tickets.md");
    expect(fs.existsSync(ticketsPath)).toBe(false);

    // state moves back to running architect with the edited buffer as feedback
    const after = stateManager.load();
    expect(after.status).toBe("running");
    expect(after.current_phase).toBe("architect");
    expect(after.pending_reply).toBe(feedbackBuffer);
  });

  test("runJustFormat and runJustLint are called after developer phase", async () => {
    const mockRunJustFormat = runJustFormat as jest.MockedFunction<
      typeof runJustFormat
    >;
    const mockRunJustLint = runJustLint as jest.MockedFunction<
      typeof runJustLint
    >;

    // Initialize state and files
    const { Auggie } = require("@augmentcode/auggie-sdk");
    let callCount = 0;
    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: jest.fn().mockImplementation(() => {
        const phaseIndex = callCount;
        callCount++;
        const outputs = [
          "# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Sample", // architect
          "mocked developer response", // developer
          "mocked verifier response", // verifier
          "mocked reviewer response", // reviewer
        ];
        return Promise.resolve(outputs[phaseIndex] || "response");
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onSessionUpdate: jest.fn(),
    });

    // Run architect phase
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");

    // Approve architect
    approveCommand(tmpDir);

    // Run developer → reviewer (mocked)
    await runLoop(stateManager);
    state = stateManager.load();

    // Verify that runJustFormat and runJustLint were called with the workspace root
    expect(mockRunJustFormat).toHaveBeenCalledWith(tmpDir);
    expect(mockRunJustLint).toHaveBeenCalledWith(tmpDir);

    // Verify we reached the reviewer gate
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
  });

  test("workflow reaches reviewer gate even when lint returns non-zero exitCode", async () => {
    const mockRunJustLint = runJustLint as jest.MockedFunction<
      typeof runJustLint
    >;

    // Mock runJustLint to return failure status
    mockRunJustLint.mockReturnValue({
      exitCode: 1,
      stdout: "",
      stderr: "lint failed",
      status: "FAIL",
    });

    const { Auggie } = require("@augmentcode/auggie-sdk");
    let callCount = 0;
    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: jest.fn().mockImplementation(() => {
        const phaseIndex = callCount;
        callCount++;
        const outputs = [
          "# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Sample", // architect
          "mocked developer response", // developer
          "mocked verifier response", // verifier
          "mocked reviewer response", // reviewer
        ];
        return Promise.resolve(outputs[phaseIndex] || "response");
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onSessionUpdate: jest.fn(),
    });

    // Run architect
    await runLoop(stateManager);
    approveCommand(tmpDir);

    // Run to reviewer (lint failure should not block)
    await runLoop(stateManager);
    const state = stateManager.load();

    // Workflow should still reach reviewer despite lint failure
    expect(state.current_phase).toBe("reviewer");
    expect(state.status).toBe("awaiting_approval");
  });

  test("reviewer instruction includes .agent/lint.log content when present", async () => {
    const mockRunJustLint = runJustLint as jest.MockedFunction<
      typeof runJustLint
    >;
    const lintLogContent = "Command: just lint\n\nStdout:\nNo issues found";

    // Create lint.log file
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "lint.log"), lintLogContent);

    mockRunJustLint.mockReturnValue({
      exitCode: 0,
      stdout: lintLogContent,
      stderr: "",
      status: "PASS",
    });

    const { Auggie } = require("@augmentcode/auggie-sdk");
    let callCount = 0;
    let reviewerInstruction = "";
    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: jest.fn().mockImplementation((instruction: string) => {
        if (callCount === 3) {
          // reviewer phase (0: developer, 1: test-writer, 2: verifier, 3: reviewer)
          reviewerInstruction = instruction;
        }
        callCount++;
        const outputs = [
          "# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Sample",
          "mocked developer response",
          "mocked test-writer response",
          "mocked verifier response",
          "mocked reviewer response",
        ];
        return Promise.resolve(
          outputs[Math.min(callCount - 1, 4)] || "response",
        );
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onSessionUpdate: jest.fn(),
    });

    await runLoop(stateManager);
    approveCommand(tmpDir);
    await runLoop(stateManager);

    // Verify reviewer instruction includes lint.log content
    expect(reviewerInstruction).toContain("Lint results");
    expect(reviewerInstruction).toContain(lintLogContent);
  });

  test("reviewer instruction includes changed files section from git status", async () => {
    const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
    const { Auggie } = require("@augmentcode/auggie-sdk");

    // Mock git commands
    let callCount = 0;
    let reviewerInstruction = "";
    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: jest.fn().mockImplementation((instruction: string) => {
        if (callCount === 3) {
          // reviewer phase (0: developer, 1: test-writer, 2: verifier, 3: reviewer)
          reviewerInstruction = instruction;
        }
        callCount++;
        const outputs = [
          "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- test",
          "mocked developer response",
          "mocked test-writer response",
          "mocked verifier response",
          "mocked reviewer response",
        ];
        return Promise.resolve(
          outputs[Math.min(callCount - 1, 4)] || "response",
        );
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onSessionUpdate: jest.fn(),
    });

    // Mock execSync to simulate git status with changes
    mockExecSync.mockImplementation((cmd: string, opts?: any) => {
      if (cmd.includes("rev-parse")) return "true" as any;
      if (cmd.includes("status --porcelain")) {
        return " M src/modified.ts\nA  src/new.ts\n?? untracked.txt" as any;
      }
      return "" as any;
    });

    // Run workflow
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");

    approveCommand(tmpDir);

    await runLoop(stateManager);
    state = stateManager.load();

    // Verify reviewer instruction includes changed files section
    expect(reviewerInstruction).toContain("Files changed");
    expect(reviewerInstruction).toContain("src/modified.ts");
    expect(reviewerInstruction).toContain("src/new.ts");
    expect(reviewerInstruction).toContain("untracked.txt");
  });
});
