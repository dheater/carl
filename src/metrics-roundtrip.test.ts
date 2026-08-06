/**
 * End-to-end contract test: events written by `runSkill` must be ingestible by
 * `metrics-db` and appear in the report. Each side is unit-tested separately, so
 * only a round trip catches the two drifting apart — a renamed field would leave
 * both suites green while `carl stats` silently reported nothing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runSkill } from "./skill";
import { openMetricsDb, ingestLiveLog } from "./metrics-db";
import { resolveRange, buildReport } from "./stats";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResponse,
  UsageSummary,
} from "./types";
import { AgentRunError } from "./types";

jest.mock("./git", () => ({
  getCurrentBranch: jest.fn().mockReturnValue("feature/METRICS-1"),
  getHeadShaOrNull: jest.fn().mockReturnValue("cafe1234"),
  getGitStatus: jest.fn().mockReturnValue({
    isRepo: true,
    trackedChanged: ["src/a.ts"],
    untracked: [],
  }),
  getGitDiff: jest.fn().mockReturnValue(""),
}));

const USAGE: UsageSummary = {
  source: "bedrock",
  modelId: "us.anthropic.claude-sonnet-4-6",
  inputTokens: 100_000,
  outputTokens: 10_000,
  cacheReadTokens: 900_000,
  cacheWriteTokens: 50_000,
  latencyMs: 45_000,
  turns: 7,
};

class MockRunner implements AgentRunner {
  constructor(
    private readonly usage: UsageSummary | undefined = USAGE,
    private readonly toolCalls: Array<{
      tool: string;
      inputSummary: string;
      outputBytes: number;
      durationMs: number;
      error: boolean;
    }> = [],
    private readonly failWith?: Error,
  ) {}

  async run(req: AgentRunRequest): Promise<AgentRunResponse> {
    for (const call of this.toolCalls) req.onToolCall?.(call);
    if (this.failWith) throw this.failWith;
    return { text: "# Summary\n\nDone.", usage: this.usage };
  }
}

let workspaceRoot: string;
let configDir: string;
let logSpy: jest.SpyInstance;

/** Whole-time range, so the test never depends on today's date. */
const ALL_TIME = resolveRange({ kind: "all" });

function report(skill?: string) {
  const db = openMetricsDb(path.join(configDir, "metrics.db"));
  try {
    const ingest = ingestLiveLog(db);
    return { ingest, report: buildReport(db, ALL_TIME, skill) };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-rt-ws-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-rt-cfg-"));
  process.env.CARL_CONFIG_DIR = configDir;
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  delete process.env.CARL_CONFIG_DIR;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("a code run written by runSkill is ingested and priced", async () => {
  await runSkill(
    workspaceRoot,
    "code",
    "build it",
    "sonnet4.6",
    "medium",
    new MockRunner(USAGE, [
      {
        tool: "bash",
        inputSummary: "npm test",
        outputBytes: 2048,
        durationMs: 130,
        error: false,
      },
      {
        tool: "read_file",
        inputSummary: "src/a.ts",
        outputBytes: 512,
        durationMs: 4,
        error: true,
      },
    ]),
  );

  const { ingest, report: r } = report();
  expect(ingest.malformedLines).toBe(0);
  expect(ingest.eventsSkipped).toBe(0);
  expect(r.totalRuns).toBe(1);
  expect(r.unpricedRuns).toBe(0);

  const [code] = r.skills;
  expect(code.skill).toBe("code");
  // 100k + 900k cache read + 50k cache write, at sonnet rates.
  expect(code.costUsd).toBeCloseTo(
    (100_000 * 3.0 + 10_000 * 15.0 + 50_000 * 3.75 + 900_000 * 0.3) / 1_000_000,
    6,
  );
  expect(code.p50Turns).toBe(7);
  expect(code.p50Tokens).toBe(1_050_000);
  expect(code.cacheHitRatio).toBeCloseTo(900_000 / 1_050_000, 6);
  expect(code.p50DurationMs).toBeGreaterThan(0);

  expect(r.tools.map((t) => t.tool).sort()).toEqual(["bash", "read_file"]);
  expect(r.tools.find((t) => t.tool === "read_file")!.errors).toBe(1);
});

test("workspace, branch, sha, and effort survive the round trip", async () => {
  await runSkill(
    workspaceRoot,
    "code",
    "build it",
    "sonnet4.6",
    "high",
    new MockRunner(),
  );

  const { report: r } = report();
  expect(r.workspaces).toEqual([
    expect.objectContaining({ workspace: workspaceRoot, runs: 1 }),
  ]);
  expect(r.efforts).toEqual([
    expect.objectContaining({ effort: "high", runs: 1 }),
  ]);

  const db = openMetricsDb(path.join(configDir, "metrics.db"));
  try {
    const row = db.prepare("SELECT * FROM runs").get() as any;
    expect(row.git_branch).toBe("feature/METRICS-1");
    expect(row.git_sha).toBe("cafe1234");
    expect(row.invocation_id).toBeTruthy();
  } finally {
    db.close();
  }
});

test("a pr-review run reaches the report with a cost", async () => {
  await runSkill(
    workspaceRoot,
    "pr-review",
    "review this PR",
    "sonnet4.6",
    "high",
    new MockRunner(),
  );

  const { report: r } = report();
  expect(r.skills.map((s) => s.skill)).toEqual(["pr-review"]);
  expect(r.skills[0].costUsd).toBeGreaterThan(0);
  expect(r.unpricedRuns).toBe(0);
});

test("a failed run still reports the tokens it burned", async () => {
  const spent: UsageSummary = {
    source: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6",
    inputTokens: 500_000,
    outputTokens: 0,
    turns: 80,
  };

  await expect(
    runSkill(
      workspaceRoot,
      "code",
      "build it",
      "sonnet4.6",
      "medium",
      new MockRunner(undefined, [], new AgentRunError("max turns", spent)),
    ),
  ).rejects.toThrow(/max turns/);

  const { report: r } = report();
  expect(r.totalRuns).toBe(1);
  expect(r.skills[0].errors).toBe(1);
  expect(r.skills[0].costUsd).toBeCloseTo(1.5, 6);
  expect(r.skills[0].maxTurnsExhausted).toBe(1);
});

test("two runs in one process are two runs but one invocation", async () => {
  for (const prompt of ["first", "second"]) {
    await runSkill(
      workspaceRoot,
      "pr-review",
      prompt,
      "sonnet4.6",
      "high",
      new MockRunner(),
    );
  }

  const { report: r } = report();
  expect(r.totalRuns).toBe(2);

  const db = openMetricsDb(path.join(configDir, "metrics.db"));
  try {
    const rows = db.prepare("SELECT invocation_id FROM runs").all() as any[];
    expect(new Set(rows.map((row) => row.invocation_id)).size).toBe(1);
  } finally {
    db.close();
  }
});

test("re-ingesting after a further run adds only the new run", async () => {
  await runSkill(
    workspaceRoot,
    "code",
    "one",
    "sonnet4.6",
    "medium",
    new MockRunner(),
  );
  const first = report();
  expect(first.report.totalRuns).toBe(1);

  await runSkill(
    workspaceRoot,
    "review",
    "two",
    "sonnet4.6",
    "medium",
    new MockRunner(),
  );
  const second = report();

  expect(second.report.totalRuns).toBe(2);
  expect(second.ingest.runsTouched).toBe(1);
  expect(second.report.skills.map((s) => s.skill).sort()).toEqual([
    "code",
    "review",
  ]);
});
