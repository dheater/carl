import { approveCommand, rejectCommand, replyCommand } from "./commands";
import { StateManager } from "./state";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Commands", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-commands-test-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("approveCommand advances architect to developer and does NOT write tickets.md", () => {
    const slicePlan =
      "# Feature\n\n## [ ] t-1: Do the thing\n\nAC:\n- It works\n";
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

    approveCommand(tmpDir, slicePlan);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");

    const ticketsPath = path.join(tmpDir, ".agent", "tickets.md");
    expect(fs.existsSync(ticketsPath)).toBe(false);
  });

  test("approveCommand accepts broader slice-plan ticket formats", () => {
    const slicePlan =
      "# Feature\n\n[ ] t-4a: Add prerequisite\n\nAcceptance Criteria:\n- It works\n";
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

    approveCommand(tmpDir, slicePlan);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");
  });

  test("approveCommand at reviewer gate marks the workflow completed", () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
    });
    approveCommand(tmpDir);
    expect(stateManager.load().status).toBe("completed");
  });

  test("approveCommand continues architect when approval happens before a slice plan exists", () => {
    const feedbackBuffer =
      "Scope challenge: do you accept the narrower scope?\n\nYes. Keep it repo-local.";
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "Scope challenge: do you accept the narrower scope?",
        },
      ],
    });

    approveCommand(tmpDir, feedbackBuffer);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");
    expect(state.pending_reply).toBe(feedbackBuffer);
    expect(fs.existsSync(path.join(tmpDir, ".agent", "tickets.md"))).toBe(
      false,
    );
  });

  test("approveCommand uses any architect slice-plan history, not just latest output", () => {
    const slicePlan =
      "# Feature\n\n## [ ] t-1: Do the thing\n\nAC:\n- It works\n";
    const summaryMessage =
      "Approval noted. Architect work for this slice is finished.";

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
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: summaryMessage,
        },
      ],
    });

    approveCommand(tmpDir, "approve");

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");
    expect(state.pending_reply).toBeUndefined();
  });

  test("approveCommand advances when slice-plan exists earlier in history with non-slice-plan output later", () => {
    const slicePlan = "# Feature\n\n## [ ] t-1: Add feature\n\nAC:\n- Works\n";
    const followUpOutput = "Additional clarification on the approach.";
    const anotherOutput = "More thoughts but no new ticket format.";

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
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: followUpOutput,
        },
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: anotherOutput,
        },
      ],
    });

    approveCommand(tmpDir, "approve");

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");
    expect(state.pending_reply).toBeUndefined();
  });

  test("approveCommand throws if not awaiting_approval", () => {
    expect(() => approveCommand(tmpDir)).toThrow(/not awaiting approval/);
  });

  test("approveCommand rejects architect phase when no slice-plan exists in history", () => {
    const scopeChallenge =
      "Scope challenge: is the repo-local scope acceptable?";
    const clarification = "Additional details about the constraints.";

    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: scopeChallenge,
        },
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: clarification,
        },
      ],
    });

    const feedbackBuffer = "Yes, scope is acceptable. Proceed.";
    approveCommand(tmpDir, feedbackBuffer);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");
    expect(state.pending_reply).toBe(feedbackBuffer);
  });

  test("approveCommand ignores non-success architect entries when searching for slice-plan", () => {
    const slicePlan = "# Feature\n\n## [ ] t-1: Implement\n\nAC:\n- Done\n";
    const rejectedOutput = "Some rejected architect output";

    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "rejected",
          outputs: rejectedOutput,
        },
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: slicePlan,
        },
      ],
    });

    approveCommand(tmpDir, "approve");

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");
  });

  test("rejectCommand changes status and history, returning to prior phase", () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1\n\nAC:\n- test",
        },
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: "implemented feature",
        },
      ],
    });

    rejectCommand(tmpDir, "Missing tests");

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");

    expect(state.history).toHaveLength(3);
    expect(state.history![2]).toEqual({
      phase: "reviewer",
      model: "system",
      status: "rejected",
      outputs: "Approval rejected: Missing tests",
    });
  });

  test("t-8: rejectCommand preserves full editor buffer in history", () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
    });
    const fullBuffer = `## Subtraction and cleanup

- **[Security]: Missing validation** — Add bounds check

## Recommendations for Architect

- Extract auth logic to module

reject: incomplete error handling`;

    rejectCommand(tmpDir, "incomplete error handling", "architect", fullBuffer);
    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");

    expect(state.history).toHaveLength(1);
    const rejectionEntry = state.history![0];
    expect(rejectionEntry.status).toBe("rejected");
    expect(rejectionEntry.phase).toBe("reviewer");
    expect(rejectionEntry.outputs).toContain("Subtraction and cleanup");
    expect(rejectionEntry.outputs).toContain("Missing validation");
    expect(rejectionEntry.outputs).toContain("Extract auth logic");
    expect(rejectionEntry.outputs).toContain("incomplete error handling");
  });

  test("rejectCommand with targetPhase overrides fallback", () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
    });
    rejectCommand(tmpDir, "architecture is wrong", "architect");
    const state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("running");
  });

  test("rejectCommand throws if not awaiting_approval", () => {
    expect(() => rejectCommand(tmpDir, "reason")).toThrow(
      /not awaiting approval/,
    );
  });

  test("replyCommand stores pending_reply and sets status to running", () => {
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
    });
    replyCommand(tmpDir, "the scope is the repo root");
    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("architect");
    expect(state.pending_reply).toBe("the scope is the repo root");
  });

  test("replyCommand throws if not awaiting_approval", () => {
    expect(() => replyCommand(tmpDir, "some answer")).toThrow(
      /not awaiting approval/,
    );
  });

  test("approveCommand throws when no successful architect output exists", () => {
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [],
    });

    expect(() => approveCommand(tmpDir)).toThrow(
      /Architect has no successful output to approve yet/,
    );
  });

  test("approveCommand throws when history has no successful architect entries", () => {
    stateManager.update({
      current_phase: "architect",
      status: "awaiting_approval",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "rejected",
          outputs: "Some rejected output",
        },
      ],
    });

    expect(() => approveCommand(tmpDir)).toThrow(
      /Architect has no successful output to approve yet/,
    );
  });
});
