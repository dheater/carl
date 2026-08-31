#!/usr/bin/env node
/**
 * `just bench` — a model comparison for `carl code`.
 *
 * Each trial gives one model one task in its own committed copy of
 * bench/fixtures/todo-api, then asks two questions about the result: did the
 * task's check.sh pass, and what does a blind judge think of the diff. Speed and
 * cost come from carl's own event log, joined back to the trial afterwards.
 *
 * Three things here exist to keep the numbers honest rather than to make them:
 *
 *   The whole run gets its own CARL_CONFIG_DIR, so a benchmark never lands in the
 *   event log that `carl stats` and docs/one-shot.md are computed from. A
 *   hundred fixture runs would swamp a log of real work.
 *
 *   Trials are grouped by model, not interleaved. Starting a local model loads
 *   ~20GB, and carl stops an idle server serving a different pack to start the
 *   one asked for — interleaving would pay that load on nearly every trial.
 *
 *   Every trial's logged route is compared against the model it was filed under.
 *   `--model qwen38-27b` resolves against the local server first and falls back
 *   to Bedrock, so a benchmark run with mtplx down would otherwise measure Sonnet
 *   three times and print it as three models. Mismatches are excluded from the
 *   table, named, and make the command exit non-zero.
 *
 * The arithmetic lives in src/bench-report.ts, under test. This file is the
 * orchestration: copying directories, spawning carl, and killing it when it runs
 * long.
 */

import { spawn, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  clampDiff,
  combineJudgeSamples,
  judgePrompt,
  joinTrialRuns,
  parseBenchArgs,
  parseJudgeVerdict,
  renderBenchReport,
  summarizeBench,
  type BenchArgs,
  type BenchRunRow,
  type TrialRecord,
} from "./bench-report";
import { openMetricsDb, ingestLiveLog, getMetricsDbPath } from "./metrics-db";
import { formatDuration, formatUsd } from "./stats-format";

const REPO_ROOT = path.join(__dirname, "..");
const BENCH_DIR = path.join(REPO_ROOT, "bench");
const TASKS_DIR = path.join(BENCH_DIR, "tasks");
const FIXTURE_DIR = path.join(BENCH_DIR, "fixtures", "todo-api");
const CARL_BIN = path.join(REPO_ROOT, "dist", "carl.mjs");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");

/** A task directory is one that has both halves of a task. */
function discoverTasks(): string[] {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        fs.existsSync(path.join(TASKS_DIR, name, "prompt.md")) &&
        fs.existsSync(path.join(TASKS_DIR, name, "check.sh")),
    )
    .sort();
}

type Ran = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
};

/**
 * Runs a command to completion or to the timeout, whichever comes first.
 *
 * Detached so the kill can take the whole process group: carl spawns a runtime
 * subprocess, and killing only carl would leave that runtime holding the local
 * model — which the next trial then waits on forever.
 */
function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<Ran> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // Already gone between the timer firing and the signal.
          }
        }, options.timeoutMs)
      : null;

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        wallMs: Date.now() - startedAt,
      });
    });
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      // The trial repos are scratch; they must not inherit a signing key, a
      // template directory, or hooks from the machine's git config.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "carl bench",
      GIT_AUTHOR_EMAIL: "bench@localhost",
      GIT_COMMITTER_NAME: "carl bench",
      GIT_COMMITTER_EMAIL: "bench@localhost",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * A copy of the fixture, with `@types/node` reachable from it.
 *
 * The fixture has no dependencies and installs nothing, but its tests import
 * `node:test`, so without the node typings `tsc` rejects even the pristine
 * fixture and every check fails for a reason that has nothing to do with the
 * model.
 *
 * The link goes in the copy's *parent* directory, not inside it. tsc collects
 * `node_modules/@types` from every ancestor, so a link one level up is found just
 * the same — and it survives the model running `npm install`, which prunes a
 * symlinked package it finds extraneous. A trial destroying its own type
 * definitions failed the first smoke run for a reason that looked exactly like a
 * model that could not write TypeScript.
 *
 * Only `@types/node` is linked, not all of carl's `node_modules`: `@types/jest`
 * beside it would put `describe` and `it` in the fixture's globals, and a diff
 * that used them would compile here and nowhere else.
 */
