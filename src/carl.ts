#!/usr/bin/env node

import { StateManager } from './state';
import { runPhase } from './runner';

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
    const phaseName = args[1];
    if (!phaseName) {
      console.error('Usage: carl run <phase>');
      process.exit(1);
    }
    try {
      console.log(`Starting phase: ${phaseName}`);
      await runPhase(phaseName, stateManager);
      console.log(`Phase ${phaseName} completed successfully.`);
    } catch (error: any) {
      console.error(`Phase ${phaseName} failed: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error('Usage: carl <command>');
    console.error('');
    console.error('Commands:');
    console.error('  start    Start a new workflow run');
    console.error('  status   Show the status of the current workflow run');
    console.error('  run      Run a specific phase (e.g., carl run dani)');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
