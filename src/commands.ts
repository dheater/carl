import { StateManager } from './state';
import { getNextPhase, getPriorPhase } from './graph';

export function approveCommand(workspaceRoot: string): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== 'awaiting_approval') {
    throw new Error('Cannot approve: Workflow is not awaiting approval.');
  }
  const nextPhase = getNextPhase(state.current_phase);
  if (!nextPhase) {
    stateManager.update({ status: 'completed' });
  } else {
    stateManager.update({ status: 'running', current_phase: nextPhase });
  }
}

export function rejectCommand(workspaceRoot: string, reason: string): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== 'awaiting_approval') {
    throw new Error('Cannot reject: Workflow is not awaiting approval.');
  }

  const history = state.history || [];
  const priorPhase = getPriorPhase(state.current_phase) || 'dani';

  history.push({
    phase: state.current_phase,
    model: 'system',
    status: 'rejected',
    outputs: `Approval rejected: ${reason}`
  });

  stateManager.update({
    status: 'running',
    current_phase: priorPhase,
    history
  });
}
