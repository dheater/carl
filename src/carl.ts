#!/usr/bin/env node

import { StateManager } from './state';
import { runLoop } from './loop';
import { approveCommand, rejectCommand } from './commands';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const workspaceRoot = process.cwd();
  const stateManager = new StateManager(workspaceRoot);

  if (command === 'start') {
    try {
      const state = stateManager.create(workspaceRoot);
      console.log(`Started workflow run: ${state.run_id}`);
      console.log(`Workspace path: ${state.workspace_path}`);
      console.log(`Current phase: ${state.current_phase}`);
      console.log(`Status: ${state.status}`);
    } catch (error: any) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command === 'status') {
    try {
      const state = stateManager.load();
      console.log(`Run ID: ${state.run_id}`);
      console.log(`Workspace path: ${state.workspace_path}`);
      console.log(`Current phase: ${state.current_phase}`);
      console.log(`Status: ${state.status}`);
    } catch (error: any) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command === 'run') {
    let state = stateManager.load();
    if (state.status === 'awaiting_approval') {
      console.error(`Workflow is awaiting approval. Cannot run until approval is recorded.`);
      process.exit(1);
    }

    try {
      console.log(`Starting automated workflow loop from phase: ${state.current_phase}`);
      await runLoop(stateManager);
    } catch (error: any) {
      console.error(`Workflow loop failed: ${error.message}`);
      process.exit(1);
    }
  } else if (command === 'approve') {
    try {
      approveCommand(workspaceRoot);
      const state = stateManager.load();
      if (state.status === 'completed') {
        console.log(`Approval recorded. Workflow completed.`);
      } else {
        console.log(`Approval recorded. Workflow resumed in phase: ${state.current_phase}`);
      }
    } catch (error: any) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command === 'reject') {
    const reason = args.slice(1).join(' ');
    if (!reason) {
      console.error('Usage: carl reject <reason>');
      process.exit(1);
    }
    try {
      rejectCommand(workspaceRoot, reason);
      console.log(`Approval rejected. Reason: ${reason}.`);
    } catch (error: any) {
      console.error(error.message);
      process.exit(1);
    }
  } else {
    console.error('Usage: carl <command>');
    console.error('');
    console.error('Commands:');
    console.error('  start    Start a new workflow run');
    console.error('  status   Show the status of the current workflow run');
    console.error('  run      Run the workflow loop starting from the current phase');
    console.error('  approve  Approve a paused workflow');
    console.error('  reject   Reject a paused workflow with a <reason>');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
