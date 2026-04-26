import { StateManager } from "./state";
import { getNextPhase } from "./graph";
import * as fs from "fs";
import * as path from "path";

const TICKET_HEADING_RE = /^##\s+\[\s*\]\s+t-\d+:/m;

export function replyCommand(workspaceRoot: string, message: string): void {
  const stateManager = new StateManager(workspaceRoot);
  const state = stateManager.load();
  if (state.status !== "awaiting_approval") {
    throw new Error("Cannot reply: Workflow is not awaiting approval.");
  }
  stateManager.update({ status: "running", pending_reply: message });
}

export function approveCommand(workspaceRoot: string): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== "awaiting_approval") {
    throw new Error("Cannot approve: Workflow is not awaiting approval.");
  }

  if (state.current_phase === "architect") {
    const lastArchitectOutput = (state.history || [])
      .slice()
      .reverse()
      .find((h) => h.phase === "architect" && h.status === "success")?.outputs;

    if (!lastArchitectOutput || !TICKET_HEADING_RE.test(lastArchitectOutput)) {
      throw new Error(
        "Architect has not yet produced a slice plan (expected `## [ ] t-N:` headings in the last architect output). " +
          "Reply with your feedback to continue the conversation, or reject to start over.",
      );
    }

    const agentDir = path.join(workspaceRoot, ".agent");
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "tickets.md"),
      lastArchitectOutput,
      "utf-8",
    );
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
