/**
 * The parts of the model benchmark that are arithmetic rather than orchestration.
 *
 * Kept separate from src/bench.ts because a benchmark's failure mode is quiet: a
 * join that silently matches the wrong run, or an average taken over the trials
 * that happened to finish, produces a table that looks exactly like a correct
 * one. Everything here is a pure function over records, and everything here is
 * tested.
 *
 * The one guard worth naming: `joinTrialRuns` compares the model carl was *asked*
 * for against the model the event log says it *used*. carl resolves a model name
 * against the local server first and falls back to Bedrock, so a benchmark run
 * with the local server down would otherwise measure Sonnet three times and
 * report it as three models. A mismatch is carried on the record and refused
 * later, not smoothed over here.
 */

import { matchesModelName } from "./dsh-runner";
import {
  formatUsd,
  formatDuration,
  formatPercent,
  mean,
  renderTable,
  NO_DATA,
} from "./stats-format";

/** The three axes the judge scores, in the order they are rendered. */
export const JUDGE_AXES = ["correctness", "scope", "style"] as const;

export type JudgeAxis = (typeof JUDGE_AXES)[number];

export type JudgeScore = {
  [K in JudgeAxis]: number;
} & {
  /** How many judge samples produced a parsable verdict. */
  samples: number;
  note: string;
};

export type BenchArgs = {
  models: string[];
  tasks: string[];
  reps: number;
  effort: string;
  timeoutMs: number;
  judge: boolean;
  judgeModel: string;
  judgeSamples: number;
  /** Null means "derive a timestamped directory under bench/results". */
  outDir: string | null;
};

/**
 * One task per difficulty tier. The default rather than all six because the first
 * question a new benchmark has to answer is whether the harness works, and nine
 * trials answer it in half an hour where fifty-four take an afternoon.
 */
export const SMOKE_TASKS = [
  "01-easy-count-by-status",
  "03-med-complete-unknown",
  "05-hard-status-refactor",
];

export const DEFAULT_MODELS = ["sonnet4.6", "qwen38-27b", "qwen35-9b"];

/** Long enough for a 27B to finish a hard task; the observed tail is ~31 min. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export const DEFAULT_JUDGE_SAMPLES = 3;

function list(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseBenchArgs(argv: string[], allTasks: string[]): BenchArgs {
  const args: BenchArgs = {
    models: DEFAULT_MODELS,
    tasks: SMOKE_TASKS,
    reps: 1,
    effort: "medium",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    judge: true,
    judgeModel: "sonnet4.6",
    judgeSamples: DEFAULT_JUDGE_SAMPLES,
    outDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--models":
        args.models = list(next());
        break;
      case "--tasks": {
        const value = next();
        args.tasks = value === "all" ? [...allTasks] : list(value);
        break;
      }
      case "--reps":
        args.reps = Number(next());
        break;
      case "--effort":
        args.effort = next();
        break;
      case "--timeout":
        args.timeoutMs = Number(next()) * 1000;
        break;
      case "--no-judge":
        args.judge = false;
        break;
      case "--judge-model":
        args.judgeModel = next();
        break;
      case "--judge-samples":
        args.judgeSamples = Number(next());
        break;
      case "--out":
        args.outDir = next();
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (args.models.length === 0) throw new Error("--models selected nothing");
  if (args.tasks.length === 0) throw new Error("--tasks selected nothing");
  if (!Number.isInteger(args.reps) || args.reps < 1) {
    throw new Error("--reps must be a positive integer");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  if (!Number.isInteger(args.judgeSamples) || args.judgeSamples < 1) {
    throw new Error("--judge-samples must be a positive integer");
  }
  const unknown = args.tasks.filter((task) => !allTasks.includes(task));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown task(s): ${unknown.join(", ")}\nAvailable: ${allTasks.join(", ")}`,
    );
  }
  return args;
}

export type TrialRecord = {
  id: string;
  /** The model carl was asked for. Compared against the log, never trusted. */
  model: string;
  task: string;
  rep: number;
  /** Real path, so it compares equal to what the event log recorded. */
  workspace: string;
  startedAtMs: number;
  endedAtMs: number;
  wallMs: number;
  carlExit: number | null;
  timedOut: boolean;
  pass: boolean;
  checkOutput: string;
  diffBytes: number;
  filesChanged: number;

  /** Everything below is filled by joinTrialRuns from the event log. */
  loggedModel?: string | null;
  modelMismatch?: boolean;
  /** Runs the log attributed to this trial. More than one means carl retried. */
  runCount?: number;
  costUsd?: number | null;
  turns?: number | null;
  toolCalls?: number | null;
  toolErrors?: number | null;
  outputTokens?: number | null;
  runStatus?: string | null;

  judge?: JudgeScore | null;
};

