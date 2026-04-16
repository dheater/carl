import { StateManager, validateArtifacts } from "./state";
import { getNextPhase, getFallbackPhase } from "./graph";
import { parseTickets, generateTicketsMarkdown } from "./tickets";
import * as path from "path";
import * as fs from "fs";

export async function runLoop(stateManager: StateManager): Promise<void> {
  let state = stateManager.load();
  validateArtifacts(state);

  if (state.status === 'awaiting_approval') {
    throw new Error('Workflow is awaiting approval. Run `carl approve` or `carl reject`.');
  }

  // Ensure we are in a running state to start the loop
  if (state.status === 'paused') {
    state = stateManager.update({ status: 'running' });
  }

  const { Auggie } = await import("@augmentcode/auggie-sdk");

  while (state.status === 'running') {
    const phaseName = state.current_phase;
    const model = "sonnet4.5"; // Could be derived from phase config eventually

    const skillPath = path.join(state.workspace_path, "skills", `${phaseName}.md`);
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill file not found for phase: ${phaseName} at ${skillPath}`);
    }

    console.log(`Starting phase: ${phaseName}`);
    
    const client = await Auggie.create({
      workspaceRoot: state.workspace_path,
      model: model,
      allowIndexing: true,
    });

    try {
      const instruction = `Follow the ${phaseName} skill.`;
      const response = await client.prompt(instruction, { isAnswerOnly: true });

      const isBlocked = phaseName === 'grey' && /blocked:/i.test(response);

      const history = state.history || [];
      history.push({
        phase: phaseName,
        model: model,
        status: isBlocked ? 'blocked' : 'success',
        outputs: response
      });

      const artifacts = state.artifacts || {};
      const agentDir = path.join(state.workspace_path, '.agent');

      if (!isBlocked) {
        if (phaseName === 'dani') {
          artifacts.slicePlan = response;
          const notesDir = path.join(agentDir, 'notes');
          if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
          fs.writeFileSync(path.join(notesDir, 'slice-plan.md'), response, 'utf-8');
        } else if (phaseName === 'dani-tickets') {
          artifacts.tickets = parseTickets(response);
          fs.writeFileSync(path.join(agentDir, 'tickets.md'), generateTicketsMarkdown('Workflow Orchestrator', artifacts.tickets), 'utf-8');
        } else if (phaseName === 'lewis-qa') {
          artifacts.qaPlan = response;
          fs.writeFileSync(path.join(agentDir, 'qa-plan.md'), response, 'utf-8');
        }
      }

      if (isBlocked) {
        const fallback = getFallbackPhase(phaseName);
        state = stateManager.update({
          history,
          artifacts,
          current_phase: fallback,
        });
        console.log(`Phase ${phaseName} reported a blocker. Handing back to ${fallback}.`);
        continue;
      }

      const isGate = phaseName.endsWith('-gate') || phaseName === 'lewis';
      const nextPhase = getNextPhase(phaseName);

      if (isGate) {
        state = stateManager.update({
          history,
          artifacts,
          status: 'awaiting_approval',
          // Stay on the gate phase while awaiting approval
        });
        console.log(`Phase ${phaseName} completed. Awaiting approval.`);
        break; // Pause loop
      } else if (nextPhase) {
        state = stateManager.update({
          history,
          artifacts,
          current_phase: nextPhase,
        });
        console.log(`Phase ${phaseName} completed successfully. Advancing to ${nextPhase}.`);
      } else {
        // End of graph
        state = stateManager.update({
          history,
          artifacts,
          status: 'completed', // Or "completed" if we add that status
        });
        console.log(`Phase ${phaseName} completed. Workflow finished.`);
        break; // Exit loop
      }
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
}
