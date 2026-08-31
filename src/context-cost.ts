/**
 * What carl's one prompt per subprocess costs, and what it avoids.
 *
 * Every other harness keeps one conversation alive across many prompts. carl
 * spawns a fresh runtime per skill run, hands it a persona and an instruction,
 * and throws the conversation away — the human is the thing that carries state
 * from one run to the next. That is a deliberate trade, and it has a price on
 * both sides:
 *
 *   The tax. A repeat run re-establishes a prefix an earlier run already built,
 *   paying cache-write and fresh-input rates for tokens a live session would
 *   have read at cache-read rates. That difference is measurable per run, and
 *   `coldStartUsd` is its sum.
 *
 *   The rebate. A conversation that never grows never pays to carry its own
 *   history. `peakPromptTokens` is what carl's largest single prompt actually
 *   costs; a preserved session would start every run at roughly where the last
 *   one ended, and `compactedRuns` is how often even carl's short runs hit the
 *   point where context has to be shed.
 *
 * The tax is also smaller than it looks, and `firstTurnCachedShare` is why: the
 * provider's own prompt cache outlives carl's subprocess, so a run started
 * minutes after the last one finds its persona prefix still warm and reads it at
 * cache-read rates despite the fresh conversation. Starting over costs the
 * conversation, not necessarily the prefix.
 *
 * Neither side is a simulation of the other harness. These are the measurements
 * that bound the answer; the rendered section says which is which.
 */

import type { DatabaseSync } from "node:sqlite";

import { computeCost } from "./skill";
import {
  percentile,
  formatUsd,
  formatTokens,
  formatCount,
  formatPercent,
  renderTable,
  NO_DATA,
} from "./stats-format";
import type { TimeRange } from "./stats";

/**
 * Two runs closer together than this belong to the same sitting, and the second
 * one re-primes a context the first had already built. Chosen against the
 * measured shape of carl's own history: work arrives in bursts of a few runs
 * minutes apart, separated by hours. Wrong in both directions at the margins —
 * an hour spent reading a plan is one episode split in two — so `episodes` is
 * reported alongside the tax rather than hidden inside it.
 */
export const EPISODE_GAP_MS = 30 * 60_000;

/**
 * The tools whose calls name a file the run had to go and fetch. `read_file` is
 * the name carl's predecessor logged; both eras are in the log.
 */
export const READ_TOOLS = ["read", "read_file"];

export type ContextRun = {
  run_id: string;
  workspace: string | null;
  started_at_ms: number | null;
  model_id: string | null;
  cost_usd: number | null;
  persona_chars: number | null;
  instruction_chars: number | null;
  first_turn_input_tokens: number | null;
  first_turn_cache_read_tokens: number | null;
  first_turn_cache_write_tokens: number | null;
  peak_prompt_tokens: number | null;
  compactions: number | null;
};

export type ContextCostReport = {
  /** Runs in range, whether or not they carry the per-turn fields. */
  totalRuns: number;
  /** Runs whose first turn was recorded: the ones the tax is measured from. */
  measuredRuns: number;
  episodes: number;
  /** Runs that were not the first of their episode. */
  repeatRuns: number;
  /** Repeat runs with both a model and a first turn, so a tax could be priced. */
  pricedRepeatRuns: number;
  coldStartUsd: number | null;
  /** The tax as a share of the range's total priced spend. */
  coldStartShare: number | null;
  p50PersonaChars: number | null;
  p50InstructionChars: number | null;
  /** File reads whose path an earlier run in the same episode had already read. */
  episodeReReads: number;
  /** File reads with a recoverable path, the denominator for the figure above. */
  attributedReads: number;
  /**
   * Share of turn 1's billed tokens that arrived as cache reads rather than
   * being rewritten. Explains the tax rather than adding to it: a near-zero tax
   * means this is near 1, and without it a $0.00 tax reads as a broken metric.
   */
  firstTurnCachedShare: number | null;
  p50PeakPromptTokens: number | null;
  p95PeakPromptTokens: number | null;
  maxPeakPromptTokens: number | null;
  compactedRuns: number;
  /** Null when no run in range recorded the field at all. */
  compactions: number | null;
  /** Runs that did record it, so a 0 can be reported as a measurement. */
  compactionsMeasuredRuns: number;
};