/** The columns joinTrialRuns needs from the `runs` table. */
export type BenchRunRow = {
  run_id: string;
  workspace: string | null;
  started_at_ms: number | null;
  /**
   * The route that actually served the request — a Bedrock model id, or the id
   * mtplx's server reports. This, not `runs.model`, is what the guard checks:
   * `runs.model` is the name carl was *asked* for, so it agrees with the trial by
   * construction and would confirm a misroute rather than catch one.
   */
  model_id: string | null;
  cost_usd: number | null;
  turns: number | null;
  tool_call_count: number | null;
  tool_error_count: number | null;
  output_tokens: number | null;
  status: string | null;
};

/**
 * Clock slack on either side of a trial when deciding which runs belong to it.
 *
 * The trial's own timestamps bracket the carl subprocess, and the run's
 * `started_at` is written inside it, so the window only has to absorb rounding.
 * Kept small on purpose: the workspace is already unique per trial, and a wide
 * window would let a stray run in without making a correct match any more likely.
 */
export const JOIN_SLACK_MS = 10_000;

function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * Attaches each trial's logged run to it, matched on workspace and time.
 *
 * Workspace is the key because every trial gets its own copy of the fixture, so
 * the path identifies the trial exactly — no id has to survive a round trip
 * through carl, which does not expose its run id.
 *
 * Several runs for one trial is not an error: `carl code` starts a whole new run
 * per repair attempt. The benchmark configures no repairs, so `runCount > 1` means
 * an assumption broke, and the count is reported rather than averaged away.
 */