function copyFixture(dest: string): void {
  const types = path.join(path.dirname(dest), "node_modules", "@types");
  fs.mkdirSync(types, { recursive: true });
  if (!fs.existsSync(path.join(types, "node"))) {
    fs.symlinkSync(
      path.join(REPO_ROOT, "node_modules", "@types", "node"),
      path.join(types, "node"),
      "dir",
    );
  }
  fs.cpSync(FIXTURE_DIR, dest, { recursive: true });
}

/**
 * Directories a tool drops in the workspace, which are not part of any answer.
 *
 * carl sandboxes a run to its workspace, so a model that decides to run npm
 * redirects npm's cache into the repo rather than into `~/.npm`. One trial did
 * exactly that and produced a 56MB, 82-file diff of `.npm-cache` blobs. These go
 * in the repo's private exclude list rather than its `.gitignore`, so the fixture
 * stays a plain TypeScript project with nothing in it that hints at what is about
 * to edit it.
 *
 * The list cannot be complete — the next tool will pick a different name — which
 * is why `captureDiff` also puts the source first rather than relying on it.
 */
const TOOL_DETRITUS = [
  ".agent/",
  ".carl/",
  ".npm-cache/",
  ".npm/",
  ".cache/",
  ".tsbuild/",
  ".tmp/",
];

/**
 * A fresh copy of the fixture at `dest`, with the starting state as a commit.
 *
 * A real commit rather than a marker file, because two checks need one: the
 * `require_unmodified` guard, and the diff the judge is shown.
 */
function prepareRepo(dest: string, taskDir: string): void {
  copyFixture(dest);

  // A task may ship failing tests that are part of the starting state.
  const setupDir = path.join(taskDir, "setup");
  if (fs.existsSync(setupDir)) {
    for (const file of fs.readdirSync(setupDir)) {
      fs.copyFileSync(path.join(setupDir, file), path.join(dest, "src", file));
    }
  }

  git(dest, "init", "--quiet", "-b", "main");
  fs.writeFileSync(
    path.join(dest, ".git", "info", "exclude"),
    `${TOOL_DETRITUS.join("\n")}\n`,
    "utf-8",
  );
  git(dest, "add", "-A");
  git(dest, "commit", "--quiet", "-m", "fixture: starting state");
}

/**
 * Where an answer to any of these tasks can legitimately live.
 *
 * Used to order the diff, not to filter it: everything outside these paths is
 * still shown, just after them.
 */
const ANSWER_PATHS = ["src", "package.json", "tsconfig.json"];

/**
 * The patch the trial produced, staged so new files are in it, and with the
 * source changes first.
 *
 * The order is the point. The judge is shown a bounded prefix of the diff, and
 * `git diff` orders by path — so a trial that dropped a `.npm-cache/` in the
 * workspace pushed every source change past the limit and was scored 1/1/1 for a
 * refactor it had actually completed correctly. Diffing the answer paths first
 * means the truncation can only ever cut the noise.
 */
function captureDiff(repo: string): {
  diff: string;
  filesChanged: number;
  diffBytes: number;
} {
  git(repo, "add", "-A");
  const answer = git(repo, "diff", "--cached", "HEAD", "--", ...ANSWER_PATHS);
  const rest = git(
    repo,
    "diff",
    "--cached",
    "HEAD",
    "--",
    ".",
    ...ANSWER_PATHS.map((p) => `:!${p}`),
  );
  const names = git(repo, "diff", "--cached", "--name-only", "HEAD")
    .split("\n")
    .filter(Boolean);
  const diff = rest.trim() ? `${answer}${rest}` : answer;
  return {
    diff,
    filesChanged: names.length,
    diffBytes: Buffer.byteLength(diff),
  };
}

