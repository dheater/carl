import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";

import {
  computeCost,
  getGlobalConfigDir,
  EVENTS_LOG_FILE,
  RATES_FINGERPRINT,
} from "./skill";
import type { UsageSummary } from "./types";

const METRICS_DB_FILE = "metrics.db";

/**
 * Events before this instant used a `phase` field instead of `skill` and a
 * different event vocabulary. Folding them in would silently mix incompatible
 * schemas, so they are skipped.
 */
export const MODERN_ERA_START = "2026-06-16T00:32:30Z";

/** Test pollution that reached the production log; never a real run. */
const TEST_MODELS = new Set(["test-model", "test-model-id"]);

/**
 * Recorded in the `model` field by an early generation of the logger. It is a
 * skill name, not a model, so costing it would be meaningless.
 */
const NON_MODEL_VALUES = new Set(["code-review"]);

export function getMetricsDbPath(): string {
  return path.join(getGlobalConfigDir(), METRICS_DB_FILE);
}

export function getLiveEventsLogPath(): string {
  return path.join(getGlobalConfigDir(), EVENTS_LOG_FILE);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id                 TEXT PRIMARY KEY,
  invocation_id          TEXT,
  started_at             TEXT,
  started_at_ms          INTEGER,
  ended_at               TEXT,
  skill                  TEXT,
  model                  TEXT,
  effort                 TEXT,
  workspace              TEXT,
  git_branch             TEXT,
  git_sha                TEXT,
  duration_ms            INTEGER,
  status                 TEXT,
  error_type             TEXT,
  retry_count            INTEGER,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  cache_write_tokens     INTEGER,
  turns                  INTEGER,
  model_id               TEXT,
  cost_usd               REAL,
  prompt_chars           INTEGER,
  -- The two halves of prompt_chars. The persona is the same text on every run of
  -- a skill; the instruction is what this run had to restate.
  persona_chars          INTEGER,
  instruction_chars      INTEGER,
  response_chars         INTEGER,
  -- Turn 1 on its own: the cold-start tax carl pays for starting every run from
  -- an empty conversation. Invisible in the totals, because a long run writes
  -- cache on later turns too.
  first_turn_input_tokens       INTEGER,
  first_turn_output_tokens      INTEGER,
  first_turn_cache_read_tokens  INTEGER,
  first_turn_cache_write_tokens INTEGER,
  -- Largest prompt the run ever sent, and the number of times it had to shed
  -- context to keep sending them.
  peak_prompt_tokens     INTEGER,
  compactions            INTEGER,
  tool_call_count        INTEGER NOT NULL DEFAULT 0,
  tool_error_count       INTEGER NOT NULL DEFAULT 0,
  tracked_changed_before INTEGER,
  tracked_changed_after  INTEGER,
  untracked_before       INTEGER,
  untracked_after        INTEGER,
  source_path            TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at_ms);
CREATE INDEX IF NOT EXISTS idx_runs_skill_started ON runs(skill, started_at_ms);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  timestamp    TEXT,
  timestamp_ms INTEGER,
  tool         TEXT,
  duration_ms  INTEGER,
  output_bytes INTEGER,
  error        INTEGER,
  -- The call's arguments, as the runner one-lined them. Kept verbatim because
  -- the log has always carried it and dropping it made every path-level
  -- question — which files does a run read, does the next run read them again —
  -- unanswerable without re-parsing the JSONL by hand.
  input_summary TEXT,
  -- The file the call names, lifted out of input_summary so those questions are
  -- one query rather than one query and a regex.
  target_path   TEXT,
  UNIQUE(run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_path ON tool_calls(target_path);

-- One row per model request, in request order: the run's context-growth curve.
-- prompt_tokens is everything billed as input for that turn — fresh input plus
-- cache read plus cache write — which is the size of the conversation at that
-- point, and the figure a preserved context would carry into the next run.
CREATE TABLE IF NOT EXISTS turn_tokens (
  run_id        TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  prompt_tokens INTEGER,
  PRIMARY KEY (run_id, turn)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  source_path     TEXT PRIMARY KEY,
  bytes_consumed  INTEGER NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  ingested_at     TEXT NOT NULL
);

-- Single-row table holding the rate fingerprint every cached cost was computed
-- with, so a rate change can be detected and the affected rows repriced.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const RATES_FINGERPRINT_KEY = "rates_fingerprint";

const DERIVATION_VERSION_KEY = "derivation_version";

/**
 * Bumped whenever ingest derives a *different value* from the same event.
 *
 * The schema check below catches new columns; this catches new meanings, which
 * no column list can see. Path canonicalisation is why it exists: `target_path`
 * kept its name and type while every row's value changed spelling, and a cache
 * holding both generations reports a re-read as a first read — silently, and in
 * the one figure the section exists to produce.
 *
 * 2 — target_path canonicalised against the run's workspace.
 */
const DERIVATION_VERSION = "2";

export function openMetricsDb(dbPath = getMetricsDbPath()): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  // Drift is checked first: applying SCHEMA over a stale table is what fails, so
  // the check cannot come after it.
  if (hasOutdatedSchema(db)) {
    console.error(
      "[Stats] Schema changed — rebuilding the metrics cache from the event log.",
    );
    resetMetricsDb(db);
  } else {
    db.exec(SCHEMA);
    if (hasOutdatedDerivation(db)) {
      console.error(
        "[Stats] Ingest changed — rebuilding the metrics cache from the event log.",
      );
      resetMetricsDb(db);
    }
  }
  repriceIfRatesChanged(db);
  return db;
}