export function joinTrialRuns(
  trials: TrialRecord[],
  rows: BenchRunRow[],
): TrialRecord[] {
  return trials.map((trial) => {
    const mine = rows.filter(
      (row) =>
        row.workspace === trial.workspace &&
        row.started_at_ms != null &&
        row.started_at_ms >= trial.startedAtMs - JOIN_SLACK_MS &&
        row.started_at_ms <= trial.endedAtMs + JOIN_SLACK_MS,
    );
    if (mine.length === 0) {
      return { ...trial, loggedModel: null, modelMismatch: false, runCount: 0 };
    }
    // Distinct in practice; a set keeps a straight face if it ever is not.
    const ids = [...new Set(mine.map((row) => row.model_id ?? "(unrecorded)"))];
    const loggedModel = ids.join("+");
    return {
      ...trial,
      loggedModel,
      // A trial whose log names another route measured another model. The
      // benchmark refuses these rather than reporting them. `matchesModelName` is
      // the same comparison carl used to pick the route, so a name that selected
      // a model recognizes it here.
      modelMismatch: ids.some((id) => !matchesModelName(trial.model, id)),
      runCount: mine.length,
      costUsd: sumOrNull(mine.map((row) => row.cost_usd)),
      turns: sumOrNull(mine.map((row) => row.turns)),
      toolCalls: sumOrNull(mine.map((row) => row.tool_call_count)),
      toolErrors: sumOrNull(mine.map((row) => row.tool_error_count)),
      outputTokens: sumOrNull(mine.map((row) => row.output_tokens)),
      runStatus: mine[mine.length - 1].status,
    };
  });
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The judge's verdict, pulled out of whatever prose it wrapped around the JSON.
 *
 * The judge is asked for a bare object and usually obliges, but "usually" is not
 * a parser: a fenced block or a sentence of preamble is common enough that
 * refusing it would throw away samples for a formatting preference. Null when no
 * object with all three axes in range is in there, because a half-parsed verdict
 * is worse than a missing one.
 */
export function parseJudgeVerdict(
  text: string,
): { correctness: number; scope: number; style: number; note: string } | null {
  // Every balanced-looking object in the text, largest first: the outermost is
  // the verdict when the judge nested anything inside it.
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    for (let end = start; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, end + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates.sort((a, b) => b.length - a.length)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const body = parsed as Record<string, unknown>;
    const scores = JUDGE_AXES.map((axis) => body[axis]);
    if (
      !scores.every(
        (score) =>
          typeof score === "number" &&
          Number.isFinite(score) &&
          score >= 1 &&
          score <= 5,
      )
    ) {
      continue;
    }
    const [correctness, scope, style] = scores as number[];
    return {
      correctness,
      scope,
      style,
      note: typeof body.note === "string" ? body.note : "",
    };
  }
  return null;
}

/** The median of each axis across samples, or null when none parsed. */
export function combineJudgeSamples(
  samples: Array<{
    correctness: number;
    scope: number;
    style: number;
    note: string;
  }>,
): JudgeScore | null {
  if (samples.length === 0) return null;
  const at = (axis: JudgeAxis): number =>
    median(samples.map((sample) => sample[axis]))!;
  return {
    correctness: at("correctness"),
    scope: at("scope"),
    style: at("style"),
    samples: samples.length,
    // The first note, not all of them: this is a label for a human skimming the
    // table, and three paraphrases of one opinion is not three times the signal.
    note: samples[0].note,
  };
}

export type ModelSummary = {
  model: string;
  trials: number;
  /** Trials excluded from every rate below, because the log named another model. */
  mismatches: number;
  scored: number;
  passes: number;
  passRate: number | null;
  timeouts: number;
  meanWallMs: number | null;
  totalCostUsd: number | null;
  meanCostUsd: number | null;
  costPerPassUsd: number | null;
  meanTurns: number | null;
  toolErrorRate: number | null;
  judgeCorrectness: number | null;
  judgeScope: number | null;
  judgeStyle: number | null;
};

/**
 * Per-model rates over the trials that actually measured that model.
 *
 * Mismatched trials are counted and then dropped. Including them would let a
 * misrouted run improve or damage the score of a model that never ran, which is
 * the one error a benchmark must not make quietly.
 */
export function summarizeBench(trials: TrialRecord[]): ModelSummary[] {
  const byModel = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const list = byModel.get(trial.model);
    if (list) list.push(trial);
    else byModel.set(trial.model, [trial]);
  }

  return [...byModel.entries()].map(([model, all]) => {
    const mismatches = all.filter((trial) => trial.modelMismatch === true);
    const scored = all.filter((trial) => trial.modelMismatch !== true);
    const passes = scored.filter((trial) => trial.pass);
    const costs = scored
      .map((trial) => trial.costUsd)
      .filter((cost): cost is number => cost != null);
    const totalCostUsd =
      costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
    const calls = scored.reduce(
      (sum, trial) => sum + (trial.toolCalls ?? 0),
      0,
    );
    const errors = scored.reduce(
      (sum, trial) => sum + (trial.toolErrors ?? 0),
      0,
    );
    const judged = scored
      .map((trial) => trial.judge)
      .filter((judge): judge is JudgeScore => judge != null);

    return {
      model,
      trials: all.length,
      mismatches: mismatches.length,
      scored: scored.length,
      passes: passes.length,
      passRate: scored.length > 0 ? passes.length / scored.length : null,
      timeouts: scored.filter((trial) => trial.timedOut).length,
      meanWallMs: mean(scored.map((trial) => trial.wallMs)),
      totalCostUsd,
      meanCostUsd: costs.length > 0 ? totalCostUsd! / costs.length : null,
      // Cost per *passing* trial, not per trial: a model that is cheap because it
      // gives up early is not cheap.
      costPerPassUsd:
        totalCostUsd != null && passes.length > 0
          ? totalCostUsd / passes.length
          : null,
      meanTurns: mean(
        scored
          .map((trial) => trial.turns)
          .filter((turns): turns is number => turns != null),
      ),
      toolErrorRate: calls > 0 ? errors / calls : null,
      judgeCorrectness: median(judged.map((judge) => judge.correctness)),
      judgeScope: median(judged.map((judge) => judge.scope)),
      judgeStyle: median(judged.map((judge) => judge.style)),
    };
  });
}

