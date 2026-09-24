import {
  clampDiff,
  combineJudgeSamples,
  joinTrialRuns,
  judgePrompt,
  median,
  parseBenchArgs,
  parseJudgeVerdict,
  renderBenchReport,
  summarizeBench,
  DEFAULT_MODELS,
  MAX_JUDGED_DIFF_CHARS,
  SMOKE_TASKS,
  type BenchRunRow,
  type TrialRecord,
} from "./bench-report";

const ALL_TASKS = [
  "01-easy-count-by-status",
  "02-easy-list-numbering",
  "03-med-complete-unknown",
  "04-med-parse-due-date",
  "05-hard-status-refactor",
  "06-hard-sort-ties",
];

function trial(over: Partial<TrialRecord> = {}): TrialRecord {
  return {
    id: "sonnet4.6/01-easy-count-by-status/rep1",
    model: "sonnet4.6",
    task: "01-easy-count-by-status",
    rep: 1,
    workspace: "/tmp/bench/trials/sonnet/01/rep1/repo",
    startedAtMs: 1_000_000,
    endedAtMs: 1_060_000,
    wallMs: 60_000,
    carlExit: 0,
    timedOut: false,
    pass: true,
    checkOutput: "",
    diffBytes: 400,
    filesChanged: 1,
    ...over,
  };
}

function row(over: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    run_id: "r1",
    workspace: "/tmp/bench/trials/sonnet/01/rep1/repo",
    started_at_ms: 1_000_500,
    model_id: "us.anthropic.claude-sonnet-4-6-20260514-v1:0",
    cost_usd: 0.12,
    turns: 7,
    tool_call_count: 20,
    tool_error_count: 2,
    output_tokens: 3000,
    status: "success",
    ...over,
  };
}

describe("parseBenchArgs", () => {
  it("defaults to the smoke matrix", () => {
    const args = parseBenchArgs([], ALL_TASKS);
    expect(args.models).toEqual(DEFAULT_MODELS);
    expect(args.tasks).toEqual(SMOKE_TASKS);
    expect(args.reps).toBe(1);
    expect(args.judge).toBe(true);
    expect(args.judgeSamples).toBe(3);
  });

  it("parses a full invocation", () => {
    const args = parseBenchArgs(
      [
        "--models",
        "sonnet4.6, qwen35-9b",
        "--tasks",
        "02-easy-list-numbering",
        "--reps",
        "3",
        "--effort",
        "high",
        "--timeout",
        "120",
        "--judge-model",
        "opus5.5",
        "--judge-samples",
        "5",
        "--out",
        "/tmp/out",
      ],
      ALL_TASKS,
    );
    expect(args.models).toEqual(["sonnet4.6", "qwen35-9b"]);
    expect(args.tasks).toEqual(["02-easy-list-numbering"]);
    expect(args.reps).toBe(3);
    expect(args.effort).toBe("high");
    expect(args.timeoutMs).toBe(120_000);
    expect(args.judgeModel).toBe("opus5.5");
    expect(args.judgeSamples).toBe(5);
    expect(args.outDir).toBe("/tmp/out");
  });

  it("expands --tasks all in the order the caller discovered them", () => {
    expect(parseBenchArgs(["--tasks", "all"], ALL_TASKS).tasks).toEqual(
      ALL_TASKS,
    );
  });

  it("turns the judge off", () => {
    expect(parseBenchArgs(["--no-judge"], ALL_TASKS).judge).toBe(false);
  });

  // A typo in a task name would otherwise silently shrink the matrix, and a
  // benchmark that ran two of the three tasks asked for looks exactly like one
  // that ran three.
  it("refuses a task name it does not have", () => {
    expect(() => parseBenchArgs(["--tasks", "07-nope"], ALL_TASKS)).toThrow(
      /Unknown task/,
    );
  });

  it("refuses nonsense counts and unknown flags", () => {
    expect(() => parseBenchArgs(["--reps", "0"], ALL_TASKS)).toThrow(/--reps/);
    expect(() => parseBenchArgs(["--reps", "1.5"], ALL_TASKS)).toThrow(
      /--reps/,
    );
    expect(() => parseBenchArgs(["--timeout", "0"], ALL_TASKS)).toThrow(
      /--timeout/,
    );
    expect(() => parseBenchArgs(["--judge-samples", "0"], ALL_TASKS)).toThrow(
      /--judge-samples/,
    );
    expect(() => parseBenchArgs(["--models", " , "], ALL_TASKS)).toThrow(
      /selected nothing/,
    );
    expect(() => parseBenchArgs(["--wat"], ALL_TASKS)).toThrow(
      /Unknown option/,
    );
    expect(() => parseBenchArgs(["--models"], ALL_TASKS)).toThrow(
      /needs a value/,
    );
  });
});