/**
 * One column per generation of the schema, named the moment it was added. A new
 * column here is the whole migration: the check below sees it missing and the
 * cache is rebuilt from the log.
 */
const REQUIRED_COLUMNS: Record<string, string> = {
  runs: "compactions",
  tool_calls: "target_path",
};

/**
 * True when an existing table predates the current column set.
 * `CREATE TABLE IF NOT EXISTS` silently leaves an existing table alone, so a DB
 * written by an older carl would otherwise fail at the first insert. Migrating is
 * pointless here — the DB is a cache and the log can refill it — so the caller
 * drops and re-ingests instead. A table that does not exist at all is new, not
 * outdated; `turn_tokens` needs no entry for that reason — no DB has ever had an
 * older version of it.
 */
function hasOutdatedSchema(db: DatabaseSync): boolean {
  return Object.entries(REQUIRED_COLUMNS).some(([table, required]) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    return columns.length > 0 && !columns.includes(required);
  });
}

/**
 * True when the cache holds values an older ingest derived. A DB with nothing
 * in it is not outdated — there is no derived value to be stale — so a cache
 * being created for the first time records the version and rebuilds nothing.
 */
function hasOutdatedDerivation(db: DatabaseSync): boolean {
  const stored = (
    db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(DERIVATION_VERSION_KEY) as { value: string } | undefined
  )?.value;
  if (stored === DERIVATION_VERSION) return false;

  const runs = (
    db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
  ).n;
  if (runs === 0) {
    writeDerivationVersion(db);
    return false;
  }
  return true;
}

/** Drops every table. The DB is a cache; JSONL remains the source of truth. */
export function resetMetricsDb(db: DatabaseSync): void {
  db.exec(
    "DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS tool_calls;" +
      " DROP TABLE IF EXISTS turn_tokens;" +
      " DROP TABLE IF EXISTS ingest_log; DROP TABLE IF EXISTS meta;",
  );
  db.exec(SCHEMA);
  // The rows re-ingested after this will be priced at current rates and derived
  // by the current ingest, so record both now — otherwise the next open would
  // see neither and redo work that is already current.
  writeRatesFingerprint(db);
  writeDerivationVersion(db);
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function writeRatesFingerprint(db: DatabaseSync): void {
  writeMeta(db, RATES_FINGERPRINT_KEY, RATES_FINGERPRINT);
}

function writeDerivationVersion(db: DatabaseSync): void {
  writeMeta(db, DERIVATION_VERSION_KEY, DERIVATION_VERSION);
}

export type RepriceResult = {
  /** True when rates had changed and stored costs were recomputed. */
  repriced: boolean;
  runsRepriced: number;
};

/**
 * Recomputes every cached cost at current rates when the rate table has changed.
 *
 * Costs are stored rather than computed per query because reports are frequent
 * and repricing is O(runs). That makes the stored cost a cache, and this keeps it
 * coherent. Without it, incremental ingest would leave each row priced at
 * whatever rates were current on the day it was ingested, so the table would
 * accumulate a mix of rate generations and a vendor price change would surface as
 * a step in the cost trend — indistinguishable from a change in carl's own
 * efficiency, which is the one thing these metrics exist to show.
 *
 * Cheap in the common case: one string comparison when rates are unchanged.
 */
export function repriceIfRatesChanged(db: DatabaseSync): RepriceResult {
  const stored = (
    db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(RATES_FINGERPRINT_KEY) as { value: string } | undefined
  )?.value;

  if (stored === RATES_FINGERPRINT) return { repriced: false, runsRepriced: 0 };

  // Only rows with a model can be repriced; the rest have no rates to apply and
  // must stay NULL rather than becoming a misleading $0.
  const rows = db
    .prepare(
      `SELECT run_id, model_id, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens
       FROM runs WHERE model_id IS NOT NULL`,
    )
    .all() as Array<{
    run_id: string;
    model_id: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
  }>;

  const update = db.prepare("UPDATE runs SET cost_usd = ? WHERE run_id = ?");

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      update.run(
        computeCost({
          // `source` is not part of the pricing math; the stored columns are the
          // complete set of inputs `computeCost` reads.
          source: "reprice",
          modelId: row.model_id,
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cacheReadTokens: row.cache_read_tokens ?? 0,
          cacheWriteTokens: row.cache_write_tokens ?? 0,
        }),
        row.run_id,
      );
    }
    writeRatesFingerprint(db);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // A first-ever open has nothing to reprice; don't report that as a rate change.
  const repriced = stored !== undefined;
  if (repriced) {
    // On stderr: it explains a shift in every historical figure, and reporting
    // it silently would look like carl's own cost changing.
    console.error(
      `[Stats] Rates changed — repriced ${rows.length} run(s) at current rates.`,
    );
  }
  return { repriced, runsRepriced: rows.length };
}

