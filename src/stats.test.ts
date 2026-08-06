import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";

import { openMetricsDb, ingestFile } from "./metrics-db";
import {
  resolveRange,
  queryRuns,
  totalTokens,
  summarizeSkill,
  buildReport,
  renderReport,
  type RunRow,
} from "./stats";

describe("resolveRange", () => {
  // A Thursday, so the Monday-start week boundary is unambiguous.
  const thursday = new Date(2026, 7, 6, 14, 30);

  test("this-week starts on Monday at local midnight", () => {
    const range = resolveRange({ kind: "this-week" }, thursday);
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 7, 3, 0, 0, 0, 0));
    expect(range.label).toContain("2026-08-03");
  });

  test("this-week treats Sunday as the end of the week, not the start", () => {
    const sunday = new Date(2026, 7, 9, 9, 0);
    const range = resolveRange({ kind: "this-week" }, sunday);
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 7, 3));
  });

  test("this-week on a Monday starts that same day", () => {
    const monday = new Date(2026, 7, 3, 0, 30);
    const range = resolveRange({ kind: "this-week" }, monday);
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 7, 3));
  });

  test("the end is exclusive tomorrow-midnight, so today's runs are included", () => {
    const range = resolveRange({ kind: "this-week" }, thursday);
    expect(new Date(range.toMs)).toEqual(new Date(2026, 7, 7));
    expect(range.toMs).toBeGreaterThan(thursday.getTime());
  });

  test("this-month starts on the first of the month", () => {
    const range = resolveRange({ kind: "this-month" }, thursday);
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 7, 1));
  });

  test("this-year starts on January 1", () => {
    const range = resolveRange({ kind: "this-year" }, thursday);
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 0, 1));
  });

  test("all spans everything", () => {
    const range = resolveRange({ kind: "all" }, thursday);
    expect(range.fromMs).toBe(0);
    expect(range.toMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("explicit --to is inclusive of the named day", () => {
    const range = resolveRange(
      { kind: "explicit", from: "2026-08-01", to: "2026-08-05" },
      thursday,
    );
    expect(new Date(range.fromMs)).toEqual(new Date(2026, 7, 1));
    // Half-open: the bound is the next midnight, so 2026-08-05 runs count.
    expect(new Date(range.toMs)).toEqual(new Date(2026, 7, 6));
  });

  test("explicit --from alone runs to today", () => {
    const range = resolveRange(
      { kind: "explicit", from: "2026-08-01" },
      thursday,
    );
    expect(new Date(range.toMs)).toEqual(new Date(2026, 7, 7));
  });

  test("rejects a malformed date with an actionable message", () => {
    expect(() =>
      resolveRange({ kind: "explicit", from: "08/01/2026" }, thursday),
    ).toThrow(/Expected YYYY-MM-DD/);
  });

  test("rejects a backwards range instead of reporting nothing", () => {
    expect(() =>
      resolveRange(
        { kind: "explicit", from: "2026-08-05", to: "2026-08-01" },
        thursday,
      ),
    ).toThrow(/Empty date range/);
  });

  test("a same-day explicit range covers that one day", () => {
    const range = resolveRange(
      { kind: "explicit", from: "2026-08-04", to: "2026-08-04" },
      thursday,
    );
    expect(range.toMs - range.fromMs).toBe(24 * 60 * 60 * 1000);
  });
});

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "r",
    skill: "code",
    model: "sonnet4.6",
    effort: "medium",
    workspace: "/ws",
    duration_ms: 60_000,
    status: "success",
    error_type: null,
    retry_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 9000,
    cache_write_tokens: 0,
    turns: 10,
    model_id: "us.anthropic.claude-sonnet-4-6",
    cost_usd: 1.0,
    prompt_chars: 100,
    tool_call_count: 4,
    tool_error_count: 0,
    tracked_changed_before: 0,
    tracked_changed_after: 1,
    started_at: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("totalTokens", () => {
  test("sums input, cache read, and cache write", () => {
    expect(totalTokens(row())).toBe(10_000);
  });

  test("is null when no token field was recorded at all", () => {
    expect(
      totalTokens(
        row({
          input_tokens: null,
          cache_read_tokens: null,
          cache_write_tokens: null,
        }),
      ),
    ).toBeNull();
  });

  test("treats a partially-recorded run's missing fields as zero", () => {
    expect(
      totalTokens(row({ cache_read_tokens: null, cache_write_tokens: null })),
    ).toBe(1000);
  });
});

describe("summarizeSkill", () => {
  test("counts every run but prices only the priced ones", () => {
    const summary = summarizeSkill("code", [
      row({ cost_usd: 1.0 }),
      row({ cost_usd: 3.0 }),
      row({ cost_usd: null }),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.costUsd).toBeCloseTo(4.0, 6);
    expect(summary.unpricedRuns).toBe(1);
    // Averaging over 3 would understate the real per-run cost.
    expect(summary.costPerRun).toBeCloseTo(2.0, 6);
  });

  test("reports null cost when nothing in the set was priced", () => {
    const summary = summarizeSkill("pr-review", [row({ cost_usd: null })]);
    expect(summary.costUsd).toBeNull();
    expect(summary.costPerRun).toBeNull();
  });

  test("computes the cache hit ratio over billed input tokens", () => {
    const summary = summarizeSkill("code", [
      row({
        input_tokens: 1000,
        cache_read_tokens: 9000,
        cache_write_tokens: 0,
      }),
    ]);
    expect(summary.cacheHitRatio).toBeCloseTo(0.9, 6);
  });

  test("leaves the cache ratio null when no input tokens were recorded", () => {
    const summary = summarizeSkill("code", [
      row({
        input_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
      }),
    ]);
    expect(summary.cacheHitRatio).toBeNull();
  });

  test("flags runs that hit the turn cap", () => {
    const summary = summarizeSkill("code", [
      row({ turns: 80 }),
      row({ turns: 10 }),
    ]);
    expect(summary.maxTurnsExhausted).toBe(1);
  });

  test("counts error runs", () => {
    const summary = summarizeSkill("code", [
      row({ status: "error" }),
      row({ status: "success" }),
      row({ status: "success" }),
    ]);
    expect(summary.errors).toBe(1);
  });

  test("excludes unmeasured durations from percentiles rather than zeroing them", () => {
    const summary = summarizeSkill("code", [
      row({ duration_ms: 100_000 }),
      row({ duration_ms: null }),
    ]);
    expect(summary.p50DurationMs).toBe(100_000);
    expect(summary.durations).toEqual([100_000]);
  });
});

describe("report over a real DB", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let logPath: string;

  function event(overrides: Record<string, any> = {}): Record<string, any> {
    return {
      timestamp: "2026-08-04T10:00:00.000Z",
      run_id: "run-1",
      invocation_id: "inv-1",
      event: "skill",
      subject: "code",
      duration_ms: 60_000,
      skill: "code",
      model: "sonnet4.6",
      effort: "medium",
      workspace: "/ws/proj",
      git_branch: "main",
      git_sha: "abc",
      meta: { status: "success", retry_count: 0 },
      ...overrides,
    };
  }

  function promptFor(
    runId: string,
    inputTokens: number,
    ts: string,
    skill = "code",
  ) {
    return event({
      run_id: runId,
      timestamp: ts,
      event: "prompt",
      skill,
      meta: {
        prompt_chars: 4000,
        response_chars: 900,
        usage: {
          source: "bedrock",
          modelId: "us.anthropic.claude-sonnet-4-6",
          inputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turns: 10,
        },
      },
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-stats-"));
    logPath = path.join(tmpDir, "events.jsonl");
    db = openMetricsDb(path.join(tmpDir, "metrics.db"));

    fs.writeFileSync(
      logPath,
      [
        // In range: 2026-08-04.
        promptFor("run-1", 1_000_000, "2026-08-04T10:00:00.000Z"),
        event({ run_id: "run-1", timestamp: "2026-08-04T10:01:00.000Z" }),
        event({
          run_id: "run-1",
          timestamp: "2026-08-04T10:00:30.000Z",
          event: "tool_call",
          subject: "bash",
          duration_ms: 200,
          meta: { output_bytes: 1024, error: false },
        }),
        // In range, different skill.
        promptFor("run-2", 2_000_000, "2026-08-05T09:00:00.000Z", "review"),
        event({
          run_id: "run-2",
          timestamp: "2026-08-05T09:02:00.000Z",
          skill: "review",
          subject: "review",
          duration_ms: 120_000,
          meta: { status: "error", error_type: "exception", retry_count: 1 },
        }),
        // Out of range: June.
        promptFor("run-3", 1_000_000, "2026-06-20T09:00:00.000Z"),
        event({ run_id: "run-3", timestamp: "2026-06-20T09:01:00.000Z" }),
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
      "utf-8",
    );
    ingestFile(db, logPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const august = resolveRange(
    { kind: "explicit", from: "2026-08-01", to: "2026-08-31" },
    new Date(2026, 7, 31),
  );

  test("queryRuns honors the half-open range", () => {
    expect(queryRuns(db, august).map((r) => r.run_id)).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  test("a run exactly at the exclusive end belongs to the next period", () => {
    const upToTheFourth = resolveRange(
      { kind: "explicit", from: "2026-08-01", to: "2026-08-04" },
      new Date(2026, 7, 31),
    );
    expect(queryRuns(db, upToTheFourth).map((r) => r.run_id)).toEqual([
      "run-1",
    ]);
  });

  test("queryRuns filters by skill", () => {
    expect(queryRuns(db, august, "review").map((r) => r.run_id)).toEqual([
      "run-2",
    ]);
  });

  test("buildReport groups by skill and totals the cost", () => {
    const report = buildReport(db, august);
    expect(report.totalRuns).toBe(2);
    // 1M + 2M input tokens at $3/1M.
    expect(report.totalCostUsd).toBeCloseTo(9.0, 5);
    expect(report.skills.map((s) => s.skill)).toEqual(["review", "code"]);
    expect(report.unpricedRuns).toBe(0);
  });

  test("buildReport surfaces tool, effort, workspace, and daily breakdowns", () => {
    const report = buildReport(db, august);
    expect(report.tools).toEqual([
      expect.objectContaining({ tool: "bash", calls: 1, errors: 0 }),
    ]);
    expect(report.efforts).toEqual([
      expect.objectContaining({ effort: "medium", runs: 2 }),
    ]);
    expect(report.workspaces[0].workspace).toBe("/ws/proj");
    expect(report.daily.map((d) => d.runs)).toEqual([1, 1]);

    // Grouped costs must survive the SQL round-trip; a mismatched column alias
    // reads back as undefined and renders as "no data", not as an error.
    expect(report.workspaces[0].costUsd).toBeCloseTo(9.0, 5);
    expect(report.efforts[0].costUsd).toBeCloseTo(9.0, 5);
    expect(report.efforts[0].costPerRun).toBeCloseTo(4.5, 5);
    expect(report.daily.map((d) => d.costUsd)).toEqual([3.0, 6.0]);
  });

  test("a skill filter narrows every section of the report", () => {
    const report = buildReport(db, august, "review");
    expect(report.totalRuns).toBe(1);
    expect(report.skills.map((s) => s.skill)).toEqual(["review"]);
    // run-1's bash call belongs to `code` and must not leak in.
    expect(report.tools).toEqual([]);
  });

  test("renderReport shows the skills, a total row, and the error rate", () => {
    const text = renderReport(buildReport(db, august));
    expect(text).toContain("code");
    expect(text).toContain("review");
    expect(text).toContain("TOTAL");
    expect(text).toContain("$9.00");
    // One of two runs failed.
    expect(text).toMatch(/TOTAL.*50%/);
  });

  test("renderReport says so plainly when a period has no runs", () => {
    const empty = resolveRange(
      { kind: "explicit", from: "2026-07-01", to: "2026-07-02" },
      new Date(2026, 7, 31),
    );
    expect(renderReport(buildReport(db, empty))).toContain("No runs");
  });

  test("renderReport calls out unpriced runs instead of implying they were free", () => {
    fs.appendFileSync(
      logPath,
      `${JSON.stringify(
        event({ run_id: "run-4", timestamp: "2026-08-06T10:00:00.000Z" }),
      )}\n`,
      "utf-8",
    );
    ingestFile(db, logPath);

    const report = buildReport(db, august);
    expect(report.unpricedRuns).toBe(1);
    expect(renderReport(report)).toContain("1 of 3 runs are unpriced");
  });

  test("renderReport warns about runs that hit the turn cap", () => {
    fs.appendFileSync(
      logPath,
      `${JSON.stringify(
        event({
          run_id: "run-5",
          timestamp: "2026-08-06T11:00:00.000Z",
          meta: {
            status: "error",
            error_type: "exception",
            usage: {
              source: "bedrock",
              modelId: "us.anthropic.claude-sonnet-4-6",
              inputTokens: 1000,
              turns: 80,
            },
          },
        }),
      )}\n`,
      "utf-8",
    );
    ingestFile(db, logPath);

    expect(renderReport(buildReport(db, august))).toContain("80-turn cap");
  });
});
