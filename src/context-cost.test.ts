import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";

import {
  groupEpisodes,
  coldStartTax,
  countEpisodeReReads,
  summarizeContextCost,
  queryContextCost,
  renderContextCost,
  EPISODE_GAP_MS,
  type ContextRun,
} from "./context-cost";
import { openMetricsDb, ingestFile } from "./metrics-db";
import { resolveRange } from "./stats";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-08-20T10:00:00.000Z");

function run(overrides: Partial<ContextRun> = {}): ContextRun {
  return {
    run_id: "run-1",
    workspace: "/ws/proj",
    started_at_ms: T0,
    model_id: "us.anthropic.claude-sonnet-4-6",
    cost_usd: 1,
    persona_chars: 12_000,
    instruction_chars: 3_000,
    first_turn_input_tokens: 0,
    first_turn_cache_read_tokens: 0,
    first_turn_cache_write_tokens: 40_000,
    peak_prompt_tokens: 60_000,
    compactions: 0,
    ...overrides,
  };
}

describe("groupEpisodes", () => {
  test("keeps runs minutes apart in one sitting", () => {
    const episodes = groupEpisodes([
      run({ run_id: "a", started_at_ms: T0 }),
      run({ run_id: "b", started_at_ms: T0 + 5 * 60_000 }),
    ]);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].map((r) => r.run_id)).toEqual(["a", "b"]);
  });

  test("splits on an idle gap longer than the threshold", () => {
    const episodes = groupEpisodes([
      run({ run_id: "a", started_at_ms: T0 }),
      run({ run_id: "b", started_at_ms: T0 + EPISODE_GAP_MS + 1 }),
    ]);

    expect(episodes.map((e) => e.length)).toEqual([1, 1]);
  });

  test("a gap exactly at the threshold is still one sitting", () => {
    const episodes = groupEpisodes([
      run({ run_id: "a", started_at_ms: T0 }),
      run({ run_id: "b", started_at_ms: T0 + EPISODE_GAP_MS }),
    ]);

    expect(episodes).toHaveLength(1);
  });

  test("never joins runs from different workspaces", () => {
    // A run in another repository inherits nothing, however close in time.
    const episodes = groupEpisodes([
      run({ run_id: "a", workspace: "/ws/one", started_at_ms: T0 }),
      run({ run_id: "b", workspace: "/ws/two", started_at_ms: T0 + 60_000 }),
    ]);

    expect(episodes).toHaveLength(2);
  });

  test("orders a sitting by time regardless of row order", () => {
    const episodes = groupEpisodes([
      run({ run_id: "late", started_at_ms: T0 + 60_000 }),
      run({ run_id: "early", started_at_ms: T0 }),
    ]);

    expect(episodes[0].map((r) => r.run_id)).toEqual(["early", "late"]);
  });

  test("drops a run that cannot be placed in time", () => {
    expect(groupEpisodes([run({ started_at_ms: null })])).toEqual([]);
  });
});

describe("coldStartTax", () => {
  test("charges only the difference between write and read rates", () => {
    // Sonnet: cache write $3.75/M, cache read $0.30/M. 40k written tokens a live
    // session would have read: 40_000 * (3.75 - 0.30) / 1e6.
    expect(coldStartTax(run())).toBeCloseTo(0.138, 6);
  });

  test("charges fresh input at the input rate", () => {
    // 1M fresh input at $3.00 against $0.30 read.
    const tax = coldStartTax(
      run({
        first_turn_input_tokens: 1_000_000,
        first_turn_cache_write_tokens: 0,
      }),
    );
    expect(tax).toBeCloseTo(2.7, 6);
  });

  test("is zero for a first turn that was already all cache reads", () => {
    // Nothing to re-establish: the prefix was still warm from a previous run.
    expect(
      coldStartTax(
        run({
          first_turn_cache_write_tokens: 0,
          first_turn_cache_read_tokens: 40_000,
        }),
      ),
    ).toBeCloseTo(0, 9);
  });

  test("is null, not zero, when the run recorded no first turn", () => {
    expect(
      coldStartTax(
        run({
          first_turn_input_tokens: null,
          first_turn_cache_read_tokens: null,
          first_turn_cache_write_tokens: null,
        }),
      ),
    ).toBeNull();
  });

  test("is null for a model with no known rates", () => {
    expect(coldStartTax(run({ model_id: null }))).toBeNull();
  });
});

