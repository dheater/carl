/**
 * Whether a run gets worse as it goes.
 *
 * The one-shot question — see src/context-cost.ts — is about what carl pays to
 * start over. This is about what it buys, and it is the harder half, because
 * carl's log has only one arm: carl always starts over, so nothing here can
 * compare it against a harness that does not.
 *
 * What the log can answer is the question underneath: does a conversation get
 * worse at using its own context as that context grows? Measured *within* a run,
 * comparing its early tool calls to its late ones. That holds the task fixed —
 * same request, same repository, same model — which no across-run comparison
 * can, and it is why position rather than run length is the axis.
 *
 * Two series, and they answer different objections:
 *
 *   Revisit share. Reads of a file this run had already read. The content is
 *   demonstrably in the model's context and it fetched it again, so this is
 *   context rot measured rather than asserted.
 *
 *   Error rate, raw and mix-adjusted. Tool mix shifts hard across a run — reads
 *   crowded out by bash — and bash fails more than reads do, so the raw series
 *   is confounded by mix. The adjusted series holds mix constant; when both rise
 *   together, the rise is not an artifact of what the run was doing late.
 */

import type { DatabaseSync } from "node:sqlite";

import { formatPercent, renderTable, NO_DATA } from "./stats-format";
import { READ_TOOLS } from "./context-cost";
import type { TimeRange } from "./stats";

/** Fifths rather than deciles: a decile of a 20-call run is two calls. */
export const POSITION_BUCKETS = 5;

/**
 * Runs shorter than this have no interior to speak of — at 20 calls a fifth is
 * four calls, which is already thin, and below it "late in the run" stops
 * meaning anything. Short runs are excluded rather than lumped in, because
 * including them would load every bucket with the same handful of runs.
 */
export const MIN_CALLS_FOR_POSITION = 20;

/**
 * A tool needs this many calls in a bucket before its rate there is allowed to
 * carry that tool's full weight in the adjustment.
 *
 * Standardization weights a tool by its share of the whole period, which is the
 * point — but it means a cell of 13 calls can arrive holding 8% of the weight,
 * where a single failure moves the bucket by most of a point. Observed exactly
 * that with str_replace in the opening bucket. Thin cells are dropped and the
 * weight renormalized over what is left.
 */
export const MIN_CELL_CALLS = 20;

/**
 * Below this share of weight the adjustment is reporting a handful of tools and
 * calling it the mix, so it reports nothing instead.
 */
export const MIN_ADJUSTED_COVERAGE = 0.5;

/** One tool call, as the position query returns it. Must be in run order. */
export type PositionedCall = {
  run_id: string;
  tool: string | null;
  error: number;
  target_path: string | null;
};

export type PositionStats = {
  /** 0 is the first fifth of the run's calls, POSITION_BUCKETS-1 the last. */
  bucket: number;
  calls: number;
  errors: number;
  errorRate: number | null;
  /**
   * Error rate recomputed with tool mix held at the period's overall mix, so a
   * bucket cannot look worse merely for being busier with the riskier tool.
   * Null when no tool in the bucket has a counterpart to weight against.
   */
  adjustedErrorRate: number | null;
  reads: number;
  /** Reads of a file this run had already read before this call. */
  revisits: number;
  revisitShare: number | null;
};

export type DegradationReport = {
  /** Runs long enough to have a measurable interior. */
  runs: number;
  /** Runs in range that were too short to position. */
  shortRuns: number;
  calls: number;
  minCalls: number;
  /** Length POSITION_BUCKETS, or empty when no run qualified. */
  positions: PositionStats[];
};

const READ_TOOL_SET = new Set(READ_TOOLS);

function isRead(call: PositionedCall): boolean {
  return (
    call.tool != null && READ_TOOL_SET.has(call.tool) && !!call.target_path
  );
}

/** Groups consecutive rows by run, preserving the order they arrived in. */
function groupByRun(rows: PositionedCall[]): PositionedCall[][] {
  const byRun = new Map<string, PositionedCall[]>();
  for (const row of rows) {
    const list = byRun.get(row.run_id);
    if (list) list.push(row);
    else byRun.set(row.run_id, [row]);
  }
  return [...byRun.values()];
}

/**
 * Which fifth of a run of `total` calls the call at `index` falls in. The last
 * bucket absorbs the remainder, so a run whose length is not a multiple of five
 * does not produce a sixth bucket holding one call.
 */
export function bucketOf(index: number, total: number): number {
  return Math.min(
    POSITION_BUCKETS - 1,
    Math.floor((POSITION_BUCKETS * index) / total),
  );
}

/**
 * Error rate per bucket with tool mix held constant.
 *
 * Direct standardization: each tool's rate within the bucket, weighted by that
 * tool's share of all calls in the period rather than its share of the bucket.
 * Weights are renormalized over the cells that survive `MIN_CELL_CALLS`, so a
 * tool the bucket barely used is not credited with that tool's full influence,
 * and a bucket missing a tool is not credited with its rate at all.
 */
function standardize(
  perTool: Map<string, number[][]>,
  toolWeight: Map<string, number>,
  bucket: number,
  minCellCalls: number,
): number | null {
  let weighted = 0;
  let weight = 0;
  for (const [tool, buckets] of perTool) {
    const [calls, errors] = buckets[bucket];
    if (calls < minCellCalls) continue;
    const w = toolWeight.get(tool) ?? 0;
    weighted += w * (errors / calls);
    weight += w;
  }
  return weight >= MIN_ADJUSTED_COVERAGE ? weighted / weight : null;
}

