import { runLoop } from './loop';
import { StateManager } from './state';
import { approveCommand, rejectCommand } from './commands';
import { Auggie } from '@augmentcode/auggie-sdk';
import { HAPPY_PATH_GRAPH } from './graph';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('@augmentcode/auggie-sdk', () => ({
  Auggie: {
    create: jest.fn(),
  },
}));

describe('End-to-End Workflow Harness', () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carl-e2e-test-'));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(path.join(skillsDir, `${phase}.md`), `dummy ${phase} skill`);
    }

    mockPrompt = jest.fn().mockResolvedValue('mocked response');
    mockClose = jest.fn().mockResolvedValue(undefined);

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('happy-path workflow completes without manual agent restart between phases', async () => {
    // 1. Run loop until first gate (qa-gate)
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe('qa-gate');
    expect(state.status).toBe('awaiting_approval');

    // 2. Approve qa-gate
    approveCommand(tmpDir);

    // 3. Run loop until next gate (lewis)
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe('lewis');
    expect(state.status).toBe('awaiting_approval');

    // 4. Approve lewis
    approveCommand(tmpDir);

    // 5. Run loop until next gate (commit-review-gate)
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe('commit-review-gate');
    expect(state.status).toBe('awaiting_approval');

    // 6. Approve final gate, which should complete the workflow
    approveCommand(tmpDir);
    state = stateManager.load();
    expect(state.current_phase).toBe('commit-review-gate');
    expect(state.status).toBe('completed');
  });

  test('handback workflow survives a backward transition and subsequent resume', async () => {
    // We will simulate a grey blocker to test backward transition to dani
    mockPrompt.mockImplementation(async (instruction: string) => {
      if (instruction.includes('grey')) {
        return 'blocked: waiting on API token';
      }
      return 'success';
    });

    // Run loop. It will hit grey, get blocked, and transition back to dani.
    // To prevent infinite loop in tests, we need the NEXT run of grey to succeed.
    mockPrompt
      .mockResolvedValueOnce('dani output')
      .mockResolvedValueOnce('dani-tickets output')
      .mockResolvedValueOnce('blocked: need API token') // 1st grey fails
      .mockResolvedValueOnce('dani output retry')
      .mockResolvedValueOnce('dani-tickets output retry')
      .mockResolvedValue('success'); // 2nd grey and subsequent passes

    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('qa-gate');

    // Verify the blocker was preserved in the history
    const blockedGreyEntry = state.history!.find(h => h.phase === 'grey' && h.status === 'blocked');
    expect(blockedGreyEntry).toBeDefined();
    expect(blockedGreyEntry!.outputs).toContain('blocked: need API token');

    // Reject qa-gate to test handback to dani
    rejectCommand(tmpDir, 'qa failed');
    
    // Now state should be running at dani
    const rejectedState = stateManager.load();
    expect(rejectedState.current_phase).toBe('dani');
    expect(rejectedState.status).toBe('running');

    // Run loop again to reach qa-gate
    await runLoop(stateManager);
    const resumedState = stateManager.load();
    expect(resumedState.current_phase).toBe('qa-gate');
    expect(resumedState.status).toBe('awaiting_approval');
  });
});