describe("countEpisodeReReads", () => {
  test("counts a file the previous run of the sitting had read", () => {
    const episodes = [[run({ run_id: "a" }), run({ run_id: "b" })]];
    const paths = new Map([
      ["a", ["src/x.ts", "src/y.ts"]],
      ["b", ["src/y.ts"]],
    ]);

    expect(countEpisodeReReads(episodes, paths)).toEqual({
      reReads: 1,
      attributed: 3,
    });
  });

  test("counts a within-run repeat once, leaving it to the read ledger", () => {
    const episodes = [[run({ run_id: "a" })]];
    const paths = new Map([["a", ["src/x.ts", "src/x.ts", "src/x.ts"]]]);

    expect(countEpisodeReReads(episodes, paths)).toEqual({
      reReads: 0,
      attributed: 1,
    });
  });

  test("looks back across the whole sitting, not just the run before", () => {
    const episodes = [
      [run({ run_id: "a" }), run({ run_id: "b" }), run({ run_id: "c" })],
    ];
    const paths = new Map([
      ["a", ["src/x.ts"]],
      ["b", ["src/other.ts"]],
      ["c", ["src/x.ts"]],
    ]);

    expect(countEpisodeReReads(episodes, paths).reReads).toBe(1);
  });

  test("does not carry paths across sittings", () => {
    const episodes = [[run({ run_id: "a" })], [run({ run_id: "b" })]];
    const paths = new Map([
      ["a", ["src/x.ts"]],
      ["b", ["src/x.ts"]],
    ]);

    expect(countEpisodeReReads(episodes, paths).reReads).toBe(0);
  });
});

describe("summarizeContextCost", () => {
  test("taxes the repeat runs of a sitting, not the one that started it", () => {
    const report = summarizeContextCost(
      [
        run({ run_id: "a", started_at_ms: T0 }),
        run({ run_id: "b", started_at_ms: T0 + 60_000 }),
        run({ run_id: "c", started_at_ms: T0 + 120_000 }),
      ],
      new Map(),
    );

    expect(report.episodes).toBe(1);
    expect(report.repeatRuns).toBe(2);
    expect(report.pricedRepeatRuns).toBe(2);
    expect(report.coldStartUsd).toBeCloseTo(2 * 0.138, 6);
    // Three runs at $1 each.
    expect(report.coldStartShare).toBeCloseTo(0.276 / 3, 6);
  });

  test("charges nothing when every run stood alone", () => {
    const report = summarizeContextCost(
      [
        run({ run_id: "a", started_at_ms: T0 }),
        run({ run_id: "b", started_at_ms: T0 + 2 * HOUR }),
      ],
      new Map(),
    );

    expect(report.repeatRuns).toBe(0);
    expect(report.coldStartUsd).toBeNull();
  });

  test("reports the peak-context distribution and the compactions", () => {
    const report = summarizeContextCost(
      [
        run({ run_id: "a", peak_prompt_tokens: 10_000, compactions: 0 }),
        run({
          run_id: "b",
          started_at_ms: T0 + 2 * HOUR,
          peak_prompt_tokens: 200_000,
          compactions: 2,
        }),
      ],
      new Map(),
    );

    expect(report.maxPeakPromptTokens).toBe(200_000);
    expect(report.compactions).toBe(2);
    expect(report.compactedRuns).toBe(1);
  });

  test("reports how much of turn 1 the provider still had cached", () => {
    // Observed live: run 2's first turn read 5,779 tokens it never rewrote,
    // because the provider's cache outlived carl's subprocess.
    const report = summarizeContextCost(
      [
        run({ run_id: "a", started_at_ms: T0 }),
        run({
          run_id: "b",
          started_at_ms: T0 + 60_000,
          first_turn_cache_read_tokens: 7_500,
          first_turn_cache_write_tokens: 2_500,
        }),
      ],
      new Map(),
    );

    expect(report.firstTurnCachedShare).toBeCloseTo(0.75, 6);
  });

  test("judges the cache only on runs that could have found it warm", () => {
    // The first run of a sitting has nothing to have found warm; counting its
    // cold first turn would report a cold cache that never had a chance.
    const report = summarizeContextCost(
      [run({ run_id: "a", first_turn_cache_write_tokens: 100_000 })],
      new Map(),
    );

    expect(report.firstTurnCachedShare).toBeNull();
  });

  test("counts runs with no per-turn detail as unmeasured", () => {
    const report = summarizeContextCost(
      [
        run({ run_id: "a" }),
        run({
          run_id: "b",
          started_at_ms: T0 + 2 * HOUR,
          first_turn_input_tokens: null,
          first_turn_cache_read_tokens: null,
          first_turn_cache_write_tokens: null,
        }),
      ],
      new Map(),
    );

    expect(report.totalRuns).toBe(2);
    expect(report.measuredRuns).toBe(1);
  });
});

