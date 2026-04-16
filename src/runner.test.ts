import { runPhase } from './runner';
import { StateManager } from './state';
import { Auggie } from '@augmentcode/auggie-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('@augmentcode/auggie-sdk', () => ({
  Auggie: {
    create: jest.fn(),
  },
}));

describe('PhaseRunner', () => {
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
    fs.writeFileSync(path.join(skillsDir, 'test-phase.md'), 'dummy skill');

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

  test('runs phase and updates state on success', async () => {
    await runPhase('test-phase', stateManager);

    expect(Auggie.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: tmpDir,
      model: 'sonnet4.5',
      allowIndexing: true,
    }));
    expect(mockPrompt).toHaveBeenCalledWith('Follow the test-phase skill.', { isAnswerOnly: true });
    expect(mockClose).toHaveBeenCalled();

    // Verify state across restart (new manager instance)
    const newManager = new StateManager(tmpDir);
    const state = newManager.load();
    expect(state.history).toHaveLength(1);
    expect(state.history![0]).toEqual({
      phase: 'test-phase',
      model: 'sonnet4.5',
      status: 'success',
      outputs: 'mocked response',
    });
  });

  test('records failure and throws error on crash', async () => {
    mockPrompt.mockRejectedValue(new Error('crash'));

    await expect(runPhase('test-phase', stateManager)).rejects.toThrow('crash');
    expect(mockClose).toHaveBeenCalled();

    const state = stateManager.load();
    expect(state.history).toHaveLength(1);
    expect(state.history![0]).toEqual({
      phase: 'test-phase',
      model: 'sonnet4.5',
      status: 'failed',
      outputs: 'crash',
    });
  });

  test('throws error if skill file does not exist', async () => {
    await expect(runPhase('missing-phase', stateManager)).rejects.toThrow(/Skill file not found/);
    const state = stateManager.load();
    expect(state.history).toEqual([]);
  });
});
