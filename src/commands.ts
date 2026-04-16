import { StateManager } from './state';
import { runPhase } from './runner';

export function approveCommand(workspaceRoot: string): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== 'awaiting_approval') {
    throw new Error('Cannot approve: Workflow is not awaiting approval.');
  }
  stateManager.update({ status: 'running' });
}

export function rejectCommand(workspaceRoot: string, reason: string): void {
  const stateManager = new StateManager(workspaceRoot);
  let state = stateManager.load();
  if (state.status !== 'awaiting_approval') {
    throw new Error('Cannot reject: Workflow is not awaiting approval.');
  }

  const history = state.history || [];
  const priorPhase = history.length > 1 ? history[history.length - 2].phase : 'dani';

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
