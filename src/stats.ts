import type { DatabaseSync } from "node:sqlite";

import {
  percentile,
  mean,
  formatUsd,
  formatDuration,
  formatTokens,
  formatCount,
  formatPercent,
  renderTable,
  renderHistogramSection,
  NO_DATA,
  type Column,
} from "./stats-format";
import {
  queryContextCost,
  renderContextCost,
  type ContextCostReport,
} from "./context-cost";
import {
  queryDegradation,
  renderDegradation,
  type DegradationReport,
} from "./degradation";

export type TimeRange = {
  /** Inclusive start. */
  fromMs: number;
  /** Exclusive end — a run at exactly `toMs` belongs to the next period. */
  toMs: number;
  label: string;
};

export type RangeSelector =
  | { kind: "this-week" }
  | { kind: "this-month" }
  | { kind: "this-year" }
  | { kind: "all" }
  | { kind: "explicit"; from?: string; to?: string };

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Parses a YYYY-MM-DD date as local midnight. Local, not UTC, so "this week"
 * matches the days the user actually worked.
 */
function parseLocalDate(text: string, flag: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new Error(
      `Invalid date for ${flag}: ${JSON.stringify(text)}\n` +
        `Expected YYYY-MM-DD, e.g. ${flag} 2026-08-01`,
    );
  }
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

/**
 * Resolves a selector into a half-open [from, to) millisecond range. `now` is a
 * parameter so tests are not tied to the clock.
 */
export function resolveRange(
  selector: RangeSelector,
  now: Date = new Date(),
): TimeRange {
  const today = startOfDay(now);
  // Exclusive end: tomorrow's midnight, so today's runs are included.
  const tomorrow = new Date(today.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);

  switch (selector.kind) {
    case "this-week": {
      // Weeks start Monday.
      const dayOfWeek = (today.getDay() + 6) % 7;
      const monday = new Date(today.getTime());
      monday.setDate(monday.getDate() - dayOfWeek);
      return {
        fromMs: monday.getTime(),
        toMs: tomorrow.getTime(),
        label: `this week (${isoDate(monday.getTime())} → ${isoDate(today.getTime())})`,
      };
    }
    case "this-month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        fromMs: first.getTime(),
        toMs: tomorrow.getTime(),
        label: `this month (${isoDate(first.getTime())} → ${isoDate(today.getTime())})`,
      };
    }
    case "this-year": {
      const first = new Date(now.getFullYear(), 0, 1);
      return {
        fromMs: first.getTime(),
        toMs: tomorrow.getTime(),
        label: `this year (${isoDate(first.getTime())} → ${isoDate(today.getTime())})`,
      };
    }
    case "all":
      return {
        fromMs: 0,
        toMs: Number.MAX_SAFE_INTEGER,
        label: "all time",
      };
    case "explicit": {
      const from = selector.from
        ? parseLocalDate(selector.from, "--from")
        : new Date(0);
      // --to is inclusive of the named day, so advance to the next midnight.
      const to = selector.to
        ? (() => {
            const d = parseLocalDate(selector.to!, "--to");
            d.setDate(d.getDate() + 1);
            return d;
          })()
        : tomorrow;
      if (to.getTime() <= from.getTime()) {
        throw new Error(
          `Empty date range: --from ${selector.from} is not before --to ${selector.to}.`,
        );
      }
      return {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        label: `${selector.from ?? "start"} → ${selector.to ?? isoDate(today.getTime())}`,
      };
    }
  }
}

export type RunRow = {
  run_id: string;
  skill: string | null;
  model: string | null;
  effort: string | null;
  workspace: string | null;
  duration_ms: number | null;
  status: string | null;
  error_type: string | null;
  retry_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  turns: number | null;
  /** The full model id cost was computed from; `model` is the short alias. */
  model_id: string | null;
  cost_usd: number | null;
  prompt_chars: number | null;
  tool_call_count: number;
  tool_error_count: number;
  tracked_changed_before: number | null;
  tracked_changed_after: number | null;
  started_at: string | null;
};