describe("joinTrialRuns", () => {
  it("attaches the run in the same workspace and window", () => {
    const [joined] = joinTrialRuns([trial()], [row()]);
    expect(joined.runCount).toBe(1);
    expect(joined.costUsd).toBeCloseTo(0.12);
    expect(joined.turns).toBe(7);
    expect(joined.toolCalls).toBe(20);
    expect(joined.toolErrors).toBe(2);
    expect(joined.runStatus).toBe("success");
    expect(joined.modelMismatch).toBe(false);
  });

  it("ignores a run in another workspace", () => {
    const [joined] = joinTrialRuns(
      [trial()],
      [row({ workspace: "/tmp/bench/trials/sonnet/01/rep2/repo" })],
    );
    expect(joined.runCount).toBe(0);
    expect(joined.costUsd).toBeUndefined();
  });

  it("ignores a run outside the trial's window", () => {
    const [joined] = joinTrialRuns(
      [trial()],
      [row({ started_at_ms: 2_000_000 })],
    );
    expect(joined.runCount).toBe(0);
  });

  it("sums the runs of a trial that somehow retried", () => {
    const [joined] = joinTrialRuns(
      [trial()],
      [
        row({ run_id: "r1", cost_usd: 0.1, turns: 4, status: "error" }),
        row({
          run_id: "r2",
          started_at_ms: 1_030_000,
          cost_usd: 0.2,
          turns: 6,
          status: "success",
        }),
      ],
    );
    expect(joined.runCount).toBe(2);
    expect(joined.costUsd).toBeCloseTo(0.3);
    expect(joined.turns).toBe(10);
    // The last run's status, because that is the one the trial ended on.
    expect(joined.runStatus).toBe("success");
  });

  // The guard that gives the whole benchmark its meaning: `--model qwen38-27b`
  // falls back to Bedrock when the local server is down.
  it("flags a trial the log says ran on another route", () => {
    const [joined] = joinTrialRuns([trial({ model: "qwen38-27b" })], [row()]);
    expect(joined.modelMismatch).toBe(true);
    expect(joined.loggedModel).toBe(
      "us.anthropic.claude-sonnet-4-6-20260514-v1:0",
    );
  });

  it("accepts the local server's spelling of a configured name", () => {
    const [joined] = joinTrialRuns(
      [trial({ model: "qwen38-27b" })],
      [row({ model_id: "mtplx-qwen38-27b-optimized-speed" })],
    );
    expect(joined.modelMismatch).toBe(false);
  });

  it("does not confuse the two local models with each other", () => {
    const [joined] = joinTrialRuns(
      [trial({ model: "qwen35-9b" })],
      [row({ model_id: "mtplx-qwen38-27b-optimized-speed" })],
    );
    expect(joined.modelMismatch).toBe(true);
  });

  it("treats an unrecorded route as a mismatch rather than a match", () => {
    const [joined] = joinTrialRuns([trial()], [row({ model_id: null })]);
    expect(joined.modelMismatch).toBe(true);
    expect(joined.loggedModel).toBe("(unrecorded)");
  });

  it("reports a missing cost as unknown rather than as zero", () => {
    const [joined] = joinTrialRuns([trial()], [row({ cost_usd: null })]);
    expect(joined.runCount).toBe(1);
    expect(joined.costUsd).toBeNull();
  });
});

