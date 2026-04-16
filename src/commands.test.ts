import { approveCommand, rejectCommand } from './commands';
import { StateManager } from './state';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Commands', () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carl-commands-test-'));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('approveCommand changes status from awaiting_approval to running', () => {
    stateManager.update({ status: 'awaiting_approval' });
    approveCommand(tmpDir);
    
    // Verify state across "restarts" by loading from disk
    const state = stateManager.load();
    expect(state.status).toBe('running');
  });

  test('approveCommand throws if not awaiting_approval', () => {
    expect(() => approveCommand(tmpDir)).toThrow(/not awaiting approval/);
  });

  test('rejectCommand changes status and history, returning to prior phase', () => {
    stateManager.update({
      current_phase: 'qa-gate',
      status: 'awaiting_approval',
      history: [
        { phase: 'grey', model: 'sonnet4.5', status: 'success', outputs: 'ok' },
        { phase: 'qa-gate', model: 'sonnet4.5', status: 'success', outputs: 'please approve' }
      ]
    });

    rejectCommand(tmpDir, 'Missing tests');

    const state = stateManager.load();
    expect(state.status).toBe('running');
    expect(state.current_phase).toBe('grey'); // The one before qa-gate
    
    // History should have the rejection logged
    expect(state.history).toHaveLength(3);
    expect(state.history![2]).toEqual({
      phase: 'qa-gate',
      model: 'system',
      status: 'rejected',
      outputs: 'Approval rejected: Missing tests'
    });
  });

  test('rejectCommand handles short history', () => {
    stateManager.update({
      current_phase: 'qa-gate',
      status: 'awaiting_approval',
      history: [
        { phase: 'qa-gate', model: 'sonnet4.5', status: 'success', outputs: 'please approve' }
      ]
    });

    rejectCommand(tmpDir, 'No reason');

    const state = stateManager.load();
    expect(state.status).toBe('running');
    expect(state.current_phase).toBe('grey'); // Configured prior phase
  });

  test('rejectCommand throws if not awaiting_approval', () => {
    expect(() => rejectCommand(tmpDir, 'reason')).toThrow(/not awaiting approval/);
  });
});