/**
 * How many tests the pristine fixture passes.
 *
 * Measured through common.sh's own `run_tests`, so the count the checks compare
 * against and the count measured here can never drift apart.
 */
async function measureBaselineTests(outDir: string): Promise<number> {
  const dir = path.join(outDir, "baseline");
  copyFixture(dir);
  const result = await run("bash", ["-c", '. "$BENCH_COMMON"; run_tests'], {
    cwd: dir,
    env: {
      BENCH_COMMON: path.join(TASKS_DIR, "common.sh"),
      BENCH_TSC: TSC_BIN,
      BENCH_TASK_DIR: TASKS_DIR,
      BENCH_BASELINE_TESTS: "0",
    },
    timeoutMs: 120_000,
  });
  const count = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isInteger(count) || count <= 0) {
    throw new Error(
      `The pristine fixture does not pass its own tests, so no check could` +
        ` be trusted:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return count;
}

/** Real path, so it compares equal to the workspace carl recorded. */
function canonical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

async function runTrial(
  args: BenchArgs,
  model: string,
  task: string,
  rep: number,
  outDir: string,
  baselineTests: number,
): Promise<{ trial: TrialRecord; diff: string }> {
  const id = `${model}/${task}/rep${rep}`;
  const taskDir = path.join(TASKS_DIR, task);
  const trialDir = path.join(outDir, "trials", model, task, `rep${rep}`);
  const repo = path.join(trialDir, "repo");

  fs.mkdirSync(trialDir, { recursive: true });
  prepareRepo(repo, taskDir);

  // Outside the repo, so the prompt is not part of the diff and cannot be
  // mistaken for a file the task asked for.
  const promptFile = path.join(trialDir, "prompt.md");
  fs.copyFileSync(path.join(taskDir, "prompt.md"), promptFile);

  process.stdout.write(`  ${id} … `);
  const startedAtMs = Date.now();
  const carl = await run(
    process.execPath,
    [CARL_BIN, "--model", model, "--effort", args.effort, "code", promptFile],
    { cwd: repo, timeoutMs: args.timeoutMs },
  );
  const endedAtMs = Date.now();
  fs.writeFileSync(
    path.join(trialDir, "carl.log"),
    `${carl.stdout}\n--- stderr ---\n${carl.stderr}\n`,
    "utf-8",
  );

  // Before the check: check.sh copies hidden tests into src/ and builds, and
  // neither belongs in the patch the judge is shown.
  const { diff, filesChanged, diffBytes } = captureDiff(repo);
  fs.writeFileSync(path.join(trialDir, "diff.patch"), diff, "utf-8");

  const check = await run("bash", [path.join(taskDir, "check.sh")], {
    cwd: repo,
    env: {
      BENCH_TSC: TSC_BIN,
      BENCH_TASK_DIR: taskDir,
      BENCH_BASELINE_TESTS: String(baselineTests),
    },
    timeoutMs: 300_000,
  });
  const checkOutput = `${check.stdout}\n${check.stderr}`.trim();
  fs.writeFileSync(path.join(trialDir, "check.log"), checkOutput, "utf-8");

  const pass = check.code === 0 && !carl.timedOut;
  process.stdout.write(
    `${carl.timedOut ? "timeout" : pass ? "pass" : "fail"} ` +
      `(${formatDuration(carl.wallMs)})\n`,
  );

  return {
    trial: {
      id,
      model,
      task,
      rep,
      workspace: canonical(repo),
      startedAtMs,
      endedAtMs,
      wallMs: carl.wallMs,
      carlExit: carl.code,
      timedOut: carl.timedOut,
      pass,
      checkOutput,
      diffBytes,
      filesChanged,
    },
    diff,
  };
}

/**
 * One judge sample, in a workspace of its own.
 *
 * Its own directory because `carl ask` writes its answer to
 * `.agent/notes/ask.md` under the working directory, and concurrent samples
 * sharing a directory would overwrite each other's verdict.
 */
async function judgeOnce(
  args: BenchArgs,
  outDir: string,
  trialId: string,
  sample: number,
  prompt: string,
): Promise<ReturnType<typeof parseJudgeVerdict>> {
  const dir = path.join(
    outDir,
    "judge",
    trialId.replace(/\//g, "__"),
    `s${sample}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, "judge-prompt.md");
  fs.writeFileSync(promptFile, prompt, "utf-8");

  const asked = await run(
    process.execPath,
    [
      CARL_BIN,
      "--model",
      args.judgeModel,
      "--effort",
      "low",
      "ask",
      promptFile,
    ],
    { cwd: dir, timeoutMs: 300_000 },
  );

  const notes = path.join(dir, ".agent", "notes", "ask.md");
  const answer = fs.existsSync(notes)
    ? fs.readFileSync(notes, "utf-8")
    : `${asked.stdout}\n${asked.stderr}`;
  return parseJudgeVerdict(answer);
}

