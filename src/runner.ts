import { StateManager } from "./state";
import * as path from "path";
import * as fs from "fs";

export async function runPhase(phaseName: string, stateManager: StateManager): Promise<void> {
  const state = stateManager.load();
  if (state.status !== 'running') {
    throw new Error('Cannot run phase: Workflow is not running.');
  }

  const model = "sonnet4.5";
  
  const skillPath = path.join(state.workspace_path, "skills", `${phaseName}.md`);
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill file not found for phase: ${phaseName} at ${skillPath}`);
  }

  const { Auggie } = await import("@augmentcode/auggie-sdk");

  const client = await Auggie.create({
    workspaceRoot: state.workspace_path,
    model: model,
    allowIndexing: true,
  });

  try {
    const instruction = `Follow the ${phaseName} skill.`;
    const response = await client.prompt(instruction, { isAnswerOnly: true });
    
    const history = state.history || [];
    history.push({
      phase: phaseName,
      model: model,
      status: 'success',
      outputs: response
    });
    
    stateManager.update({ history });
  } catch (error: any) {
    const history = state.history || [];
    history.push({
      phase: phaseName,
      model: model,
      status: 'failed',
      outputs: error.message || String(error)
    });
    stateManager.update({ history });
    throw error;
  } finally {
    await client.close();
  }
}
