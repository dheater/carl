import { StateManager } from "./state";
import { getNextPhase } from "./graph";

const TICKET_HEADING_RE =
  /^(?:#{2,6}\s+)?(?:[-*+]\s+)?\[\s*(?:|x)\s*\]\s+t-\d+[a-z0-9-]*\s*:/im;
const ACCEPTANCE_CRITERIA_RE = /^(?:AC|Acceptance Criteria)\s*:/im;

function getLastSuccessfulArchitectOutput(
  workspaceHistory?: {
    phase: string;
    status: string;
    outputs: string;
  }[],
): string | undefined {
  return workspaceHistory
    ?.slice()
    .reverse()
    .find((h) => h.phase === "architect" && h.status === "success")?.outputs;
}

function isArchitectSlicePlan(output: string): boolean {
  return TICKET_HEADING_RE.test(output) && ACCEPTANCE_CRITERIA_RE.test(output);
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
    const lastArchitectOutput = getLastSuccessfulArchitectOutput(state.history);

    if (!lastArchitectOutput) {
      throw new Error(
        "Architect has no successful output to approve yet. Run the architect phase again.",
      );
    }

    if (!isArchitectSlicePlan(lastArchitectOutput)) {
      stateManager.update({
        status: "running",
        pending_reply: approvalBuffer?.trim() || lastArchitectOutput,
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

  // Preserve full buffer if provided, otherwise fall back to simple rejection message
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