export function queryRuns(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): RunRow[] {
  const sql = `
    SELECT * FROM runs
    WHERE started_at_ms >= ? AND started_at_ms < ?
      ${skill ? "AND skill = ?" : ""}
    ORDER BY started_at_ms
  `;
  const params: Array<string | number> = [range.fromMs, range.toMs];
  if (skill) params.push(skill);
  return db.prepare(sql).all(...params) as unknown as RunRow[];
}

/**
 * Total tokens billed for a run. Sums input + cache read + cache write because
 * bare `inputTokens` means different things before and after prompt caching
 * shipped; the sum is the only cross-era-comparable figure.
 */
export function totalTokens(run: RunRow): number | null {
  const parts = [
    run.input_tokens,
    run.cache_read_tokens,
    run.cache_write_tokens,
  ];
  if (parts.every((p) => p == null)) return null;
  return parts.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
}

function nonNull(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v != null);
}

export type SkillSummary = {
  skill: string;
  runs: number;
  errors: number;
  unpricedRuns: number;
  costUsd: number | null;
  costPerRun: number | null;
  p50DurationMs: number | null;
  meanDurationMs: number | null;
  p50Turns: number | null;
  meanTurns: number | null;
  p50Tokens: number | null;
  meanTokens: number | null;
  p50ToolCalls: number | null;
  cacheHitRatio: number | null;
  maxTurnsExhausted: number;
  costs: number[];
  durations: number[];
  turns: number[];
  tokens: number[];
};

/** Turn cap in BedrockRunner; runs at the cap were cut off, not completed. */
const MAX_TURNS = 80;

export function summarizeSkill(skill: string, runs: RunRow[]): SkillSummary {
  const costs = nonNull(runs.map((r) => r.cost_usd));
  const durations = nonNull(runs.map((r) => r.duration_ms));
  const turns = nonNull(runs.map((r) => r.turns));
  const tokens = nonNull(runs.map((r) => totalTokens(r)));
  const toolCalls = runs.map((r) => r.tool_call_count ?? 0);

  const cacheRead = runs.reduce((a, r) => a + (r.cache_read_tokens ?? 0), 0);
  const billedInput = runs.reduce(
    (a, r) =>
      a +
      (r.input_tokens ?? 0) +
      (r.cache_read_tokens ?? 0) +
      (r.cache_write_tokens ?? 0),
    0,
  );

  const costUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  return {
    skill,
    runs: runs.length,
    errors: runs.filter((r) => r.status === "error").length,
    unpricedRuns: runs.filter((r) => r.cost_usd == null).length,
    costUsd,
    // Divide by runs that were actually priced; including unpriced runs would
    // understate the true per-run cost.
    costPerRun: costs.length > 0 ? costUsd! / costs.length : null,
    p50DurationMs: percentile(durations, 50),
    meanDurationMs: mean(durations),
    p50Turns: percentile(turns, 50),
    meanTurns: mean(turns),
    p50Tokens: percentile(tokens, 50),
    meanTokens: mean(tokens),
    p50ToolCalls: percentile(toolCalls, 50),
    cacheHitRatio: billedInput > 0 ? cacheRead / billedInput : null,
    maxTurnsExhausted: runs.filter((r) => (r.turns ?? 0) >= MAX_TURNS).length,
    costs,
    durations,
    turns,
    tokens,
  };
}

export type ToolSummary = {
  tool: string;
  calls: number;
  errors: number;
  p50DurationMs: number | null;
  totalOutputBytes: number | null;
};