function nonNull(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v != null);
}

/**
 * Splits runs into sittings: same workspace, no idle gap longer than
 * `EPISODE_GAP_MS`. Episodes are per-workspace because a run in another
 * repository continues nothing — there is no context it could have inherited.
 * Runs with no recorded start cannot be placed in time and are dropped.
 */
export function groupEpisodes(runs: ContextRun[]): ContextRun[][] {
  const placeable = runs.filter((r) => r.started_at_ms != null);
  const byWorkspace = new Map<string, ContextRun[]>();
  for (const run of placeable) {
    const key = run.workspace ?? "(unattributed)";
    const list = byWorkspace.get(key);
    if (list) list.push(run);
    else byWorkspace.set(key, [run]);
  }

  const episodes: ContextRun[][] = [];
  for (const list of byWorkspace.values()) {
    const ordered = [...list].sort(
      (a, b) => a.started_at_ms! - b.started_at_ms!,
    );
    let current: ContextRun[] = [];
    for (const run of ordered) {
      const previous = current.at(-1);
      if (
        previous !== undefined &&
        run.started_at_ms! - previous.started_at_ms! > EPISODE_GAP_MS
      ) {
        episodes.push(current);
        current = [];
      }
      current.push(run);
    }
    if (current.length > 0) episodes.push(current);
  }
  return episodes;
}

/**
 * What one run's first turn cost above what the same tokens would have cost if a
 * live session had already held them.
 *
 * Not the whole prompt's cost: a preserved session still pays cache-read on
 * every token it carries, so charging carl for the full first turn would count
 * tokens both harnesses pay for. The tax is only the rate difference — fresh
 * input and cache write versus cache read — which is exactly the part starting
 * over creates. Null when the run has no model to price or no first turn
 * recorded, never 0, so unmeasured runs stay distinguishable from free ones.
 */
export function coldStartTax(run: ContextRun): number | null {
  if (!run.model_id) return null;
  const input = run.first_turn_input_tokens ?? 0;
  const cacheWrite = run.first_turn_cache_write_tokens ?? 0;
  const cacheRead = run.first_turn_cache_read_tokens ?? 0;
  if (input + cacheWrite + cacheRead === 0) return null;

  const asBilled = computeCost({
    source: "cold-start",
    modelId: run.model_id,
    inputTokens: input,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  });
  const asCached = computeCost({
    source: "cold-start",
    modelId: run.model_id,
    cacheReadTokens: input + cacheWrite + cacheRead,
  });
  if (asBilled == null || asCached == null) return null;
  return asBilled - asCached;
}

/**
 * Reads whose file an earlier run of the same episode had already read.
 *
 * Counted per episode rather than per pair of adjacent runs: the file a run
 * re-reads was often read two runs ago, and the human's own re-orientation
 * happened somewhere in between. Both dispatch layers count — a program's
 * `tools.read` costs the same walk through the filesystem as a direct call, and
 * the question here is re-discovery, not context bytes.
 */
export function countEpisodeReReads(
  episodes: ContextRun[][],
  pathsByRun: Map<string, string[]>,
): { reReads: number; attributed: number } {
  let reReads = 0;
  let attributed = 0;
  for (const episode of episodes) {
    const seen = new Set<string>();
    for (const run of episode) {
      const paths = pathsByRun.get(run.run_id) ?? [];
      // Within-run repeats are the read ledger's problem, not this one, so a
      // path counts once per run.
      const distinct = new Set(paths);
      for (const path of distinct) {
        attributed += 1;
        if (seen.has(path)) reReads += 1;
      }
      for (const path of distinct) seen.add(path);
    }
  }
  return { reReads, attributed };
}