describe("median", () => {
  it("takes the middle of an odd sample and the mean of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("parseJudgeVerdict", () => {
  it("reads a bare object", () => {
    expect(
      parseJudgeVerdict(
        '{"correctness": 5, "scope": 4, "style": 3, "note": "ok"}',
      ),
    ).toEqual({ correctness: 5, scope: 4, style: 3, note: "ok" });
  });

  it("reads one wrapped in prose and a fence", () => {
    const text = [
      "Here is my assessment.",
      "```json",
      '{"correctness": 4, "scope": 5, "style": 4, "note": "clean"}',
      "```",
      "Let me know if you want more detail.",
    ].join("\n");
    expect(parseJudgeVerdict(text)).toEqual({
      correctness: 4,
      scope: 5,
      style: 4,
      note: "clean",
    });
  });

  it("prefers the outer object when the verdict nests one", () => {
    const text =
      '{"correctness": 2, "scope": 2, "style": 2, "note": "n", "detail": {"a": 1}}';
    expect(parseJudgeVerdict(text)?.correctness).toBe(2);
  });

  it("tolerates a missing note", () => {
    expect(
      parseJudgeVerdict('{"correctness": 1, "scope": 1, "style": 1}'),
    ).toEqual({
      correctness: 1,
      scope: 1,
      style: 1,
      note: "",
    });
  });

  // A half-parsed verdict would enter the median as a real opinion.
  it("refuses a verdict missing an axis, out of range, or not a number", () => {
    expect(parseJudgeVerdict('{"correctness": 3, "scope": 3}')).toBeNull();
    expect(
      parseJudgeVerdict('{"correctness": 9, "scope": 3, "style": 3}'),
    ).toBeNull();
    expect(
      parseJudgeVerdict('{"correctness": 0, "scope": 3, "style": 3}'),
    ).toBeNull();
    expect(
      parseJudgeVerdict('{"correctness": "5", "scope": 3, "style": 3}'),
    ).toBeNull();
    expect(parseJudgeVerdict("I would rate this a 4 out of 5.")).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
  });
});

describe("combineJudgeSamples", () => {
  it("takes the median of each axis independently", () => {
    const score = combineJudgeSamples([
      { correctness: 5, scope: 3, style: 4, note: "first" },
      { correctness: 4, scope: 5, style: 4, note: "second" },
      { correctness: 4, scope: 4, style: 2, note: "third" },
    ]);
    expect(score).toEqual({
      correctness: 4,
      scope: 4,
      style: 4,
      samples: 3,
      note: "first",
    });
  });

  it("is null when nothing parsed", () => {
    expect(combineJudgeSamples([])).toBeNull();
  });
});

describe("summarizeBench", () => {
  const trials = [
    trial({ id: "a", model: "sonnet4.6", pass: true, wallMs: 40_000 }),
    trial({ id: "b", model: "sonnet4.6", pass: false, wallMs: 60_000 }),
    trial({
      id: "c",
      model: "qwen35-9b",
      workspace: "/tmp/bench/trials/qwen/01/rep1/repo",
      pass: false,
      wallMs: 200_000,
    }),
  ].map(
    (t) =>
      joinTrialRuns(
        [t],
        [row({ workspace: t.workspace, model_id: t.model })],
      )[0],
  );

  it("keeps each model's rates to that model's trials", () => {
    const [sonnet, qwen] = summarizeBench(trials);
    expect(sonnet.model).toBe("sonnet4.6");
    expect(sonnet.scored).toBe(2);
    expect(sonnet.passes).toBe(1);
    expect(sonnet.passRate).toBe(0.5);
    expect(sonnet.meanWallMs).toBe(50_000);
    expect(qwen.model).toBe("qwen35-9b");
    expect(qwen.passRate).toBe(0);
  });

  it("charges cost against passes, not against trials", () => {
    const [sonnet] = summarizeBench(trials);
    expect(sonnet.totalCostUsd).toBeCloseTo(0.24);
    expect(sonnet.meanCostUsd).toBeCloseTo(0.12);
    // Two trials at $0.12, one of which passed.
    expect(sonnet.costPerPassUsd).toBeCloseTo(0.24);
  });

  it("leaves cost per pass unknown when nothing passed", () => {
    const [qwen] = summarizeBench([trials[2]]);
    expect(qwen.costPerPassUsd).toBeNull();
  });

  // A misrouted trial must not lend its result to the model it was filed under,
  // in either direction.
  it("excludes mismatched trials from every rate and counts them", () => {
    const misrouted = joinTrialRuns(
      [trial({ id: "d", model: "qwen38-27b", pass: true })],
      [row()],
    );
    const [summary] = summarizeBench(misrouted);
    expect(summary.trials).toBe(1);
    expect(summary.mismatches).toBe(1);
    expect(summary.scored).toBe(0);
    expect(summary.passes).toBe(0);
    expect(summary.passRate).toBeNull();
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.meanWallMs).toBeNull();
  });

  it("takes the tool error rate over calls, not over trials", () => {
    const [sonnet] = summarizeBench(trials);
    expect(sonnet.toolErrorRate).toBeCloseTo(4 / 40);
  });

  it("reports an unmeasured model without inventing zeroes", () => {
    const [summary] = summarizeBench([
      trial({ model: "qwen35-9b", pass: false }),
    ]);
    expect(summary.meanTurns).toBeNull();
    expect(summary.toolErrorRate).toBeNull();
    expect(summary.judgeCorrectness).toBeNull();
  });
});