function score(value: number | null): string {
  return value != null ? value.toFixed(1) : NO_DATA;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * The comparison table, plus the per-trial detail underneath it.
 *
 * Local models are priced at nothing, which is true of the marginal request and
 * false of the machine, so the cost columns read `free` rather than `$0.00` — a
 * zero in a cost column invites the reader to divide by it.
 */
export function renderBenchReport(
  summaries: ModelSummary[],
  trials: TrialRecord[],
): string {
  const out: string[] = [];

  out.push("── Models ──");
  out.push(
    renderTable(
      [
        { header: "MODEL", align: "left" },
        { header: "PASS" },
        { header: "RATE" },
        { header: "MEAN WALL" },
        { header: "MEAN TURNS" },
        { header: "TOOL ERR" },
        { header: "COST" },
        { header: "$/PASS" },
        { header: "CORRECT" },
        { header: "SCOPE" },
        { header: "STYLE" },
      ],
      summaries.map((s) => [
        s.model,
        `${s.passes}/${s.scored}`,
        formatPercent(s.passRate),
        formatDuration(s.meanWallMs),
        s.meanTurns != null ? s.meanTurns.toFixed(1) : NO_DATA,
        formatPercent(s.toolErrorRate, 1),
        s.totalCostUsd != null ? formatUsd(s.totalCostUsd) : "free",
        s.costPerPassUsd != null ? formatUsd(s.costPerPassUsd) : "free",
        score(s.judgeCorrectness),
        score(s.judgeScope),
        score(s.judgeStyle),
      ]),
    ),
  );
  out.push("");
  out.push(
    "PASS is the deterministic check: it compiles, the fixture's tests and this" +
      " task's hidden tests all pass, and nothing the task forbade was touched." +
      " CORRECT/SCOPE/STYLE are a blind judge's median score out of 5. Wall time" +
      " is the whole carl invocation, so it includes anything the model waited on.",
  );

  const mismatched = trials.filter((trial) => trial.modelMismatch === true);
  if (mismatched.length > 0) {
    out.push("");
    out.push(
      `Excluded ${mismatched.length} trial(s) whose event log named a different` +
        ` model than the one requested — these measured nothing about the model` +
        ` they were filed under:`,
    );
    for (const trial of mismatched) {
      out.push(
        `  ${trial.id}: asked ${trial.model}, log says ${trial.loggedModel}`,
      );
    }
  }

  const unlogged = trials.filter((trial) => trial.runCount === 0);
  if (unlogged.length > 0) {
    out.push("");
    out.push(
      `${unlogged.length} trial(s) produced no event-log run, so their cost,` +
        ` turns, and tool counts are unknown. Pass/fail and wall time still hold.`,
    );
  }

  out.push("");
  out.push("── Trials ──");
  out.push(
    renderTable(
      [
        { header: "TASK", align: "left" },
        { header: "MODEL", align: "left" },
        { header: "REP" },
        { header: "CHECK", align: "left" },
        { header: "WALL" },
        { header: "TURNS" },
        { header: "COST" },
        // How big the patch was. A trial that touched 82 files is a finding
        // whether or not the check passed, and reading it off a judge score is
        // reading it too late.
        { header: "FILES" },
        { header: "PATCH" },
        { header: "C/S/S", align: "left" },
      ],
      trials.map((trial) => [
        trial.task,
        trial.model,
        String(trial.rep),
        trial.modelMismatch
          ? "misrouted"
          : trial.timedOut
            ? "timeout"
            : trial.pass
              ? "pass"
              : "fail",
        formatDuration(trial.wallMs),
        trial.turns != null ? String(trial.turns) : NO_DATA,
        trial.costUsd != null ? formatUsd(trial.costUsd) : "free",
        String(trial.filesChanged),
        formatBytes(trial.diffBytes),
        trial.judge
          ? `${trial.judge.correctness}/${trial.judge.scope}/${trial.judge.style}`
          : NO_DATA,
      ]),
    ),
  );

  return out.join("\n");
}

/**
 * What the judge is asked, with the diff inlined so the judge needs no workspace.
 *
 * Deliberately says nothing about which model wrote the diff, and nothing about
 * whether the checks passed. A judge told the tests failed will find a reason,
 * and the point of scoring separately is to get an opinion the checks did not
 * already supply.
 */
export function judgePrompt(taskText: string, diff: string): string {
  return [
    "You are reviewing one patch against the request it was written for.",
    "",
    "Score it on three axes, each an integer from 1 to 5:",
    "",
    '  "correctness" — does it do what was asked, including the edge cases?',
    '  "scope" — does it change what was asked and no more? Unrequested',
    "    refactors, stray reformatting, and dead code all cost points here.",
    '  "style" — does it read like the surrounding code? Naming, comment',
    "    density, and idiom.",
    "",
    "5 is work you would merge without comment. 3 is work you would merge after",
    "changes. 1 is work you would reject. Judge only what the patch shows you.",
    "",
    'Answer with one JSON object and nothing else: {"correctness": n, "scope": n,',
    '"style": n, "note": "<one sentence>"}',
    "",
    "── THE REQUEST ──",
    "",
    taskText.trim(),
    "",
    "── THE PATCH ──",
    "",
    "```diff",
    diff.trim(),
    "```",
  ].join("\n");
}

/**
 * How much of a diff the judge is shown.
 *
 * A runaway patch is a finding, not a reason to send a megabyte to a judge that
 * will score the first screen of it anyway. The truncation is announced in the
 * prompt so a low `scope` score on a truncated diff is the judge's opinion of a
 * diff it was told was long, not of a diff it thinks ends there.
 */
export const MAX_JUDGED_DIFF_CHARS = 60_000;

export function clampDiff(diff: string, limit = MAX_JUDGED_DIFF_CHARS): string {
  if (diff.length <= limit) return diff;
  return (
    `${diff.slice(0, limit)}\n` +
    `... truncated: the patch is ${diff.length} characters, ` +
    `${diff.length - limit} of which are not shown.`
  );
}
