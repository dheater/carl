#!/usr/bin/env node

import { StateManager } from "./state";
import { runLoop, closeSharedClient } from "./loop";
import { approveCommand, rejectCommand, replyCommand } from "./commands";
import { openEditorForGate, collectPrompt } from "./editor";
import { red, blue } from "./colors";

async function runWithEditor(
  stateManager: StateManager,
  workspaceRoot: string,
): Promise<void> {
  try {
    while (true) {
      await runLoop(stateManager);
      const state = stateManager.load();

      if (state.status !== "awaiting_approval") break;

      const phase = state.current_phase;
      const lastOutput =
        state.history
          ?.slice()
          .reverse()
          .find((h) => h.phase === phase && h.status !== "rejected")?.outputs ??
        "";
      console.log(
        `\n  [System] ${phase} is waiting for your input. Opening editor...\n`,
      );
      const result = openEditorForGate(phase, lastOutput);

      if (result.action === "approve") {
        approveCommand(workspaceRoot);
        const next = stateManager.load();
        if (next.status === "completed") {
          console.log("\n  [System] Workflow complete. Sprint approved.\n");
          break;
	        }
      } else if (result.action === "reject") {
        rejectCommand(
          workspaceRoot,
          result.reason,
          result.target,
          result.fullBuffer,
        );
        const after = stateManager.load();
        console.log(
          blue(
            `  [System] ${phase} rejected. Returning to ${after.current_phase}.`,
          ),
        );
      } else {
        replyCommand(workspaceRoot, result.message);
      }
    }
  } finally {
    // Close any lingering handles on normal completion or error
    await closeSharedClient();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const workspaceRoot = process.cwd();
  const stateManager = new StateManager(workspaceRoot);

  if (command === "start") {
    let prompt = args.slice(1).join(" ");
    try {
      // Guard against wiping an in-progress run
      try {
        const existing = stateManager.load();
        if (existing.status !== "completed") {
          console.error(
            red(
              `A workflow is already active (run: ${existing.run_id}, status: ${existing.status}, phase: ${existing.current_phase}).`,
            ),
          );
          console.error(red(`Use 'carl run' to continue it.`));
          process.exit(1);
        }
        // Cleanup old completed run before starting new one
        stateManager.cleanupAgentDir();
	      } catch {}

      if (!prompt) {
        const collected = collectPrompt();
        if (!collected) {
          console.log("No prompt provided. Cancelled.");
          process.exit(0);
        }
        prompt = collected;
      }

      const state = stateManager.create(workspaceRoot, prompt);
      console.log(`Started workflow run: ${state.run_id}`);

      await runWithEditor(stateManager, workspaceRoot);
    } catch (error: any) {
      console.error(red(error.message));
      process.exit(1);
    }
  } else if (command === "status") {
    try {
      const state = stateManager.load();
      console.log(`Run ID: ${state.run_id}`);
      console.log(`Workspace path: ${state.workspace_path}`);
      console.log(`Current phase: ${state.current_phase}`);
      console.log(`Status: ${state.status}`);
    } catch (error: any) {
      console.error(red(error.message));
      process.exit(1);
    }
  } else if (command === "run") {
    try {
      const state = stateManager.load();
      if (state.status === "completed") {
        console.log(
          `Workflow already completed (phase: ${state.current_phase}). Use 'carl start "<prompt>"' to begin a new run, or 'carl reset' to clear state.`,
        );
        await closeSharedClient();
        process.exit(0);
      }
	      console.log(`Resuming workflow from phase: ${state.current_phase}`);
      if (state.status === "awaiting_approval") {
        const phase = state.current_phase;
        const lastOutput =
          state.history
            ?.slice()
            .reverse()
            .find((h) => h.phase === phase && h.status !== "rejected")
            ?.outputs ?? "";
        console.log(
          `\n  [System] ${phase} is waiting for your input. Opening editor...\n`,
        );
        const result = openEditorForGate(phase, lastOutput);
        if (result.action === "approve") {
          approveCommand(workspaceRoot);
          const updatedState = stateManager.load();
          if (updatedState.status === "completed" && phase === "reviewer") {
            console.log("\n  [System] Workflow complete. Sprint approved.\n");
            await closeSharedClient();
            return;
          }
        } else if (result.action === "reject") {
          rejectCommand(
            workspaceRoot,
            result.reason,
            result.target,
            result.fullBuffer,
          );
          const after = stateManager.load();
          console.log(
            blue(
              `  [System] ${phase} rejected. Returning to ${after.current_phase}.`,
            ),
          );
        } else replyCommand(workspaceRoot, result.message);
      }
      await runWithEditor(stateManager, workspaceRoot);
    } catch (error: any) {
      console.error(red(`Workflow loop failed: ${error.message}`));
      await closeSharedClient();
      process.exit(1);
    }
  } else if (command === "reset") {
    try {
      const existing = stateManager.load();
      console.log(
        `Abandoning run: ${existing.run_id} (phase: ${existing.current_phase}, status: ${existing.status})`,
      );
	      } catch {}
    stateManager.cleanupAgentDir();
    console.log(
      "Run cleared. Use 'carl start \"<prompt>\"' to begin a new run.",
    );
  } else {
    console.error("Usage: carl <command>");
    console.error("");
    console.error("Commands:");
    console.error(
      "  start    Start a new workflow run (fails if one is already active)",
    );
    console.error(
      "  run      Resume — opens editor at any gate waiting for input",
    );
    console.error("  status   Show the status of the current workflow run");
    console.error("  reset    Abandon the current run and clear state");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