describe("renderContextCost", () => {
  const report = summarizeContextCost(
    [
      run({ run_id: "a", started_at_ms: T0 }),
      run({ run_id: "b", started_at_ms: T0 + 60_000 }),
    ],
    new Map([
      ["a", ["src/x.ts"]],
      ["b", ["src/x.ts"]],
    ]),
  );

  test("names both sides of the trade", () => {
    const text = renderContextCost(report);
    expect(text).toContain("Cold-start tax");
    expect(text).toContain("Peak context");
    expect(text).toContain("Compactions");
    // A reader who takes the tax as the answer has read half the section.
    expect(text).toContain("what it buys");
    // And a near-zero tax without this row reads as a broken metric.
    expect(text).toContain("Warm start");
  });

  test("shows the re-read count against its denominator", () => {
    expect(renderContextCost(report)).toContain("1 of 2");
  });

  test("says nothing at all when nothing in range carries the fields", () => {
    const empty = summarizeContextCost([], new Map());
    expect(renderContextCost(empty)).toBe("");
  });

  test("distinguishes never compacted from never counted", () => {
    const counted = renderContextCost(report);
    expect(counted).toMatch(/Compactions\s+0\s+across 0 of 2 run/);

    const uncounted = renderContextCost(
      summarizeContextCost(
        [
          run({ run_id: "a", compactions: null }),
          run({ run_id: "b", compactions: null }),
        ],
        new Map([["a", ["src/x.ts"]]]),
      ),
    );
    expect(uncounted).toContain("not recorded");
  });
});

describe("queryContextCost", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let logPath: string;

  /** A whole run's events: one prompt, one skill, and its tool calls. */
  function runEvents(
    runId: string,
    startedAt: string,
    reads: string[],
  ): Array<Record<string, any>> {
    const base = {
      timestamp: startedAt,
      run_id: runId,
      invocation_id: "inv-1",
      skill: "code",
      model: "sonnet4.6",
      effort: "medium",
      workspace: "/ws/proj",
      git_branch: "main",
      git_sha: "abc",
    };
    return [
      {
        ...base,
        event: "prompt",
        subject: "code/sonnet4.6",
        duration_ms: 1000,
        meta: {
          prompt_chars: 15_000,
          persona_chars: 12_000,
          instruction_chars: 3_000,
          response_chars: 500,
          usage: {
            source: "dsh-bedrock",
            modelId: "us.anthropic.claude-sonnet-4-6",
            turns: 2,
            cacheWriteTokens: 40_000,
            firstTurn: { cacheWriteTokens: 40_000 },
            turnPromptTokens: [40_000, 41_000],
            compactions: 0,
          },
        },
      },
      ...reads.map((file) => ({
        ...base,
        event: "tool_call",
        subject: "read",
        duration_ms: 5,
        meta: {
          input_summary: JSON.stringify({ path: file }),
          output_bytes: 100,
          error: false,
        },
      })),
      {
        ...base,
        event: "skill",
        subject: "code",
        duration_ms: 2000,
        meta: { status: "success", error_type: null, retry_count: 0 },
      },
    ];
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-context-"));
    logPath = path.join(tmpDir, "events.jsonl");
    db = openMetricsDb(path.join(tmpDir, "metrics.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("answers the whole question from the log alone", () => {
    fs.writeFileSync(
      logPath,
      [
        ...runEvents("run-1", "2026-08-20T10:00:00.000Z", [
          "src/a.ts",
          "src/b.ts",
        ]),
        ...runEvents("run-2", "2026-08-20T10:10:00.000Z", ["src/a.ts"]),
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
      "utf-8",
    );
    ingestFile(db, logPath);

    const report = queryContextCost(db, resolveRange({ kind: "all" }));

    expect(report.totalRuns).toBe(2);
    expect(report.episodes).toBe(1);
    expect(report.repeatRuns).toBe(1);
    expect(report.coldStartUsd).toBeCloseTo(0.138, 6);
    expect(report.p50PersonaChars).toBe(12_000);
    expect(report.p50InstructionChars).toBe(3_000);
    // src/a.ts, in the second run.
    expect(report.episodeReReads).toBe(1);
    expect(report.attributedReads).toBe(3);
    expect(report.p50PeakPromptTokens).toBe(41_000);
  });

  test("counts a re-read the two runs spelled differently", () => {
    // Observed live: the first run read `a.ts`, the second read the same file by
    // its absolute path. Two spellings, one file, one re-read.
    fs.writeFileSync(
      logPath,
      [
        ...runEvents("run-1", "2026-08-20T10:00:00.000Z", ["a.ts"]),
        ...runEvents("run-2", "2026-08-20T10:10:00.000Z", ["/ws/proj/a.ts"]),
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
      "utf-8",
    );
    ingestFile(db, logPath);

    const report = queryContextCost(db, resolveRange({ kind: "all" }));
    expect(report.attributedReads).toBe(2);
    expect(report.episodeReReads).toBe(1);
  });

  test("ignores tools that name a file without reading it", () => {
    const events = runEvents("run-1", "2026-08-20T10:00:00.000Z", []);
    const bashCall = {
      ...events[0],
      event: "tool_call",
      subject: "bash",
      duration_ms: 5,
      meta: {
        input_summary: JSON.stringify({ path: "src/a.ts" }),
        output_bytes: 1,
        error: false,
      },
    };
    fs.writeFileSync(
      logPath,
      [...events, bashCall].map((e) => `${JSON.stringify(e)}\n`).join(""),
      "utf-8",
    );
    ingestFile(db, logPath);

    expect(
      queryContextCost(db, resolveRange({ kind: "all" })).attributedReads,
    ).toBe(0);
  });
});