type RawEvent = {
  timestamp?: string;
  run_id?: string;
  invocation_id?: string;
  event?: string;
  subject?: string;
  duration_ms?: number;
  skill?: string;
  model?: string;
  effort?: string;
  workspace?: string;
  git_branch?: string | null;
  git_sha?: string | null;
  meta?: Record<string, any>;
};

export type IngestResult = {
  sourcePath: string;
  linesRead: number;
  eventsAccepted: number;
  eventsSkipped: number;
  malformedLines: number;
  runsTouched: number;
  bytesConsumed: number;
};

function normalizeModel(model: string | undefined): string | null {
  if (!model) return null;
  if (NON_MODEL_VALUES.has(model)) return null;
  return model;
}

/**
 * Reconstructs the modelId the runner would have reported. Older events recorded
 * only the short alias (`sonnet4.6`) with no usage.modelId, and `computeCost`
 * matches on family patterns — the alias contains the family name, so it prices
 * correctly either way.
 */
function resolveModelId(
  usage: UsageSummary | undefined,
  model: string | null,
): string | undefined {
  return usage?.modelId ?? model ?? undefined;
}

/**
 * A backend that reports placeholder zeros instead of real measurements would
 * drag duration and size percentiles toward zero if stored as 0, so a
 * non-positive value is recorded as unknown rather than as a measurement.
 */
function measuredOrNull(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * The keys carl's tools name a file with. `pattern` is deliberately absent: a
 * glob is not a path, and storing one here would make a search look like a read
 * of a file that may not exist.
 */
const PATH_KEY = /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Tools whose whole summary is the path.
 *
 * carl's predecessor logged one argument per tool rather than the argument
 * object, so a `read_file` row reads `src/carl.ts` with no JSON around it —
 * 1,763 of them, the second-largest tool in the log. Restricted to these names
 * because a bare `bash` summary is a command line, and `npm test` is not a file.
 */
const BARE_PATH_TOOLS = new Set([
  "read",
  "read_file",
  "edit",
  "str_replace",
  "write",
  "write_file",
]);

/** A summary the runner cut short; half a path names a different file. */
function isTruncated(summary: string): boolean {
  return summary.endsWith("…");
}

/**
 * One spelling per file, so two runs that read the same file compare equal.
 *
 * The model chooses the spelling, and it varies between runs of the same skill:
 * one run reads `a.ts`, the next reads `/private/tmp/proj/a.ts`. Left alone,
 * those are two files and a re-read looks like a first read. Resolved against
 * the run's workspace when there is one, then made relative again so the row
 * stays readable and stays comparable across a moved checkout. Purely lexical —
 * the file may be long gone by the time the log is ingested, and a stat() here
 * would answer for today's filesystem rather than the run's.
 */
function canonicalPath(file: string, workspace: string | null): string {
  if (!workspace) return path.normalize(file);
  const absolute = path.resolve(workspace, file);
  const relative = path.relative(workspace, absolute);
  // Outside the workspace: keep it absolute rather than spell it with `..`.
  return relative.startsWith("..") ? absolute : relative;
}

/**
 * The file a tool call named, recovered from the one-lined arguments the runner
 * logged. A summary truncated mid-path has no closing quote and yields null,
 * which is the right answer: an unknown path beats a silently shortened one.
 */
export function targetPathFrom(
  summary: string | undefined,
  tool?: string | null,
  workspace?: string | null,
): string | null {
  if (!summary) return null;
  const match = PATH_KEY.exec(summary);
  if (!match) {
    if (
      tool != null &&
      BARE_PATH_TOOLS.has(tool) &&
      !summary.startsWith("{") &&
      !summary.startsWith("[") &&
      !isTruncated(summary)
    ) {
      return canonicalPath(summary, workspace ?? null);
    }
    return null;
  }
  try {
    // Back through JSON so `\\` and `\"` in the logged arguments decode to the
    // path the tool actually received.
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    return decoded.length > 0
      ? canonicalPath(decoded, workspace ?? null)
      : null;
  } catch {
    return null;
  }
}

/**
 * A run's workspace. New events carry it directly; legacy events only reveal it
 * through the path of the per-directory log they were written to.
 */
function resolveWorkspace(
  event: RawEvent,
  workspaceFromPath: string | null,
): string | null {
  return event.workspace ?? workspaceFromPath;
}

/** `<workspace>/.carl/events.jsonl` → `<workspace>`. */
export function workspaceFromLogPath(sourcePath: string): string | null {
  const dir = path.dirname(path.resolve(sourcePath));
  if (path.basename(dir) !== ".carl") return null;
  return path.dirname(dir);
}

function isModernEra(timestamp: string | undefined): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return !Number.isNaN(parsed) && parsed >= Date.parse(MODERN_ERA_START);
}

