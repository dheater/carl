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

    expect(Auggie.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceRoot: tmpDir,
      model: 'gpt5.4', // dani
      allowIndexing: true,
    }));
    expect(Auggie.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gpt5.4', // dani-tickets
    }));
    expect(Auggie.create).toHaveBeenNthCalledWith(3, expect.objectContaining({
      model: 'haiku4.5', // grey
    }));
    expect(Auggie.create).toHaveBeenNthCalledWith(4, expect.objectContaining({
      model: 'haiku4.5', // qa-gate
    }));
  });

  test('resumes from a gate when status is running', async () => {
    stateManager.update({ current_phase: 'lewis-qa', status: 'running' });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('lewis');
    expect(state.history).toHaveLength(2); // lewis-qa, lewis
    expect(mockPrompt).toHaveBeenCalledTimes(2);

    expect(Auggie.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: 'gemini-3.1-pro-preview', // lewis-qa
    }));
    expect(Auggie.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gemini-3.1-pro-preview', // lewis
    }));
  });

  test('fails if artifacts diverge', async () => {
    stateManager.update({
      current_phase: 'dani',
      status: 'running',
      artifacts: {
        tickets: [{ id: 't-1', title: 'Test', description: '', ac: [], status: 'todo' }]
      }
    });

    const agentDir = path.join(tmpDir, '.agent');
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // Diverging file content
    fs.writeFileSync(path.join(agentDir, 'tickets.md'), '# Different Content');

    await expect(runLoop(stateManager)).rejects.toThrow(/diverges from authoritative state/);
  });

  test('completes workflow after the last phase', async () => {
    stateManager.update({ current_phase: 'commit-review-gate', status: 'running' });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe('awaiting_approval');
    expect(state.current_phase).toBe('commit-review-gate');

    const { approveCommand } = require('./commands');
    approveCommand(tmpDir);

    const finalState = stateManager.load();
    expect(finalState.status).toBe('completed');
    expect(finalState.current_phase).toBe('commit-review-gate');
  });

  test('grey blocker transitions back to dani', async () => {
    stateManager.update({ current_phase: 'grey', status: 'running' });
    mockPrompt.mockResolvedValueOnce('I am blocked: missing PRD info');

    // It will run grey, get blocked, transition to dani, run dani, then dani-tickets, grey, etc.
    // To prevent infinite loop in tests, let's mock the second prompt (dani) to throw so it stops,
    // or we can just let it run but we need to limit the mockPrompt resolved values or mock getNextPhase.
    // Wait, let's mock prompt to throw after dani to stop the loop.
    mockPrompt.mockRejectedValueOnce(new Error('stop loop'));

    await expect(runLoop(stateManager)).rejects.toThrow('stop loop');

    const state = stateManager.load();
    // grey (blocked) -> dani (throws)
    expect(state.history).toHaveLength(2);
    expect(state.history![0]).toEqual(expect.objectContaining({
      phase: 'grey',
      status: 'blocked',
      outputs: 'I am blocked: missing PRD info'
    }));
    expect(state.history![1]).toEqual(expect.objectContaining({
      phase: 'dani',
      status: 'failed',
    }));
    expect(state.current_phase).toBe('dani');
  });
});