async function judgeTrials(
  args: BenchArgs,
  outDir: string,
  trials: TrialRecord[],
  diffs: Map<string, string>,
): Promise<void> {
  const judgeable = trials.filter(
    (trial) => (diffs.get(trial.id) ?? "").trim().length > 0,
  );
  const skipped = trials.length - judgeable.length;
  console.log(
    `\nJudging ${judgeable.length} diff(s) with ${args.judgeModel}, ` +
      `${args.judgeSamples} sample(s) each` +
      (skipped > 0 ? ` (${skipped} trial(s) changed nothing)` : "") +
      ".",
  );

  for (const trial of judgeable) {
    const taskText = fs.readFileSync(
      path.join(TASKS_DIR, trial.task, "prompt.md"),
      "utf-8",
    );
    const prompt = judgePrompt(taskText, clampDiff(diffs.get(trial.id)!));
    // Samples of one diff in parallel; diffs one at a time. The point of several
    // samples is the judge's own variance, and they do not have to wait on each
    // other to show it.
    const settled = await Promise.all(
      Array.from({ length: args.judgeSamples }, (_, i) =>
        judgeOnce(args, outDir, trial.id, i + 1, prompt).catch(() => null),
      ),
    );
    const parsed = settled.filter(
      (verdict): verdict is NonNullable<typeof verdict> => verdict != null,
    );
    trial.judge = combineJudgeSamples(parsed);
    const shortfall = args.judgeSamples - parsed.length;
    process.stdout.write(
      `  ${trial.id}: ` +
        (trial.judge
          ? `${trial.judge.correctness}/${trial.judge.scope}/${trial.judge.style}` +
            (shortfall > 0 ? ` (${shortfall} sample(s) unparsable)` : "")
          : "no parsable verdict") +
        "\n",
    );
  }
}

/**
 * The runs the log recorded, keyed the way the join needs them.
 *
 * Rebuilt from the bench home's own events.jsonl. The database is a cache of that
 * file, so a benchmark that is re-reported later reads the same rows.
 */
function loadRuns(): BenchRunRow[] {
  const db = openMetricsDb();
  ingestLiveLog(db);
  const rows = db
    .prepare(
      `SELECT run_id, workspace, started_at_ms, model_id, cost_usd, turns,
              tool_call_count, tool_error_count, output_tokens, status
         FROM runs`,
    )
    .all() as unknown as BenchRunRow[];
  db.close();
  return rows.map((row) => ({
    ...row,
    workspace: row.workspace ? canonical(row.workspace) : null,
  }));
}

/** Judge spend, which is a cost of measuring and not a cost of any model. */
function judgeCost(rows: BenchRunRow[], outDir: string): number {
  const judgeRoot = canonical(outDir) + path.sep + "judge" + path.sep;
  return rows
    .filter((row) => row.workspace?.startsWith(judgeRoot))
    .reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
}

