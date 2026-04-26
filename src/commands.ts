import { StateManager } from "./state";
import { getNextPhase } from "./graph";

const TICKET_HEADING_RE =
  /^(?:#{2,6}\s+)?(?:[-*+]\s+)?\[\s*(?:|x)\s*\]\s+t-\d+[a-z0-9-]*\s*:/im;
const ACCEPTANCE_CRITERIA_RE = /^(?:AC|Acceptance Criteria)\s*:/im;

function isArchitectSlicePlan(output: string): boolean {
  return TICKET_HEADING_RE.test(output) && ACCEPTANCE_CRITERIA_RE.test(output);
}

function hasArchitectSlicePlanInHistory(
  workspaceHistory?: {
    phase: string;
    status: string;
    outputs: string;
  }[],
): boolean {
  return (
    workspaceHistory?.some(
      (h) =>
        h.phase === "architect" &&
        h.status === "success" &&
        isArchitectSlicePlan(h.outputs),
    ) ?? false
  );
}

export function replyCommand(workspaceRoot: string, message: string): void {
  const stateManager = new StateManager(workspaceRoot);
  const state = stateManager.load();
  if (state.status !== "awaiting_approval") {
    throw new Error("Cannot reply: Workflow is not awaiting approval.");
  }
  stateManager.update({ status: "running", pending_reply: message });
}

export function approveCommand(
  workspaceRoot: string,
  approvalBuffer?: string,
): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== "awaiting_approval") {
    throw new Error("Cannot approve: Workflow is not awaiting approval.");
  }

  if (state.current_phase === "architect") {
    const hasSuccessfulArchitectOutput =
      state.history?.some(
        (h) => h.phase === "architect" && h.status === "success",
      ) ?? false;

    if (!hasSuccessfulArchitectOutput) {
      throw new Error(
        "Architect has no successful output to approve yet. Run the architect phase again.",
      );
    }

    const hasSlicePlan = hasArchitectSlicePlanInHistory(state.history);

    if (!hasSlicePlan) {
      const lastArchitectOutput = state.history
        ?.slice()
        .reverse()
        .find(
          (h) => h.phase === "architect" && h.status === "success",
        )?.outputs;

      stateManager.update({
        status: "running",
        pending_reply: approvalBuffer?.trim() || lastArchitectOutput || "",
      });
      return;
    }
  }

  const nextPhase = getNextPhase(state.current_phase);
  if (!nextPhase || state.current_phase === "reviewer") {
    stateManager.update({ status: "completed" });
  } else {
    stateManager.update({ status: "running", current_phase: nextPhase });
  }
}

export function rejectCommand(
  workspaceRoot: string,
  reason: string,
  targetPhase?: string,
  fullBuffer?: string,
): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== "awaiting_approval") {
    throw new Error("Cannot reject: Workflow is not awaiting approval.");
  }

  const history = state.history || [];
  const priorPhase = targetPhase ?? "architect";
  const outputs = fullBuffer
    ? `Approval rejected: ${reason}\n\n${fullBuffer}`
    : `Approval rejected: ${reason}`;

  history.push({
    phase: state.current_phase,
    model: "system",
    status: "rejected",
    outputs,
  });

  stateManager.update({
    status: "running",
    current_phase: priorPhase,
    history,
  });
}
