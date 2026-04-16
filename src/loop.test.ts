import { runLoop } from './loop';
import { StateManager } from './state';
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

describe('Workflow Loop', () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carl-test-'));
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

  test('runs the full happy path until the first gate and pauses', async () => {
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('qa-gate');
    // History should have 4 entries: dani, dani-tickets, grey, qa-gate
    expect(state.history).toHaveLength(4);
    expect(state.history![3].phase).toBe('qa-gate');
    
    // Check Auggie calls
    expect(mockPrompt).toHaveBeenCalledTimes(4);
  });

  test('resumes from a gate when status is running', async () => {
    stateManager.update({ current_phase: 'lewis-qa', status: 'running' });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('commit-review-gate');
    expect(state.history).toHaveLength(3); // lewis-qa, lewis, commit-review-gate
    expect(mockPrompt).toHaveBeenCalledTimes(3);
  });

  test('completes workflow after the last phase', async () => {
    stateManager.update({ current_phase: 'commit-review-gate', status: 'running' });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('commit-review-gate');

    // Approve the final gate
    const { approveCommand } = require('./commands');
    approveCommand(tmpDir);

    const finalState = stateManager.load();
    expect(finalState.status).toBe('completed');
    expect(finalState.current_phase).toBe('commit-review-gate');
  });
});