/**
 * True for events this ingester can fold into a run. Rejects pre-rename
 * schemas, test pollution, and rows missing the identity fields the fold needs.
 */
function isIngestibleEvent(event: RawEvent): boolean {
  if (!event.run_id || !event.timestamp) return false;
  if (!isModernEra(event.timestamp)) return false;
  if (event.skill === undefined) return false; // pre-rename `phase` events
  if (event.model && TEST_MODELS.has(event.model)) return false;
  return (
    event.event === "skill" ||
    event.event === "prompt" ||
    event.event === "tool_call"
  );
}

type Statements = {
  upsertRunIdentity: any;
  applySkillEvent: any;
  applyPromptEvent: any;
  insertToolCall: any;
  bumpToolCounts: any;
  insertTurnTokens: any;
};

function prepareStatements(db: DatabaseSync): Statements {
  return {
    // Establishes the row and the fields common to every event type. COALESCE
    // keeps the earliest timestamp regardless of the order events arrive in.
    upsertRunIdentity: db.prepare(`
      INSERT INTO runs (
        run_id, invocation_id, started_at, started_at_ms, skill, model, effort,
        workspace, git_branch, git_sha, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        invocation_id = COALESCE(runs.invocation_id, excluded.invocation_id),
        started_at    = MIN(runs.started_at, excluded.started_at),
        started_at_ms = MIN(runs.started_at_ms, excluded.started_at_ms),
        skill         = COALESCE(runs.skill, excluded.skill),
        model         = COALESCE(runs.model, excluded.model),
        effort        = COALESCE(runs.effort, excluded.effort),
        workspace     = COALESCE(runs.workspace, excluded.workspace),
        git_branch    = COALESCE(runs.git_branch, excluded.git_branch),
        git_sha       = COALESCE(runs.git_sha, excluded.git_sha),
        source_path   = COALESCE(runs.source_path, excluded.source_path)
    `),

    applySkillEvent: db.prepare(`
      UPDATE runs SET
        ended_at               = ?,
        duration_ms            = ?,
        status                 = ?,
        error_type             = ?,
        retry_count            = ?,
        tracked_changed_before = ?,
        tracked_changed_after  = ?,
        untracked_before       = ?,
        untracked_after        = ?
      WHERE run_id = ?
    `),

    // Usage may arrive on the prompt event (success) or the skill event
    // (failure). COALESCE on the existing value keeps whichever landed first
    // rather than overwriting real tokens with NULL.
    applyPromptEvent: db.prepare(`
      UPDATE runs SET
        input_tokens       = COALESCE(?, input_tokens),
        output_tokens      = COALESCE(?, output_tokens),
        cache_read_tokens  = COALESCE(?, cache_read_tokens),
        cache_write_tokens = COALESCE(?, cache_write_tokens),
        turns              = COALESCE(?, turns),
        model_id           = COALESCE(?, model_id),
        cost_usd           = COALESCE(?, cost_usd),
        prompt_chars       = COALESCE(?, prompt_chars),
        persona_chars      = COALESCE(?, persona_chars),
        instruction_chars  = COALESCE(?, instruction_chars),
        response_chars     = COALESCE(?, response_chars),
        first_turn_input_tokens       = COALESCE(?, first_turn_input_tokens),
        first_turn_output_tokens      = COALESCE(?, first_turn_output_tokens),
        first_turn_cache_read_tokens  = COALESCE(?, first_turn_cache_read_tokens),
        first_turn_cache_write_tokens = COALESCE(?, first_turn_cache_write_tokens),
        peak_prompt_tokens = COALESCE(?, peak_prompt_tokens),
        compactions        = COALESCE(?, compactions)
      WHERE run_id = ?
    `),

    insertToolCall: db.prepare(`
      INSERT INTO tool_calls (
        run_id, ordinal, timestamp, timestamp_ms, tool, duration_ms, output_bytes,
        error, input_summary, target_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, ordinal) DO NOTHING
    `),

    insertTurnTokens: db.prepare(`
      INSERT INTO turn_tokens (run_id, turn, prompt_tokens) VALUES (?, ?, ?)
      ON CONFLICT(run_id, turn) DO NOTHING
    `),

    bumpToolCounts: db.prepare(`
      UPDATE runs SET
        tool_call_count = (SELECT COUNT(*) FROM tool_calls WHERE run_id = ?),
        tool_error_count = (SELECT COUNT(*) FROM tool_calls WHERE run_id = ? AND error = 1)
      WHERE run_id = ?
    `),
  };
}

