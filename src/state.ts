import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export type WorkflowStatus =
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed";

export interface PhaseResult {
  phase: string;
  model: string;
  status: string;
  outputs: string;
}

export interface RunState {
  run_id: string;
  workspace_path: string;
  current_phase: string;
  status: WorkflowStatus;
  history?: PhaseResult[];
  initial_prompt?: string;
  pending_reply?: string;
  developer_test_failures?: number;
}

export class StateManager {
  private stateFilePath: string;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.stateFilePath = path.join(workspaceRoot, ".agent", "run.json");
  }

  public create(workspaceRoot: string, initialPrompt?: string): RunState {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const state: RunState = {
      run_id: randomUUID(),
      workspace_path: workspaceRoot,
      current_phase: "architect",
      status: "running",
      history: [],
    };

    if (initialPrompt) {
      state.initial_prompt = initialPrompt;
    }

    this.save(state);
    return state;
  }

  public load(): RunState {
    if (!fs.existsSync(this.stateFilePath)) {
      throw new Error(`Run state file not found: ${this.stateFilePath}`);
    }

    let data: string;
    try {
      data = fs.readFileSync(this.stateFilePath, "utf-8");
    } catch (error: any) {
      throw new Error(`Failed to read run state: ${error.message}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch (error: any) {
      throw new Error(`Malformed run state - invalid JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Malformed run state - must be a JSON object");
    }

    if (typeof parsed.run_id !== "string") {
      throw new Error("Malformed run state - missing or invalid run_id");
    }
    if (typeof parsed.workspace_path !== "string") {
      throw new Error(
        "Malformed run state - missing or invalid workspace_path",
      );
    }
    if (typeof parsed.current_phase !== "string") {
      throw new Error("Malformed run state - missing or invalid current_phase");
    }
    if (
      parsed.status !== "running" &&
      parsed.status !== "paused" &&
      parsed.status !== "awaiting_approval" &&
      parsed.status !== "completed"
    ) {
      throw new Error(
        'Malformed run state - status must be "running", "paused", "awaiting_approval", or "completed"',
      );
    }

    return parsed as RunState;
  }

  public save(state: RunState): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      this.stateFilePath,
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  }

  public delete(): void {
    if (fs.existsSync(this.stateFilePath)) {
      fs.unlinkSync(this.stateFilePath);
    }
  }

  public update(updates: Partial<RunState>): RunState {
    const currentState = this.load();
    const newState = { ...currentState, ...updates };
    this.save(newState);
    return newState;
  }

  public cleanupAgentDir(): void {
    const agentDir = path.join(this.workspaceRoot, ".agent");
    if (fs.existsSync(agentDir)) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }
}