export function queryToolSummary(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): ToolSummary[] {
  const rows = db
    .prepare(
      `SELECT t.tool AS tool,
              COUNT(*) AS calls,
              SUM(t.error) AS errors,
              SUM(COALESCE(t.output_bytes, 0)) AS output_bytes
       FROM tool_calls t
       JOIN runs r ON r.run_id = t.run_id
       WHERE r.started_at_ms >= ? AND r.started_at_ms < ?
         ${skill ? "AND r.skill = ?" : ""}
       GROUP BY t.tool
       ORDER BY calls DESC`,
    )
    .all(
      ...([range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[]),
    ) as any[];

  return rows.map((row) => {
    const durations = db
      .prepare(
        `SELECT t.duration_ms AS d FROM tool_calls t
         JOIN runs r ON r.run_id = t.run_id
         WHERE t.tool = ? AND t.duration_ms IS NOT NULL
           AND r.started_at_ms >= ? AND r.started_at_ms < ?
           ${skill ? "AND r.skill = ?" : ""}`,
      )
      .all(
        ...([
          row.tool,
          range.fromMs,
          range.toMs,
          ...(skill ? [skill] : []),
        ] as any[]),
      ) as any[];

    return {
      tool: row.tool ?? "unknown",
      calls: row.calls,
      errors: row.errors ?? 0,
      p50DurationMs: percentile(
        durations.map((d) => d.d as number),
        50,
      ),
      totalOutputBytes: row.output_bytes ?? null,
    };
  });
}

export type WorkspaceSummary = {
  workspace: string;
  runs: number;
  costUsd: number | null;
};

export function queryWorkspaceSummary(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): WorkspaceSummary[] {
  // Aliases are camelCase to match the TS field names; sqlite returns rows
  // keyed by the alias, so a snake_case alias would read back as undefined.
  return db
    .prepare(
      `SELECT COALESCE(workspace, '(unattributed)') AS workspace,
              COUNT(*) AS runs,
              SUM(cost_usd) AS costUsd
       FROM runs
       WHERE started_at_ms >= ? AND started_at_ms < ?
         ${skill ? "AND skill = ?" : ""}
       GROUP BY workspace
       ORDER BY costUsd DESC NULLS LAST, runs DESC`,
    )
    .all(
      ...([range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[]),
    ) as unknown as WorkspaceSummary[];
}

export type EffortSummary = {
  effort: string;
  runs: number;
  costUsd: number | null;
  costPerRun: number | null;
};

export function queryEffortSummary(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): EffortSummary[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(effort, '(unrecorded)') AS effort,
              COUNT(*) AS runs,
              SUM(cost_usd) AS cost_usd,
              COUNT(cost_usd) AS priced
       FROM runs
       WHERE started_at_ms >= ? AND started_at_ms < ?
         ${skill ? "AND skill = ?" : ""}
       GROUP BY effort
       ORDER BY runs DESC`,
    )
    .all(
      ...([range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[]),
    ) as any[];

  return rows.map((r) => ({
    effort: r.effort,
    runs: r.runs,
    costUsd: r.cost_usd ?? null,
    costPerRun: r.priced > 0 ? r.cost_usd / r.priced : null,
  }));
}

export type DailySummary = {
  date: string;
  runs: number;
  costUsd: number | null;
};

export function queryDailySummary(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): DailySummary[] {
  return db
    .prepare(
      `SELECT DATE(started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
              COUNT(*) AS runs,
              SUM(cost_usd) AS costUsd
       FROM runs
       WHERE started_at_ms >= ? AND started_at_ms < ?
         ${skill ? "AND skill = ?" : ""}
       GROUP BY date
       ORDER BY date`,
    )
    .all(
      ...([range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[]),
    ) as unknown as DailySummary[];
}

export type StatsReport = {
  range: { from: string; to: string; label: string };
  totalRuns: number;
  totalCostUsd: number | null;
  unpricedRuns: number;
  skills: SkillSummary[];
  tools: ToolSummary[];
  workspaces: WorkspaceSummary[];
  efforts: EffortSummary[];
  daily: DailySummary[];
  /** What one prompt per run costs and avoids; see src/context-cost.ts. */
  contextCost: ContextCostReport;
  /** Whether a run decays as its context grows; see src/degradation.ts. */
  degradation: DegradationReport;
};

export function buildReport(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): StatsReport {
  const runs = queryRuns(db, range, skill);

  const bySkill = new Map<string, RunRow[]>();
  for (const run of runs) {
    const key = run.skill ?? "(unknown)";
    const list = bySkill.get(key);
    if (list) list.push(run);
    else bySkill.set(key, [run]);
  }

  const skills = [...bySkill.entries()]
    .map(([name, rows]) => summarizeSkill(name, rows))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

  const priced = runs.filter((r) => r.cost_usd != null);

  return {
    range: {
      from: isoDate(range.fromMs),
      to: isoDate(Math.min(range.toMs, Date.now())),
      label: range.label,
    },
    totalRuns: runs.length,
    totalCostUsd:
      priced.length > 0
        ? priced.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
        : null,
    unpricedRuns: runs.length - priced.length,
    skills,
    tools: queryToolSummary(db, range, skill),
    workspaces: queryWorkspaceSummary(db, range, skill),
    efforts: queryEffortSummary(db, range, skill),
    daily: queryDailySummary(db, range, skill),
    contextCost: queryContextCost(db, range, skill),
    degradation: queryDegradation(db, range, skill),
  };
}

const SKILL_COLUMNS: Column[] = [
  { header: "SKILL", align: "left" },
  { header: "RUNS" },
  { header: "COST" },
  { header: "$/RUN" },
  { header: "p50 DUR" },
  { header: "p50 TURNS" },
  { header: "p50 TOKENS" },
  { header: "p50 TOOLS" },
  { header: "CACHE" },
  { header: "ERR" },
];

function skillRow(s: SkillSummary): string[] {
  return [
    s.skill,
    String(s.runs),
    formatUsd(s.costUsd),
    formatUsd(s.costPerRun),
    formatDuration(s.p50DurationMs),
    formatCount(s.p50Turns),
    formatTokens(s.p50Tokens),
    formatCount(s.p50ToolCalls),
    formatPercent(s.cacheHitRatio),
    s.runs > 0 ? formatPercent(s.errors / s.runs) : NO_DATA,
  ];
}

/** Renders the whole report as terminal text. */
export function renderReport(report: StatsReport): string {
  const out: string[] = [];

  out.push(`carl stats — ${report.range.label}`);
  out.push("");

  if (report.totalRuns === 0) {
    out.push("No runs in this period.");
    return out.join("\n");
  }

  const rows = report.skills.map(skillRow);

  const totalPriced = report.skills.reduce((a, s) => a + s.costs.length, 0);
  rows.push([
    "TOTAL",
    String(report.totalRuns),
    formatUsd(report.totalCostUsd),
    totalPriced > 0 ? formatUsd(report.totalCostUsd! / totalPriced) : NO_DATA,
    formatDuration(
      percentile(
        report.skills.flatMap((s) => s.durations),
        50,
      ),
    ),
    formatCount(
      percentile(
        report.skills.flatMap((s) => s.turns),
        50,
      ),
    ),
    formatTokens(
      percentile(
        report.skills.flatMap((s) => s.tokens),
        50,
      ),
    ),
    "",
    "",
    formatPercent(
      report.skills.reduce((a, s) => a + s.errors, 0) / report.totalRuns,
    ),
  ]);

  out.push(renderTable(SKILL_COLUMNS, rows));
  out.push("");

  if (report.unpricedRuns > 0) {
    out.push(
      `Note: ${report.unpricedRuns} of ${report.totalRuns} runs are unpriced ` +
        `(no token data recorded, or a model with no known rates). Cost figures ` +
        `cover the remaining ${report.totalRuns - report.unpricedRuns}.`,
    );
    out.push("");
  }

  const exhausted = report.skills.reduce((a, s) => a + s.maxTurnsExhausted, 0);
  if (exhausted > 0) {
    out.push(
      `Warning: ${exhausted} run(s) hit the ${MAX_TURNS}-turn cap — that work was ` +
        `paid for and discarded.`,
    );
    out.push("");
  }

  // Per-skill distributions: averages hide the tail that drives cost.
  for (const s of report.skills) {
    if (s.runs < 2) continue;
    out.push(`── ${s.skill} (${s.runs} runs) ──`);
    if (s.costs.length > 0) {
      out.push(
        renderHistogramSection("Cost per run", s.costs, (v) => formatUsd(v)),
      );
      out.push("");
    }
    if (s.durations.length > 0) {
      out.push(
        renderHistogramSection("Duration per run", s.durations, (v) =>
          formatDuration(v),
        ),
      );
      out.push("");
    }
    if (s.turns.length > 0) {
      out.push(
        renderHistogramSection("Turns per run", s.turns, (v) =>
          String(Math.round(v)),
        ),
      );
      out.push("");
    }
    if (s.tokens.length > 0) {
      out.push(
        renderHistogramSection("Total tokens per run", s.tokens, (v) =>
          formatTokens(v),
        ),
      );
      out.push("");
    }
    out.push(
      `mean: ${formatUsd(mean(s.costs))} · ${formatDuration(s.meanDurationMs)} · ` +
        `${formatCount(s.meanTurns)} turns · ${formatTokens(s.meanTokens)} tokens`,
    );
    out.push("");
  }

  if (report.tools.length > 0) {
    out.push("── Tools ──");
    out.push(
      renderTable(
        [
          { header: "TOOL", align: "left" },
          { header: "CALLS" },
          { header: "ERRORS" },
          { header: "ERR RATE" },
          { header: "p50 DUR" },
          { header: "OUTPUT" },
        ],
        report.tools.map((t) => [
          t.tool,
          String(t.calls),
          String(t.errors),
          formatPercent(t.calls > 0 ? t.errors / t.calls : null, 1),
          formatDuration(t.p50DurationMs),
          t.totalOutputBytes != null
            ? `${(t.totalOutputBytes / 1_048_576).toFixed(1)} MiB`
            : NO_DATA,
        ]),
      ),
    );
    out.push("");
  }

  const contextCost = renderContextCost(report.contextCost);
  if (contextCost) {
    out.push(contextCost);
    out.push("");
  }

  // Directly after the cost of starting over: this is what starting over buys,
  // and the two sections only mean anything together.
  const degradation = renderDegradation(report.degradation);
  if (degradation) {
    out.push(degradation);
    out.push("");
  }

  if (report.efforts.length > 1) {
    out.push("── Effort ──");
    out.push(
      renderTable(
        [
          { header: "EFFORT", align: "left" },
          { header: "RUNS" },
          { header: "COST" },
          { header: "$/RUN" },
        ],
        report.efforts.map((e) => [
          e.effort,
          String(e.runs),
          formatUsd(e.costUsd),
          formatUsd(e.costPerRun),
        ]),
      ),
    );
    out.push("");
  }

  if (report.workspaces.length > 1) {
    out.push("── Workspaces ──");
    out.push(
      renderTable(
        [
          { header: "WORKSPACE", align: "left" },
          { header: "RUNS" },
          { header: "COST" },
        ],
        report.workspaces
          .slice(0, 15)
          .map((w) => [w.workspace, String(w.runs), formatUsd(w.costUsd)]),
      ),
    );
    if (report.workspaces.length > 15) {
      out.push(`  … and ${report.workspaces.length - 15} more`);
    }
    out.push("");
  }

  if (report.daily.length > 1) {
    out.push("── Daily ──");
    out.push(
      renderTable(
        [
          { header: "DATE", align: "left" },
          { header: "RUNS" },
          { header: "COST" },
        ],
        report.daily.map((d) => [d.date, String(d.runs), formatUsd(d.costUsd)]),
      ),
    );
    out.push("");
  }

  return out.join("\n");
}