function applyEvent(
  stmts: Statements,
  event: RawEvent,
  sourcePath: string,
  workspaceFromPath: string | null,
  toolOrdinal: () => number,
): void {
  const runId = event.run_id!;
  const model = normalizeModel(event.model);

  stmts.upsertRunIdentity.run(
    runId,
    event.invocation_id ?? null,
    event.timestamp!,
    Date.parse(event.timestamp!),
    event.skill ?? null,
    model,
    event.effort ?? null,
    resolveWorkspace(event, workspaceFromPath),
    event.git_branch ?? null,
    event.git_sha ?? null,
    sourcePath,
  );

  const meta = event.meta ?? {};

  if (event.event === "skill") {
    stmts.applySkillEvent.run(
      event.timestamp!,
      event.duration_ms ?? null,
      meta.status ?? null,
      meta.error_type ?? null,
      meta.retry_count ?? null,
      meta.tracked_changed_before ?? null,
      meta.tracked_changed_after ?? null,
      meta.untracked_before ?? null,
      meta.untracked_after ?? null,
      runId,
    );
  }

  // Failed runs carry their spend on the skill event, so read usage from both.
  const usage: UsageSummary | undefined = meta.usage;
  if (event.event === "prompt" || (event.event === "skill" && usage)) {
    const modelId = resolveModelId(usage, model);
    const cost = usage ? computeCost({ ...usage, modelId }) : null;
    const series = usage?.turnPromptTokens;
    stmts.applyPromptEvent.run(
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.cacheReadTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      usage?.turns ?? null,
      // Kept so cost can be recomputed later without re-reading the log.
      modelId ?? null,
      cost,
      event.event === "prompt" ? (meta.prompt_chars ?? null) : null,
      event.event === "prompt" ? (meta.persona_chars ?? null) : null,
      event.event === "prompt" ? (meta.instruction_chars ?? null) : null,
      event.event === "prompt" ? (meta.response_chars ?? null) : null,
      usage?.firstTurn?.inputTokens ?? null,
      usage?.firstTurn?.outputTokens ?? null,
      usage?.firstTurn?.cacheReadTokens ?? null,
      usage?.firstTurn?.cacheWriteTokens ?? null,
      series && series.length > 0 ? Math.max(...series) : null,
      usage?.compactions ?? null,
      runId,
    );

    // Turn 1 is `turn = 1`, matching how the run reads in the log rather than
    // how the array is indexed.
    if (series) {
      for (const [index, tokens] of series.entries()) {
        stmts.insertTurnTokens.run(runId, index + 1, tokens);
      }
    }
  }

  if (event.event === "tool_call") {
    const inputSummary =
      typeof meta.input_summary === "string" && meta.input_summary.length > 0
        ? meta.input_summary
        : null;
    const tool = event.subject ?? meta.tool ?? null;
    const workspace = resolveWorkspace(event, workspaceFromPath);
    stmts.insertToolCall.run(
      runId,
      toolOrdinal(),
      event.timestamp!,
      Date.parse(event.timestamp!),
      tool,
      measuredOrNull(event.duration_ms),
      measuredOrNull(meta.output_bytes),
      meta.error ? 1 : 0,
      inputSummary,
      targetPathFrom(inputSummary ?? undefined, tool, workspace),
    );
    stmts.bumpToolCounts.run(runId, runId, runId);
  }
}

