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
        { phase: 'grey', model: 'sonnet4.6', status: 'success', outputs: 'ok' },
        { phase: 'qa-gate', model: 'sonnet4.6', status: 'success', outputs: 'please approve' }
      ]
    });

    rejectCommand(tmpDir, 'Missing tests');

    const state = stateManager.load();
    expect(state.status).toBe('running');
    expect(state.current_phase).toBe('dani'); // The one before qa-gate is dani according to fallback logic

    // History should have the rejection logged
    expect(state.history).toHaveLength(3);
    expect(state.history![2]).toEqual({
      phase: 'qa-gate',
      model: 'system',
      status: 'rejected',
      outputs: 'Approval rejected: Missing tests'
    });
  });

  test('rejectCommand on qa-gate transitions back to dani', () => {
    stateManager.update({
      current_phase: 'qa-gate',
      status: 'awaiting_approval',
    });
    rejectCommand(tmpDir, 'qa failed');
    const state = stateManager.load();
    expect(state.current_phase).toBe('dani');
    expect(state.status).toBe('running');
  });

  test('rejectCommand on lewis transitions back to grey', () => {
    stateManager.update({
      current_phase: 'lewis',
      status: 'awaiting_approval',
    });
    rejectCommand(tmpDir, 'lewis rejected');
    const state = stateManager.load();
    expect(state.current_phase).toBe('grey');
    expect(state.status).toBe('running');
  });

  test('rejectCommand on commit-review-gate transitions back to grey', () => {
    stateManager.update({
      current_phase: 'commit-review-gate',
      status: 'awaiting_approval',
    });
    rejectCommand(tmpDir, 'commit rejected');
    const state = stateManager.load();
    expect(state.current_phase).toBe('grey');
    expect(state.status).toBe('running');
  });

  test('rejectCommand throws if not awaiting_approval', () => {
    expect(() => rejectCommand(tmpDir, 'reason')).toThrow(/not awaiting approval/);
  });
});