export function summarizeContextCost(
  runs: ContextRun[],
  pathsByRun: Map<string, string[]>,
): ContextCostReport {
  const episodes = groupEpisodes(runs);
  const repeats = episodes.flatMap((episode) => episode.slice(1));
  const taxes = nonNull(repeats.map(coldStartTax));
  const coldStartUsd =
    taxes.length > 0 ? taxes.reduce((a, b) => a + b, 0) : null;
  const pricedSpend = nonNull(runs.map((r) => r.cost_usd)).reduce(
    (a, b) => a + b,
    0,
  );
  // Measured over the repeat runs only: the first run of a sitting has nothing
  // to have found warm, so including it would dilute the share toward zero and
  // report a cold cache that never had a chance to be warm.
  const firstTurnCacheRead = repeats.reduce(
    (sum, r) => sum + (r.first_turn_cache_read_tokens ?? 0),
    0,
  );
  const firstTurnBilled = repeats.reduce(
    (sum, r) =>
      sum +
      (r.first_turn_input_tokens ?? 0) +
      (r.first_turn_cache_write_tokens ?? 0) +
      (r.first_turn_cache_read_tokens ?? 0),
    0,
  );
  const peaks = nonNull(runs.map((r) => r.peak_prompt_tokens));
  const compactions = nonNull(runs.map((r) => r.compactions));
  const { reReads, attributed } = countEpisodeReReads(episodes, pathsByRun);

  return {
    totalRuns: runs.length,
    measuredRuns: runs.filter(
      (r) =>
        r.first_turn_input_tokens != null ||
        r.first_turn_cache_write_tokens != null ||
        r.first_turn_cache_read_tokens != null,
    ).length,
    episodes: episodes.length,
    repeatRuns: repeats.length,
    pricedRepeatRuns: taxes.length,
    coldStartUsd,
    coldStartShare:
      coldStartUsd != null && pricedSpend > 0
        ? coldStartUsd / pricedSpend
        : null,
    p50PersonaChars: percentile(nonNull(runs.map((r) => r.persona_chars)), 50),
    p50InstructionChars: percentile(
      nonNull(runs.map((r) => r.instruction_chars)),
      50,
    ),
    episodeReReads: reReads,
    attributedReads: attributed,
    firstTurnCachedShare:
      firstTurnBilled > 0 ? firstTurnCacheRead / firstTurnBilled : null,
    p50PeakPromptTokens: percentile(peaks, 50),
    p95PeakPromptTokens: percentile(peaks, 95),
    maxPeakPromptTokens: peaks.length > 0 ? Math.max(...peaks) : null,
    compactedRuns: compactions.filter((c) => c > 0).length,
    // Null rather than 0 when no run recorded the field: "never compacted" and
    // "never counted" are opposite findings and must not render the same.
    compactions:
      compactions.length > 0 ? compactions.reduce((a, b) => a + b, 0) : null,
    compactionsMeasuredRuns: compactions.length,
  };
}

export function queryContextCost(
  db: DatabaseSync,
  range: TimeRange,
  skill?: string,
): ContextCostReport {
  const params = [range.fromMs, range.toMs, ...(skill ? [skill] : [])] as any[];

  const runs = db
    .prepare(
      `SELECT run_id, workspace, started_at_ms, model_id, cost_usd,
              persona_chars, instruction_chars,
              first_turn_input_tokens, first_turn_cache_read_tokens,
              first_turn_cache_write_tokens, peak_prompt_tokens, compactions
       FROM runs
       WHERE started_at_ms >= ? AND started_at_ms < ?
         ${skill ? "AND skill = ?" : ""}`,
    )
    .all(...params) as unknown as ContextRun[];

  const readRows = db
    .prepare(
      `SELECT t.run_id AS run_id, t.target_path AS target_path
       FROM tool_calls t
       JOIN runs r ON r.run_id = t.run_id
       WHERE r.started_at_ms >= ? AND r.started_at_ms < ?
         ${skill ? "AND r.skill = ?" : ""}
         AND t.target_path IS NOT NULL
         AND t.error = 0
         AND t.tool IN (${READ_TOOLS.map(() => "?").join(", ")})`,
    )
    .all(...params, ...READ_TOOLS) as unknown as Array<{
    run_id: string;
    target_path: string;
  }>;

  const pathsByRun = new Map<string, string[]>();
  for (const row of readRows) {
    const list = pathsByRun.get(row.run_id);
    if (list) list.push(row.target_path);
    else pathsByRun.set(row.run_id, [row.target_path]);
  }

  return summarizeContextCost(runs, pathsByRun);
}

