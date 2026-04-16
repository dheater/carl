#!/usr/bin/env node

import { StateManager } from './state';

function main() {
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
  } else {
    console.error('Usage: carl <command>');
    console.error('');
    console.error('Commands:');
    console.error('  start    Start a new workflow run');
    console.error('  status   Show the status of the current workflow run');
    process.exit(1);
  }
}

main();