function usage(): void {
  console.log(
    `Usage: just bench [options]

  --models <a,b,c>     models to compare (default: sonnet4.6,qwen38-27b,qwen35-9b)
  --tasks <a,b|all>    tasks to run (default: one per difficulty tier)
  --reps <n>           repetitions per model/task cell (default: 1)
  --effort <level>     low | medium | high (default: medium)
  --timeout <seconds>  per-trial wall clock (default: 900)
  --no-judge           skip the blind judge; deterministic checks only
  --judge-model <m>    model to judge with (default: sonnet4.6)
  --judge-samples <n>  verdicts per diff, median taken (default: 3)
  --out <dir>          where to write trials and the report

Tasks available: ${discoverTasks().join(", ") || "(none)"}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const allTasks = discoverTasks();
  if (allTasks.length === 0) {
    throw new Error(`No tasks found under ${TASKS_DIR}`);
  }
  const args = parseBenchArgs(argv, allTasks);

  for (const [label, file] of [
    ["carl", CARL_BIN],
    ["tsc", TSC_BIN],
  ] as const) {
    if (!fs.existsSync(file)) {
      throw new Error(`${label} not found at ${file} — run \`npm run build\`?`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(
    args.outDir ?? path.join(BENCH_DIR, "results", stamp),
  );
  fs.mkdirSync(outDir, { recursive: true });

  // The isolation that keeps a benchmark out of the production log. Set before
  // anything reads a config or writes an event, and inherited by every child.
  const benchHome = path.join(outDir, "carl-home");
  fs.mkdirSync(benchHome, { recursive: true });
  process.env.CARL_CONFIG_DIR = benchHome;
  // An empty config on purpose: with no `validate` key carl runs no validation
  // and therefore no repair attempts, so one trial is one logged run. Every trial
  // passes --model and --effort, so there is nothing else to configure.
  fs.writeFileSync(path.join(benchHome, "config.json"), "{}\n", "utf-8");

  console.log(
    `carl bench — ${args.models.length} model(s) × ${args.tasks.length} task(s) × ${args.reps} rep(s)`,
  );
  console.log(`  models: ${args.models.join(", ")}`);
  console.log(`  tasks:  ${args.tasks.join(", ")}`);
  console.log(`  out:    ${outDir}`);
  console.log(`  home:   ${benchHome} (the production event log is untouched)`);

  const baselineTests = await measureBaselineTests(outDir);
  console.log(`  the pristine fixture passes ${baselineTests} tests\n`);

  const trials: TrialRecord[] = [];
  const diffs = new Map<string, string>();
  // Model outer, so a local model is loaded once per arm rather than once per
  // trial.
  for (const model of args.models) {
    console.log(`── ${model} ──`);
    for (const task of args.tasks) {
      for (let rep = 1; rep <= args.reps; rep++) {
        const { trial, diff } = await runTrial(
          args,
          model,
          task,
          rep,
          outDir,
          baselineTests,
        );
        trials.push(trial);
        diffs.set(trial.id, diff);
      }
    }
  }

  if (args.judge) await judgeTrials(args, outDir, trials, diffs);

  const rows = loadRuns();
  const joined = joinTrialRuns(trials, rows);
  const report = renderBenchReport(summarizeBench(joined), joined);

  const spentOnJudging = judgeCost(rows, outDir);
  const footer =
    (args.judge
      ? `\nJudging cost ${formatUsd(spentOnJudging)}, which is the price of the` +
        ` measurement and is in no model's row above.`
      : `\nThe judge was off, so the three score columns are empty and no model` +
        ` was rated on anything the checks could not decide.`) +
    `\nTrial workspaces, diffs, and logs: ${outDir}` +
    `\nMetrics database: ${getMetricsDbPath()}`;

  console.log(`\n${report}${footer}`);
  fs.writeFileSync(
    path.join(outDir, "report.txt"),
    `${report}${footer}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(outDir, "trials.json"),
    `${JSON.stringify({ args, baselineTests, judgeCostUsd: spentOnJudging, trials: joined }, null, 2)}\n`,
    "utf-8",
  );

  const mismatched = joined.filter((trial) => trial.modelMismatch);
  if (mismatched.length > 0) {
    console.error(
      `\n${mismatched.length} trial(s) ran on a model other than the one asked` +
        ` for. Those cells measured nothing; fix the routing and rerun them.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