describe("renderBenchReport", () => {
  it("prices a local model as free rather than as zero", () => {
    const local = joinTrialRuns(
      [trial({ model: "qwen35-9b", workspace: "/tmp/w" })],
      [
        row({
          workspace: "/tmp/w",
          model_id: "mtplx-qwen35-9b-optimized-speed",
          cost_usd: null,
        }),
      ],
    );
    const out = renderBenchReport(summarizeBench(local), local);
    expect(out).toContain("free");
    expect(out).not.toContain("$0.00");
  });

  it("names every excluded trial so a misroute cannot pass unnoticed", () => {
    const misrouted = joinTrialRuns(
      [trial({ id: "qwen38-27b/05/rep1", model: "qwen38-27b" })],
      [row()],
    );
    const out = renderBenchReport(summarizeBench(misrouted), misrouted);
    expect(out).toContain("qwen38-27b/05/rep1");
    expect(out).toContain("asked qwen38-27b");
    expect(out).toContain("misrouted");
  });

  it("says so when a trial produced no logged run", () => {
    const orphan = joinTrialRuns([trial()], []);
    expect(renderBenchReport(summarizeBench(orphan), orphan)).toContain(
      "no event-log run",
    );
  });

  // The one trial that made this necessary passed every check while producing a
  // 56MB, 82-file patch, and the only sign of it in the report was a judge score.
  it("shows how large each patch was", () => {
    const big = joinTrialRuns(
      [trial({ filesChanged: 82, diffBytes: 55_895_689 })],
      [row()],
    );
    const out = renderBenchReport(summarizeBench(big), big);
    expect(out).toContain("FILES");
    expect(out).toContain("PATCH");
    expect(out).toContain("82");
    expect(out).toContain("53.3M");
  });

  it("marks a timeout distinctly from a failed check", () => {
    const timed = joinTrialRuns(
      [trial({ timedOut: true, pass: false })],
      [row()],
    );
    expect(renderBenchReport(summarizeBench(timed), timed)).toContain(
      "timeout",
    );
  });
});

describe("judgePrompt", () => {
  it("asks for the three axes and shows the request and the patch", () => {
    const prompt = judgePrompt("Add countByStatus.", "--- a/src/filter.ts");
    expect(prompt).toContain("correctness");
    expect(prompt).toContain("scope");
    expect(prompt).toContain("style");
    expect(prompt).toContain("Add countByStatus.");
    expect(prompt).toContain("--- a/src/filter.ts");
  });

  // The judge scoring blind is the whole reason its opinion is worth anything.
  it("names no model and reveals no check result", () => {
    const prompt = judgePrompt("Add countByStatus.", "diff").toLowerCase();
    for (const leak of ["sonnet", "qwen", "claude", "bedrock", "mtplx"]) {
      expect(prompt).not.toContain(leak);
    }
  });
});

describe("clampDiff", () => {
  it("leaves a normal diff alone", () => {
    expect(clampDiff("short")).toBe("short");
  });

  it("truncates a runaway diff and says how much it cut", () => {
    const clamped = clampDiff("x".repeat(MAX_JUDGED_DIFF_CHARS + 500));
    expect(clamped).toContain("truncated");
    expect(clamped).toContain(String(MAX_JUDGED_DIFF_CHARS + 500));
    expect(clamped).toContain("500 of which are not shown");
  });
});
