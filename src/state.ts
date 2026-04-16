import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type WorkflowStatus = 'running' | 'paused' | 'awaiting_approval' | 'completed';

export interface PhaseResult {
  phase: string;
  model: string;
  status: string;
  outputs: string;
}

import { Ticket, generateTicketsMarkdown } from './tickets';

export interface Artifacts {
  slicePlan?: string;
  tickets?: any[];
  qaPlan?: string;
}

export interface RunState {
  run_id: string;
  workspace_path: string;
  current_phase: string;
  status: WorkflowStatus;
  history?: PhaseResult[];
  artifacts?: Artifacts;
}

export function validateArtifacts(state: RunState): void {
  if (!state.artifacts) return;

  const artifactsPath = path.join(state.workspace_path, '.agent');
  const ticketsPath = path.join(artifactsPath, 'tickets.md');
  const qaPlanPath = path.join(artifactsPath, 'qa-plan.md');
  const slicePlanPath = path.join(artifactsPath, 'notes', 'slice-plan.md');

  if (state.artifacts.tickets && fs.existsSync(ticketsPath)) {
    const content = fs.readFileSync(ticketsPath, 'utf-8');
    const expected = generateTicketsMarkdown('Workflow Orchestrator', state.artifacts.tickets);
    if (content.trim() !== expected.trim()) {
      throw new Error(`Markdown artifact ${ticketsPath} diverges from authoritative state.`);
    }
  }

  if (state.artifacts.slicePlan && fs.existsSync(slicePlanPath)) {
    const content = fs.readFileSync(slicePlanPath, 'utf-8');
    if (content.trim() !== state.artifacts.slicePlan.trim()) {
      throw new Error(`Markdown artifact ${slicePlanPath} diverges from authoritative state.`);
    }
  }

  if (state.artifacts.qaPlan && fs.existsSync(qaPlanPath)) {
    const content = fs.readFileSync(qaPlanPath, 'utf-8');
    if (content.trim() !== state.artifacts.qaPlan.trim()) {
      throw new Error(`Markdown artifact ${qaPlanPath} diverges from authoritative state.`);
    }
  }
}

export class StateManager {
  private stateFilePath: string;

  constructor(workspaceRoot: string) {
    this.stateFilePath = path.join(workspaceRoot, '.agent', 'run.json');
  }

  public create(workspaceRoot: string): RunState {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const state: RunState = {
      run_id: randomUUID(),
      workspace_path: workspaceRoot,
      current_phase: 'dani',
      status: 'running',
      history: [],
    };

    this.save(state);
    return state;
  }

  public load(): RunState {
    if (!fs.existsSync(this.stateFilePath)) {
      throw new Error(`Run state file not found: ${this.stateFilePath}`);
    }

    let data: string;
    try {
      data = fs.readFileSync(this.stateFilePath, 'utf-8');
    } catch (error: any) {
      throw new Error(`Failed to read run state: ${error.message}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch (error: any) {
      throw new Error(`Malformed run state - invalid JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Malformed run state - must be a JSON object');
    }

    if (typeof parsed.run_id !== 'string') {
      throw new Error('Malformed run state - missing or invalid run_id');
    }
    if (typeof parsed.workspace_path !== 'string') {
      throw new Error('Malformed run state - missing or invalid workspace_path');
    }
    if (typeof parsed.current_phase !== 'string') {
      throw new Error('Malformed run state - missing or invalid current_phase');
    }
    if (parsed.status !== 'running' && parsed.status !== 'paused' && parsed.status !== 'awaiting_approval' && parsed.status !== 'completed') {
      throw new Error('Malformed run state - status must be "running", "paused", "awaiting_approval", or "completed"');
    }

    return parsed as RunState;
  }

  public save(state: RunState): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  public update(updates: Partial<RunState>): RunState {
    const currentState = this.load();
    const newState = { ...currentState, ...updates };
    this.save(newState);
    return newState;
  }
}
