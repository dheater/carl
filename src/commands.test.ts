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

  test("approveCommand advances architect to developer and writes tickets.md", () => {
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

    approveCommand(tmpDir);

    const state = stateManager.load();
    expect(state.status).toBe("running");
    expect(state.current_phase).toBe("developer");

    const ticketsPath = path.join(tmpDir, ".agent", "tickets.md");
    expect(fs.readFileSync(ticketsPath, "utf-8")).toBe(slicePlan);
  });

  test("approveCommand at reviewer gate marks the workflow completed", () => {
    stateManager.update({
      current_phase: "reviewer",
      status: "awaiting_approval",
    });
    approveCommand(tmpDir);
    expect(stateManager.load().status).toBe("completed");
  });

  test("approveCommand refuses architect approval without a valid slice plan", () => {
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

    expect(() => approveCommand(tmpDir)).toThrow(
      /has not yet produced a slice plan/i,
    );

    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");
    expect(fs.existsSync(path.join(tmpDir, ".agent", "tickets.md"))).toBe(
      false,
    );
  });

  test("approveCommand throws if not awaiting_approval", () => {
    expect(() => approveCommand(tmpDir)).toThrow(/not awaiting approval/);
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
    expect(state.current_phase).toBe("architect"); // reviewer fallback is architect

    // History should have the rejection logged
    expect(state.history).toHaveLength(3);
    expect(state.history![2]).toEqual({
      phase: "reviewer",
      model: "system",
      status: "rejected",
      outputs: "Approval rejected: Missing tests",
    });
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
});