/**
 * The section as terminal text, or an empty string when nothing in range
 * carries the fields — a table of dashes would read as a finding.
 */
export function renderContextCost(report: ContextCostReport): string {
  if (report.measuredRuns === 0 && report.attributedReads === 0) return "";

  const rows: string[][] = [
    [
      "Episodes",
      formatCount(report.episodes),
      `sittings of runs ≤${EPISODE_GAP_MS / 60_000} min apart in one workspace`,
    ],
    [
      "Repeat runs",
      `${report.repeatRuns} of ${report.totalRuns}`,
      "began where an earlier run had already built a context",
    ],
    [
      "Cold-start tax",
      formatUsd(report.coldStartUsd),
      report.coldStartShare != null
        ? `${formatPercent(report.coldStartShare, 1)} of spend — turn 1 at write rates, not read rates`
        : "turn 1 at write rates instead of read rates",
    ],
    [
      "Warm start",
      report.firstTurnCachedShare != null
        ? formatPercent(report.firstTurnCachedShare, 0)
        : NO_DATA,
      "of turn 1's tokens the provider still had cached from an earlier run",
    ],
    [
      "Re-read across runs",
      report.attributedReads > 0
        ? `${report.episodeReReads} of ${report.attributedReads}`
        : NO_DATA,
      "files an earlier run in the same episode had already read",
    ],
    [
      "Persona",
      report.p50PersonaChars != null
        ? `${Math.round(report.p50PersonaChars).toLocaleString()} ch`
        : NO_DATA,
      "p50 — identical on every run of a skill",
    ],
    [
      "Instruction",
      report.p50InstructionChars != null
        ? `${Math.round(report.p50InstructionChars).toLocaleString()} ch`
        : NO_DATA,
      "p50 — this run's own context and request",
    ],
    [
      "Peak context",
      `${formatTokens(report.p50PeakPromptTokens)} / ${formatTokens(report.p95PeakPromptTokens)}`,
      "p50 / p95 of the largest prompt a run sent",
    ],
    [
      "Compactions",
      formatCount(report.compactions),
      report.compactions != null
        ? `across ${report.compactedRuns} of ${report.compactionsMeasuredRuns} run(s) — a preserved session would shed context more often`
        : "not recorded for any run in this period",
    ],
  ];

  const out = ["── One-shot context ──"];
  out.push(
    renderTable(
      [
        { header: "MEASURE", align: "left" },
        { header: "VALUE", align: "left" },
        { header: "WHAT IT MEANS", align: "left" },
      ],
      rows,
    ),
  );
  out.push("");
  // The asymmetry is the whole point of the section, and a reader who takes the
  // tax as the answer has read half of it.
  out.push(
    "The tax is what starting over costs; the peak and compaction rows are what" +
      " it buys. Preserving context would remove the tax and raise both.",
  );
  if (report.measuredRuns < report.totalRuns) {
    out.push(
      `Measured on the ${report.measuredRuns} of ${report.totalRuns} runs recorded` +
        ` with per-turn detail; earlier runs did not record it.`,
    );
  }
  return out.join("\n");
}
