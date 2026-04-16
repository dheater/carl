import { StateManager, RunState } from './state';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StateManager', () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let stateFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carl-test-'));
    stateManager = new StateManager(tmpDir);
    stateFilePath = path.join(tmpDir, '.agent', 'run.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('create creates a new valid run state', () => {
    const state = stateManager.create(tmpDir);
    expect(state.run_id).toBeDefined();
    expect(state.workspace_path).toBe(tmpDir);
    expect(state.current_phase).toBe('dani');
    expect(state.status).toBe('running');
    expect(state.history).toEqual([]);

    expect(fs.existsSync(stateFilePath)).toBe(true);
    const savedData = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    expect(savedData).toEqual(state);
  });

  test('load reads an existing run state', () => {
    const state = stateManager.create(tmpDir);
    const loadedState = stateManager.load();
    expect(loadedState).toEqual(state);
  });

  test('update modifies an existing state and saves it', () => {
    stateManager.create(tmpDir);
    const updatedState = stateManager.update({ status: 'paused', current_phase: 'grey' });
    expect(updatedState.status).toBe('paused');
    expect(updatedState.current_phase).toBe('grey');

    const loadedState = stateManager.load();
    expect(loadedState).toEqual(updatedState);
  });

  test('load throws helpful error on missing file', () => {
    expect(() => stateManager.load()).toThrow(/Run state file not found/);
  });

  test('load throws helpful error on invalid JSON', () => {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, '{ bad json', 'utf-8');
    expect(() => stateManager.load()).toThrow(/Malformed run state - invalid JSON/);
  });

  test('load throws helpful error on missing fields', () => {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({ run_id: '123' }), 'utf-8');
    expect(() => stateManager.load()).toThrow(/Malformed run state - missing or invalid workspace_path/);
  });
});