/**
 * Folds new events from one JSONL file into the DB, resuming from the byte
 * offset recorded by the previous ingest. Safe to call repeatedly: unchanged
 * files are no-ops and re-read events upsert onto the same rows.
 */
export function ingestFile(
  db: DatabaseSync,
  sourcePath: string,
  options: { workspaceFromPath?: string | null } = {},
): IngestResult {
  const resolved = path.resolve(sourcePath);
  const empty: IngestResult = {
    sourcePath: resolved,
    linesRead: 0,
    eventsAccepted: 0,
    eventsSkipped: 0,
    malformedLines: 0,
    runsTouched: 0,
    bytesConsumed: 0,
  };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return empty;
  }

  const watermark = db
    .prepare(
      "SELECT bytes_consumed, mtime_ms, tool_call_count FROM ingest_log WHERE source_path = ?",
    )
    .get(resolved) as
    | { bytes_consumed: number; mtime_ms: number; tool_call_count: number }
    | undefined;

  let offset = watermark?.bytes_consumed ?? 0;
  let nextToolOrdinal = watermark?.tool_call_count ?? 0;

  // A file that shrank or went back in time was rotated or rewritten; the old
  // offset no longer points at a record boundary, so start over.
  const rotated =
    watermark !== undefined &&
    (stat.size < watermark.bytes_consumed || stat.mtimeMs < watermark.mtime_ms);
  if (rotated) {
    offset = 0;
    nextToolOrdinal = 0;
    db.prepare(
      "DELETE FROM tool_calls WHERE run_id IN (SELECT run_id FROM runs WHERE source_path = ?)",
    ).run(resolved);
    db.prepare(
      "DELETE FROM turn_tokens WHERE run_id IN (SELECT run_id FROM runs WHERE source_path = ?)",
    ).run(resolved);
  }

  if (stat.size === offset && !rotated) {
    empty.bytesConsumed = offset;
    return empty;
  }

  const fd = fs.openSync(resolved, "r");
  let buffer: Buffer;
  try {
    const length = stat.size - offset;
    buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buffer.toString("utf-8");
  // Only whole lines are records. A trailing fragment means the writer is
  // mid-append; leave it for the next ingest rather than parsing a partial line.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    empty.bytesConsumed = offset;
    return empty;
  }
  const complete = text.slice(0, lastNewline);
  const consumed =
    offset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf-8");

  const workspaceFromPath =
    options.workspaceFromPath ?? workspaceFromLogPath(resolved);

  const stmts = prepareStatements(db);
  const result: IngestResult = { ...empty, bytesConsumed: consumed };
  const runsTouched = new Set<string>();

  db.exec("BEGIN");
  try {
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      result.linesRead++;

      let event: RawEvent;
      try {
        event = JSON.parse(line) as RawEvent;
      } catch {
        result.malformedLines++;
        continue;
      }

      if (!isIngestibleEvent(event)) {
        result.eventsSkipped++;
        continue;
      }

      applyEvent(stmts, event, resolved, workspaceFromPath, () =>
        event.event === "tool_call" ? nextToolOrdinal++ : -1,
      );
      result.eventsAccepted++;
      runsTouched.add(event.run_id!);
    }

    db.prepare(
      `INSERT INTO ingest_log (source_path, bytes_consumed, mtime_ms, tool_call_count, ingested_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         bytes_consumed = excluded.bytes_consumed,
         mtime_ms = excluded.mtime_ms,
         tool_call_count = excluded.tool_call_count,
         ingested_at = excluded.ingested_at`,
    ).run(
      resolved,
      consumed,
      Math.floor(stat.mtimeMs),
      nextToolOrdinal,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  result.runsTouched = runsTouched.size;
  return result;
}

/** Ingests the live central log. Called before every report so it never lags. */
export function ingestLiveLog(db: DatabaseSync): IngestResult {
  return ingestFile(db, getLiveEventsLogPath(), { workspaceFromPath: null });
}
