import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";

import {
  bucketOf,
  summarizeDegradation,
  queryDegradation,
  renderDegradation,
  POSITION_BUCKETS,
  MIN_CALLS_FOR_POSITION,
  type PositionedCall,
} from "./degradation";
import { openMetricsDb, ingestFile } from "./metrics-db";
import { resolveRange } from "./stats";

/** `n` calls of one run, described by a per-index callback. */
function run(
  runId: string,
  n: number,
  at: (index: number) => Partial<PositionedCall>,
): PositionedCall[] {
  return Array.from({ length: n }, (_, i) => ({
    run_id: runId,
    tool: "bash",
    error: 0,
    target_path: null,
    ...at(i),
  }));
}

describe("bucketOf", () => {
  test("splits a run evenly into fifths", () => {
    const buckets = Array.from({ length: 10 }, (_, i) => bucketOf(i, 10));
    expect(buckets).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test("puts the remainder in the last bucket rather than a sixth one", () => {
    const buckets = Array.from({ length: 7 }, (_, i) => bucketOf(i, 7));
    expect(Math.max(...buckets)).toBe(POSITION_BUCKETS - 1);
    expect(buckets.at(-1)).toBe(POSITION_BUCKETS - 1);
  });

  test("places the final call of a run in the final bucket", () => {
    expect(bucketOf(19, 20)).toBe(4);
    expect(bucketOf(0, 20)).toBe(0);
  });
});

describe("summarizeDegradation", () => {
  test("ignores runs too short to have an interior", () => {
    const report = summarizeDegradation(
      run("a", MIN_CALLS_FOR_POSITION - 1, () => ({})),
    );

    expect(report.runs).toBe(0);
    expect(report.shortRuns).toBe(1);
    expect(report.positions).toEqual([]);
  });

  test("finds the error rate rising across a run", () => {
    // 20 calls is four per bucket, so the failures start exactly at bucket 2.
    const report = summarizeDegradation(
      run("a", 20, (i) => ({ error: i >= 8 ? 1 : 0 })),
    );

    expect(report.runs).toBe(1);
    expect(report.positions.map((p) => p.errorRate)).toEqual([0, 0, 1, 1, 1]);
  });

  test("counts a read of a file the same run had already read", () => {
    const report = summarizeDegradation(
      run("a", 20, () => ({ tool: "read", target_path: "src/a.ts" })),
    );

    // Four reads in the bucket, three of them of a file already read.
    expect(report.positions[0].reads).toBe(4);
    expect(report.positions[0].revisits).toBe(3);
    expect(report.positions[4].revisitShare).toBe(1);
  });

  test("does not carry a read across runs", () => {
    // The cross-run question belongs to src/context-cost.ts; counting it here
    // would report the same re-read in two places.
    const report = summarizeDegradation([
      ...run("a", 20, () => ({ tool: "read", target_path: "src/a.ts" })),
      ...run("b", 20, (i) =>
        i === 0
          ? { tool: "read", target_path: "src/a.ts" }
          : { tool: "bash", error: 0 },
      ),
    ]);

    // Run b's single read is a first read for run b.
    const firstBucket = report.positions[0];
    expect(firstBucket.reads).toBe(5);
    expect(firstBucket.revisits).toBe(3);
  });

  test("only counts reads that recovered a path", () => {
    const report = summarizeDegradation(
      run("a", 20, () => ({ tool: "read", target_path: null })),
    );

    expect(report.positions.every((p) => p.reads === 0)).toBe(true);
    expect(report.positions.every((p) => p.revisitShare === null)).toBe(true);
  });

  test("holds tool mix constant so a busier tool cannot fake a decline", () => {
    // The confound this exists to remove, built exactly: neither tool changes —
    // read never fails, bash fails half the time in every bucket — and only the
    // mix moves, bash rising from 2 of 10 calls to 8 of 10. The raw rate
    // therefore climbs from 10% to 40% while nothing got worse at anything.
    const bashPerBucket = [2, 4, 6, 8, 8];
    const rows: PositionedCall[] = [];
    bashPerBucket.forEach((bashCount, bucket) => {
      for (let i = 0; i < 10; i++) {
        rows.push(
          i < bashCount
            ? { run_id: "a", tool: "bash", error: i % 2, target_path: null }
            : {
                run_id: "a",
                tool: "read",
                error: 0,
                target_path: `src/${bucket}-${i}.ts`,
              },
        );
      }
    });

    // minCellCalls of 1: this test is about the standardization arithmetic, and
    // the thin-cell guard is exercised on its own below.
    const report = summarizeDegradation(rows, MIN_CALLS_FOR_POSITION, 1);
    const raw = report.positions.map((p) => p.errorRate!);
    const adjusted = report.positions.map((p) => p.adjustedErrorRate!);

    expect(raw).toEqual([0.1, 0.2, 0.3, 0.4, 0.4]);
    // 28 bash and 22 read calls overall, bash at 0.5 and read at 0 in every
    // bucket, so the standardized rate is 0.56 * 0.5 — flat, and the same
    // whichever bucket it is computed in.
    for (const rate of adjusted) expect(rate).toBeCloseTo(0.28, 6);
  });

  test("reports a single-tool bucket only when that tool dominates anyway", () => {
    // Bucket 0 is all read, which is a fifth of the period — too little of the
    // mix to stand in for it. The bash buckets are 80% of the period and do.
    const report = summarizeDegradation(
      run("a", 20, (i) =>
        i < 4
          ? { tool: "read", error: 0, target_path: `src/${i}.ts` }
          : { tool: "bash", error: 1 },
      ),
      MIN_CALLS_FOR_POSITION,
      1,
    );

    expect(report.positions.map((p) => p.adjustedErrorRate)).toEqual([
      null,
      1,
      1,
      1,
      1,
    ]);
  });

  test("refuses to let one call in a thin cell carry a whole tool's weight", () => {
    // The flaw this guard exists for, in miniature: `edit` appears twice in the
    // opening bucket and fails once, and without the guard that 50% arrives at
    // edit's full period weight.
    const rows = run("a", 200, (i) =>
      i < 2
        ? { tool: "edit", error: i === 0 ? 1 : 0 }
        : { tool: "bash", error: 0 },
    );

    const guarded = summarizeDegradation(rows);
    const unguarded = summarizeDegradation(rows, MIN_CALLS_FOR_POSITION, 1);

    // bash alone is clean, so the guarded rate is 0; the thin edit cell is what
    // lifts the unguarded one.
    expect(guarded.positions[0].adjustedErrorRate).toBe(0);
    expect(unguarded.positions[0].adjustedErrorRate!).toBeGreaterThan(0);
  });

  test("reports nothing rather than a rate built from too little of the mix", () => {
    // One tool covers 2% of the period; a bucket where only it survives the cell
    // guard is not a measurement of the mix.
    const rows = [
      ...run("a", 100, () => ({ tool: "bash", error: 0 })),
      ...run("b", 30, (i) => ({
        tool: i < 25 ? "rare" : "bash",
        error: 1,
      })),
    ];
    const report = summarizeDegradation(rows);

    // Run b's opening bucket is all `rare`, which carries far too little weight.
    expect(report.positions[0].adjustedErrorRate).not.toBeNull();
    const thin = summarizeDegradation(
      run("b", 30, () => ({ tool: "rare", error: 1 })),
      MIN_CALLS_FOR_POSITION,
      // Every cell is 6 calls, so nothing survives a guard of 20.
      20,
    );
    expect(thin.positions.every((p) => p.adjustedErrorRate === null)).toBe(
      true,
    );
    // The raw rate is still reported: it needs no mix to be meaningful.
    expect(thin.positions[0].errorRate).toBe(1);
  });

  test("reports how many runs it measured and how many it set aside", () => {
    const report = summarizeDegradation([
      ...run("long", 25, () => ({})),
      ...run("short", 5, () => ({})),
    ]);

    expect(report.runs).toBe(1);
    expect(report.shortRuns).toBe(1);
    expect(report.calls).toBe(25);
  });
});

describe("renderDegradation", () => {
  const report = summarizeDegradation(
    run("a", 20, (i) => ({
      tool: "read",
      error: i >= 15 ? 1 : 0,
      target_path: i === 0 ? "src/a.ts" : "src/b.ts",
    })),
  );

  test("names both series and says what they mean together", () => {
    const text = renderDegradation(report);
    expect(text).toContain("Reads already in context");
    expect(text).toContain("Tool errors");
    expect(text).toContain("context rot");
  });

  test("explains the mix adjustment, which is otherwise unreadable", () => {
    expect(renderDegradation(report)).toContain("mix constant");
  });

  test("says nothing when no run was long enough to position", () => {
    expect(renderDegradation(summarizeDegradation([]))).toBe("");
    expect(
      renderDegradation(summarizeDegradation(run("a", 3, () => ({})))),
    ).toBe("");
  });

  test("says how many runs it left out", () => {
    const mixed = summarizeDegradation([
      ...run("long", 25, () => ({})),
      ...run("short", 4, () => ({})),
    ]);
    expect(renderDegradation(mixed)).toContain("1 shorter run(s) are excluded");
  });
});

describe("queryDegradation", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-degradation-"));
    logPath = path.join(tmpDir, "events.jsonl");
    db = openMetricsDb(path.join(tmpDir, "metrics.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads position off the log in the order the calls happened", () => {
    const base = {
      timestamp: "2026-08-20T10:00:00.000Z",
      run_id: "run-1",
      invocation_id: "inv-1",
      skill: "code",
      model: "sonnet4.6",
      effort: "medium",
      workspace: "/ws/proj",
    };
    // 20 reads: the first four distinct, the rest all of the first file, so
    // revisits are absent from the opening bucket and total in the closing one.
    const events = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      event: "tool_call",
      subject: "read",
      duration_ms: 5,
      meta: {
        input_summary: JSON.stringify({
          path: i < 4 ? `src/${i}.ts` : "src/0.ts",
        }),
        output_bytes: 100,
        error: false,
      },
    }));
    fs.writeFileSync(
      logPath,
      [
        ...events,
        {
          ...base,
          event: "skill",
          subject: "code",
          duration_ms: 2000,
          meta: { status: "success", error_type: null, retry_count: 0 },
        },
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
      "utf-8",
    );
    ingestFile(db, logPath);

    const report = queryDegradation(db, resolveRange({ kind: "all" }));

    expect(report.runs).toBe(1);
    expect(report.calls).toBe(20);
    expect(report.positions[0].revisitShare).toBe(0);
    expect(report.positions[4].revisitShare).toBe(1);
  });
});
