import { runLoop } from "./loop";
import { StateManager } from "./state";
import { HAPPY_PATH_GRAPH } from "./graph";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("@augmentcode/auggie-sdk", () => ({
  Auggie: {
    create: jest.fn(),
  },
  DirectContext: {
    // Default: no prior context file, fresh context with empty search results
    create: jest.fn().mockResolvedValue({
      search: jest.fn().mockResolvedValue(""),
      addToIndex: jest
        .fn()
        .mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] }),
      exportToFile: jest.fn().mockResolvedValue(undefined),
    }),
    importFromFile: jest.fn().mockRejectedValue(new Error("no context file")),
  },
}));

const { Auggie, DirectContext } = require("@augmentcode/auggie-sdk");

describe("Workflow Loop", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockPrompt: jest.Mock;
  let mockClose: jest.Mock;

  let mockOnSessionUpdate: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-test-"));
    stateManager = new StateManager(tmpDir);
    stateManager.create(tmpDir);

    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    for (const phase of HAPPY_PATH_GRAPH) {
      fs.writeFileSync(
        path.join(skillsDir, `${phase}.md`),
        `dummy ${phase} skill`,
      );
    }

    mockPrompt = jest.fn().mockResolvedValue("mocked response");
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockOnSessionUpdate = jest.fn();

    (Auggie.create as jest.Mock).mockResolvedValue({
      prompt: mockPrompt,
      close: mockClose,
      onSessionUpdate: mockOnSessionUpdate,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("runs the full happy path until the first gate and pauses", async () => {
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("architect");
    // History should have 1 entry: architect
    expect(state.history).toHaveLength(1);
    expect(state.history![0].phase).toBe("architect");

    // Check Auggie calls
    expect(mockPrompt).toHaveBeenCalledTimes(1);

    expect(Auggie.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceRoot: tmpDir,
        model: "gpt5.1", // architect
        allowIndexing: true,
      }),
    );
  });

  test("resumes from a non-gate phase and continues to next gate", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Test\n\nAC:\n- Test",
        },
      ],
    });
    await runLoop(stateManager);

    const state = stateManager.load();
    expect(state.status).toBe("awaiting_approval");
    expect(state.current_phase).toBe("reviewer");
    expect(state.history).toHaveLength(3); // architect (prior), developer, reviewer (now at gate)
    expect(mockPrompt).toHaveBeenCalledTimes(2); // developer and reviewer both run before gate pauses

    expect(Auggie.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: "haiku4.5", // developer
      }),
    );
    expect(Auggie.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "gemini-3.1-pro-preview", // reviewer
      }),
    );
  });

  test("developer blocker transitions back to architect", async () => {
    stateManager.update({ current_phase: "developer", status: "running" });
    mockPrompt.mockResolvedValueOnce("blocked: missing PRD info");

    // It will run developer, get blocked, transition to architect, run architect, then developer, etc.
    // To prevent infinite loop in tests, let's mock the second prompt (architect) to throw so it stops.
    mockPrompt.mockRejectedValueOnce(new Error("stop loop"));

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();
    // developer (blocked) -> architect (throws)
    expect(state.history).toHaveLength(2);
    expect(state.history![0]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "blocked",
        outputs: "blocked: missing PRD info",
      }),
    );
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "architect",
        status: "failed",
      }),
    );
    expect(state.current_phase).toBe("architect");
  });

  test("developer BLOCKER: prefix is detected as blocked", async () => {
    stateManager.update({
      current_phase: "developer",
      status: "running",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "# Tickets\n\n## [ ] t-1: Sample\n\nAC:\n- Sample",
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("blocked: no implementation exists yet");
    mockPrompt.mockRejectedValueOnce(new Error("stop loop"));

    await expect(runLoop(stateManager)).rejects.toThrow("stop loop");

    const state = stateManager.load();
    expect(state.history![1]).toEqual(
      expect.objectContaining({
        phase: "developer",
        status: "blocked",
      }),
    );
  });

  test("injects pending_reply into instruction and clears it", async () => {
    stateManager.update({
      current_phase: "architect",
      status: "running",
      initial_prompt: "build a feature",
      pending_reply: "use the repo root as scope",
    });

    mockPrompt.mockResolvedValueOnce("plan output");

    await runLoop(stateManager);

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Human reply\n\nuse the repo root as scope"),
      expect.any(Object),
    );

    // pending_reply must be cleared after use
    const state = stateManager.load();
    expect(state.pending_reply).toBeUndefined();
  });

  test("passes rejection reason as feedback on retry", async () => {
    stateManager.update({
      current_phase: "architect",
      status: "running",
      initial_prompt: "build a feature",
      history: [
        {
          phase: "architect",
          model: "system",
          status: "rejected",
          outputs: "Approval rejected: too complex",
        },
      ],
    });

    mockPrompt.mockResolvedValueOnce("retry output");

    await runLoop(stateManager);

    // Initial prompt is NOT re-injected on retry — prior architect history already carries context
    expect(mockPrompt).not.toHaveBeenCalledWith(
      expect.stringContaining("User request"),
      expect.any(Object),
    );
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "# Rejection feedback\n\nApproval rejected: too complex\n\nPlease incorporate this feedback and try again.",
      ),
      expect.any(Object),
    );
  });

  test("injects context search result on reply when context engine has prior output", async () => {
    const priorQuestions = "What is the scope? What language do you prefer?";
    const mockContextInstance = {
      search: jest.fn().mockResolvedValue(priorQuestions),
      addToIndex: jest
        .fn()
        .mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] }),
      exportToFile: jest.fn().mockResolvedValue(undefined),
    };
    (DirectContext.create as jest.Mock).mockResolvedValueOnce(
      mockContextInstance,
    );

    stateManager.update({
      current_phase: "architect",
      status: "running",
      pending_reply: "repo root, standard tooling",
    });
    mockPrompt.mockResolvedValueOnce("plan with context");

    await runLoop(stateManager);

    // Context search result replaces raw prior output
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Prior context\n\n" + priorQuestions),
      expect.any(Object),
    );
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Human reply\n\nrepo root, standard tooling"),
      expect.any(Object),
    );
    // Raw prior output section is NOT used when context search returns results
    expect(mockPrompt).not.toHaveBeenCalledWith(
      expect.stringContaining("# Your previous output"),
      expect.any(Object),
    );
    // Context is indexed and persisted after the run
    expect(mockContextInstance.addToIndex).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("agent-log/architect-"),
        }),
      ]),
    );
    expect(mockContextInstance.exportToFile).toHaveBeenCalled();
  });

  test("injects cross-phase context when a fresh phase starts after a different phase", async () => {
    const developerOutput = "Developer implemented t-1: added auth middleware";
    const mockContextInstance = {
      search: jest.fn().mockResolvedValue(developerOutput),
      addToIndex: jest
        .fn()
        .mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] }),
      exportToFile: jest.fn().mockResolvedValue(undefined),
    };
    (DirectContext.create as jest.Mock).mockResolvedValueOnce(
      mockContextInstance,
    );

    stateManager.update({
      current_phase: "reviewer",
      status: "running",
      history: [
        {
          phase: "developer",
          model: "haiku4.5",
          status: "success",
          outputs: developerOutput,
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("reviewer approved");

    await runLoop(stateManager);

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("# Prior workflow context\n\n" + developerOutput),
      expect.any(Object),
    );
  });

  test("falls back to raw prior output when context search returns empty", async () => {
    // Default mock returns '' from search — verify fallback path
    stateManager.update({
      current_phase: "architect",
      status: "running",
      pending_reply: "use repo root",
      history: [
        {
          phase: "architect",
          model: "gpt5.1",
          status: "success",
          outputs: "Previous architect output with questions",
        },
      ],
    });
    mockPrompt.mockResolvedValueOnce("reply output");

    await runLoop(stateManager);

    // Falls back to raw prior output since context.search() returned ''
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "# Your previous output\n\nPrevious architect output with questions",
      ),
      expect.any(Object),
    );
  });

  test("reuses Auggie session for the same phase across a reply gate round-trip", async () => {
    const { replyCommand } = require("./commands");

    // First run: architect gate
    await runLoop(stateManager);
    let state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");
    expect(Auggie.create).toHaveBeenCalledTimes(1);

    // Simulate a reply that keeps us in the architect phase
    replyCommand(tmpDir, "clarification reply");

    // Second run: architect again with pending_reply; should reuse session
    await runLoop(stateManager);
    state = stateManager.load();
    expect(state.current_phase).toBe("architect");
    expect(state.status).toBe("awaiting_approval");
    // Auggie.create should not be called again for the same run + phase
    expect(Auggie.create).toHaveBeenCalledTimes(1);
  });
});