export function summarizeDegradation(
  rows: PositionedCall[],
  minCalls: number = MIN_CALLS_FOR_POSITION,
  minCellCalls: number = MIN_CELL_CALLS,
): DegradationReport {
  const grouped = groupByRun(rows);
  const eligible = grouped.filter((run) => run.length >= minCalls);

  const empty = (): number[][] =>
    Array.from({ length: POSITION_BUCKETS }, () => [0, 0]);
  const calls = empty();
  const reads = empty();
  // [tool -> per-bucket [calls, errors]], for the mix adjustment.
  const perTool = new Map<string, number[][]>();
  const toolTotal = new Map<string, number>();

  for (const run of eligible) {
    // Reset per run: a file read once in each of two runs was re-read by
    // neither, and that question belongs to src/context-cost.ts.
    const seen = new Set<string>();
    run.forEach((call, index) => {
      const bucket = bucketOf(index, run.length);
      const failed = call.error ? 1 : 0;

      calls[bucket][0] += 1;
      calls[bucket][1] += failed;

      const tool = call.tool ?? "(unknown)";
      let toolBuckets = perTool.get(tool);
      if (!toolBuckets) perTool.set(tool, (toolBuckets = empty()));
      toolBuckets[bucket][0] += 1;
      toolBuckets[bucket][1] += failed;
      toolTotal.set(tool, (toolTotal.get(tool) ?? 0) + 1);

      if (isRead(call)) {
        const path = call.target_path!;
        reads[bucket][0] += 1;
        if (seen.has(path)) reads[bucket][1] += 1;
        seen.add(path);
      }
    });
  }

  const totalCalls = calls.reduce((sum, [n]) => sum + n, 0);
  const toolWeight = new Map(
    [...toolTotal].map(([tool, n]) => [
      tool,
      totalCalls > 0 ? n / totalCalls : 0,
    ]),
  );

  return {
    runs: eligible.length,
    shortRuns: grouped.length - eligible.length,
    calls: totalCalls,
    minCalls,
    positions:
      totalCalls === 0
        ? []
        : calls.map(([n, errors], bucket) => ({
            bucket,
            calls: n,
            errors,
            errorRate: n > 0 ? errors / n : null,
            adjustedErrorRate: standardize(
              perTool,
              toolWeight,
              bucket,
              minCellCalls,
            ),
            reads: reads[bucket][0],
            revisits: reads[bucket][1],
            revisitShare:
              reads[bucket][0] > 0 ? reads[bucket][1] / reads[bucket][0] : null,
          })),
  };
}

export function queryDegradation(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): DegradationReport {
  // Ordered by ordinal within the run: the summary reads position off row order,
  // so an unordered result would scramble early and late.
  const rows = db
    .prepare(
      `SELECT t.run_id AS run_id, t.tool AS tool, t.error AS error,
              t.target_path AS target_path
       FROM tool_calls t
       JOIN runs r ON r.run_id = t.run_id
       WHERE r.started_at_ms >= ? AND r.started_at_ms < ?
         ${skill ? "AND r.skill = ?" : ""}
       ORDER BY t.run_id, t.ordinal`,
    )
    .all(
      ...([range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[]),
    ) as unknown as PositionedCall[];

  return summarizeDegradation(rows);
}

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];

/**
 * The section as terminal text, or an empty string when no run in range was long
 * enough to have an interior — five buckets over three calls is not a trend.
 */
export function renderDegradation(report: DegradationReport): string {
  if (report.positions.length === 0) return "";

  const label = (bucket: number): string =>
    ORDINALS[bucket] ?? `#${bucket + 1}`;
  const columns = [
    { header: "MEASURE", align: "left" as const },
    ...report.positions.map((p) => ({ header: label(p.bucket) })),
  ];

  const rows: string[][] = [
    [
      "Reads already in context",
      ...report.positions.map((p) => formatPercent(p.revisitShare)),
    ],
    ["Tool errors", ...report.positions.map((p) => formatPercent(p.errorRate))],
    [
      "Tool errors (mix-adj.)",
      ...report.positions.map((p) => formatPercent(p.adjustedErrorRate)),
    ],
    ["Calls", ...report.positions.map((p) => String(p.calls))],
    [
      "Reads",
      ...report.positions.map((p) => (p.reads > 0 ? String(p.reads) : NO_DATA)),
    ],
  ];

  const out = ["── Within a run ──"];
  out.push(renderTable(columns, rows));
  out.push("");
  // Without this, a reader can take the first row for a caching problem and the
  // second for flaky tools, and miss that they are one finding.
  out.push(
    `Position within a run, over the ${report.runs} run(s) with ${report.minCalls}+` +
      ` tool calls. Both series rising is context rot: the run gets worse at using` +
      ` a context it has already been given. Mix-adj. holds tool mix constant,` +
      ` since reads give way to bash late in a run and bash fails more often.`,
  );
  if (report.shortRuns > 0) {
    out.push(
      `${report.shortRuns} shorter run(s) are excluded: too few calls for a` +
        ` position to mean anything.`,
    );
  }
  return out.join("\n");
}
