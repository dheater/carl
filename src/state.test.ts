import { StateManager, RunState } from "./state";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("StateManager", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let stateFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    stateManager = new StateManager(tmpDir);
    stateFilePath = path.join(tmpDir, ".agent", "run.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("create creates a new valid run state", () => {
    const state = stateManager.create(tmpDir);
    expect(state.run_id).toBeDefined();
    expect(state.workspace_path).toBe(tmpDir);
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("running");
    expect(state.history).toEqual([]);

    expect(fs.existsSync(stateFilePath)).toBe(true);
    const savedData = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
    expect(savedData).toEqual(state);
  });

  test("load reads an existing run state", () => {
    const state = stateManager.create(tmpDir);
    const loadedState = stateManager.load();
    expect(loadedState).toEqual(state);
  });

  test("update modifies an existing state and saves it", () => {
    stateManager.create(tmpDir);
    const updatedState = stateManager.update({
      status: "paused",
      current_phase: "developer",
    });
    expect(updatedState.status).toBe("paused");
    expect(updatedState.current_phase).toBe("developer");

    const loadedState = stateManager.load();
    expect(loadedState).toEqual(updatedState);
  });

  test("load throws helpful error on missing file", () => {
    expect(() => stateManager.load()).toThrow(/Run state file not found/);
  });

  test("load throws helpful error on invalid JSON", () => {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, "{ bad json", "utf-8");
    expect(() => stateManager.load()).toThrow(
      /Malformed run state - invalid JSON/,
    );
  });

  test("load throws helpful error on missing fields", () => {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({ run_id: "123" }), "utf-8");
    expect(() => stateManager.load()).toThrow(
      /Malformed run state - missing or invalid workspace_path/,
    );
  });

  test("cleanupAgentDir removes the entire .agent directory", () => {
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "run.json"),
      '{"run_id":"123"}',
      "utf-8",
    );
    fs.writeFileSync(path.join(agentDir, "extra-file.txt"), "extra", "utf-8");

    expect(fs.existsSync(agentDir)).toBe(true);

    stateManager.cleanupAgentDir();

    expect(fs.existsSync(agentDir)).toBe(false);
  });

  test("cleanupAgentDir is idempotent", () => {
    const agentDir = path.join(tmpDir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "run.json"),
      '{"run_id":"123"}',
      "utf-8",
    );

    stateManager.cleanupAgentDir();
    stateManager.cleanupAgentDir();

    expect(fs.existsSync(agentDir)).toBe(false);
  });

  test("cleanupAgentDir removes nested subdirectories", () => {
    const agentDir = path.join(tmpDir, ".agent");
    const notesDir = path.join(agentDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "architect.md"), "notes", "utf-8");
    fs.writeFileSync(
      path.join(agentDir, "run.json"),
      '{"run_id":"123"}',
      "utf-8",
    );

    stateManager.cleanupAgentDir();

    expect(fs.existsSync(agentDir)).toBe(false);
  });

  describe("start command scenario (.agent cleanup)", () => {
    test("start cleanup: removes old .agent on completed run, then creates new state", () => {
      const agentDir = path.join(tmpDir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });

      const oldState = stateManager.create(tmpDir);
      stateManager.update({ status: "completed" });

      fs.writeFileSync(path.join(agentDir, "old-note.txt"), "old", "utf-8");

      expect(fs.existsSync(path.join(agentDir, "old-note.txt"))).toBe(true);

      try {
        const existing = stateManager.load();
        if (existing.status === "completed") {
          stateManager.cleanupAgentDir();
        }
      } catch {
        // No existing state
      }

      expect(fs.existsSync(agentDir)).toBe(false);

      const newState = stateManager.create(tmpDir, "new prompt");
      expect(newState.status).toBe("running");
      expect(fs.existsSync(stateFilePath)).toBe(true);
      expect(fs.existsSync(path.join(agentDir, "old-note.txt"))).toBe(false);
    });

    test("start with active run: does NOT cleanup .agent when status is not completed", () => {
      stateManager.create(tmpDir);
      stateManager.update({ status: "running" });

      const agentDir = path.join(tmpDir, ".agent");
      const sentinelFile = path.join(agentDir, "should-not-be-touched.txt");
      fs.writeFileSync(sentinelFile, "preserve", "utf-8");

      try {
        const existing = stateManager.load();
        if (existing.status === "completed") {
          stateManager.cleanupAgentDir();
        } else {
          expect(fs.existsSync(sentinelFile)).toBe(true);
        }
      } catch {
        // No existing state
      }

      expect(fs.existsSync(sentinelFile)).toBe(true);
    });
  });

  describe("reset command scenario (.agent cleanup)", () => {
    test("reset removes entire .agent directory including run.json and all contents", () => {
      const agentDir = path.join(tmpDir, ".agent");

      stateManager.create(tmpDir);
      fs.writeFileSync(path.join(agentDir, "extra.txt"), "extra", "utf-8");

      const notesDir = path.join(agentDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(path.join(notesDir, "architect.md"), "notes", "utf-8");

      expect(fs.existsSync(agentDir)).toBe(true);

      stateManager.cleanupAgentDir();

      expect(fs.existsSync(agentDir)).toBe(false);
      expect(fs.existsSync(stateFilePath)).toBe(false);
    });

    test("reset is idempotent: calling on non-existent .agent does not throw", () => {
      const agentDir = path.join(tmpDir, ".agent");
      expect(fs.existsSync(agentDir)).toBe(false);

      expect(() => stateManager.cleanupAgentDir()).not.toThrow();
      expect(fs.existsSync(agentDir)).toBe(false);
    });

    test("reset: multiple calls are safe and don't throw", () => {
      const agentDir = path.join(tmpDir, ".agent");

      stateManager.create(tmpDir);
      expect(fs.existsSync(agentDir)).toBe(true);

      stateManager.cleanupAgentDir();
      expect(fs.existsSync(agentDir)).toBe(false);

      expect(() => stateManager.cleanupAgentDir()).not.toThrow();
      expect(fs.existsSync(agentDir)).toBe(false);
    });
  });
});