describe("Skill files - deterministic format/lint integration", () => {
  test("skills/developer.md notes that carl will re-run format/lint", () => {
    const developerPath = path.join(__dirname, "..", "skills", "developer.md");
    const content = fs.readFileSync(developerPath, "utf-8");
    // Check that it mentions workflow re-running format/lint
    expect(content).toMatch(/workflow.*re-run.*deterministically/i);
    expect(content).toMatch(/format/i);
  });
});

// Tests for t-1: buildSkillInstruction includes branch context and proposed commit message section
describe("buildSkillInstruction for reviewer with branch context", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-test-"));
    // Create required skill files
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(
      path.join(skillsDir, "reviewer.md"),
      "# Reviewer skill\n\nValidate the work.",
    );
    fs.writeFileSync(
      path.join(skillsDir, "developer.md"),
      "# Developer skill\n\nImplement the code.",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test("reviewer instructions include Proposed commit message section with branch context for ticket branch", async () => {
    // Mock git functions for this test
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("CLIENTS-934-download-fixes");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/index.ts"],
      untracked: [],
    });

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    // AC 1: Instructions include "## Proposed commit message" heading
    expect(instruction).toMatch(/## Proposed commit message/i);

    // AC 2: Instructions tell agent to produce subject + body for code changes
    expect(instruction).toMatch(/subject.*body|commit subject|commit message/i);
    expect(instruction).toMatch(/code.*changes|behavior.*changes/i);

    // AC 3: Instructions explicitly tell agent to avoid mentioning gates/phases/checklists in the commit message itself
    expect(instruction).toMatch(
      /no mentions?.*gates|phases|checklists|not.*workflow.*meta/i,
    );

    // AC 4: Instructions include branch name "CLIENTS-934-download-fixes"
    expect(instruction).toMatch(/CLIENTS-934-download-fixes/);

    // AC 5: Instructions show current branch context clearly
    expect(instruction).toMatch(/current branch/i);
  });

  test("reviewer instructions use conventional-commit prefix for non-ticket branch", async () => {
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("main");
    (gitModule.getGitStatus as jest.Mock) = jest.fn().mockReturnValue({
      isRepo: true,
      trackedChanged: ["src/index.ts"],
      untracked: [],
    });

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("reviewer", tmpDir);

    // AC: For non-ticket branch, guidance calls for conventional-commit prefix
    expect(instruction).toMatch(/fix:|chore:|feat:|docs:|refactor:|style:/i);
    expect(instruction).toMatch(/conventional.?commit/i);
  });

  test("reviewer instructions for non-reviewer phases are not affected", async () => {
    const gitModule = require("./git");
    (gitModule.getCurrentBranch as jest.Mock) = jest
      .fn()
      .mockReturnValue("CLIENTS-934-download-fixes");

    const loopModule = require("./loop");
    const instruction = loopModule.buildSkillInstruction("developer", tmpDir);

    // Developer instructions should NOT include proposed commit message section
    expect(instruction).not.toMatch(/## Proposed commit message/i);
  });
});
