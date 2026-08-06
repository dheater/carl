import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";

import {
  openMetricsDb,
  resetMetricsDb,
  ingestFile,
  repriceIfRatesChanged,
  workspaceFromLogPath,
  MODERN_ERA_START,
} from "./metrics-db";
import { RATES_FINGERPRINT } from "./skill";

type EventOverrides = Record<string, any>;

let tmpDir: string;
let db: DatabaseSync;
let logPath: string;

function makeEvent(overrides: EventOverrides = {}): Record<string, any> {
  return {
    timestamp: "2026-07-25T10:00:00.000Z",
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
    git_sha: "deadbeef",
    meta: {
      status: "success",
      error_type: null,
      retry_count: 0,
      git_repo: true,
      tracked_changed_before: 1,
      tracked_changed_after: 3,
      untracked_before: 0,
      untracked_after: 1,
      output_path: ".agent/notes/code.md",
      output_exists: true,
    },
    ...overrides,
  };
}

function promptEvent(overrides: EventOverrides = {}): Record<string, any> {
  return makeEvent({
    event: "prompt",
    subject: "code/sonnet4.6",
    duration_ms: 55_000,
    meta: {
      prompt_chars: 4000,
      response_chars: 900,
      usage: {
        source: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 12,
      },
    },
    ...overrides,
  });
}

function write(events: Array<Record<string, any>>, append = false): void {
  const text = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  if (append) fs.appendFileSync(logPath, text, "utf-8");
  else fs.writeFileSync(logPath, text, "utf-8");
}

function runs(): any[] {
  return db.prepare("SELECT * FROM runs ORDER BY run_id").all() as any[];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-metrics-"));
  logPath = path.join(tmpDir, "events.jsonl");
  db = openMetricsDb(path.join(tmpDir, "metrics.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ingestFile: folding events into runs", () => {
  test("folds skill and prompt events for one run into a single row", () => {
    write([promptEvent(), makeEvent()]);
    const result = ingestFile(db, logPath);

    expect(result.eventsAccepted).toBe(2);
    expect(result.runsTouched).toBe(1);

    const [run] = runs();
    expect(run.run_id).toBe("run-1");
    expect(run.skill).toBe("code");
    expect(run.status).toBe("success");
    expect(run.duration_ms).toBe(60_000);
    expect(run.turns).toBe(12);
    expect(run.prompt_chars).toBe(4000);
    // 1M input @ $3 + 1M output @ $15
    expect(run.cost_usd).toBeCloseTo(18.0, 5);
    expect(run.effort).toBe("medium");
    expect(run.workspace).toBe("/ws/proj");
    expect(run.git_branch).toBe("main");
    expect(run.invocation_id).toBe("inv-1");
  });

  test("a run whose skill event arrives in a later chunk still completes", () => {
    write([promptEvent()]);
    ingestFile(db, logPath);
    expect(runs()[0].status).toBeNull();

    write([makeEvent()], true);
    ingestFile(db, logPath);

    const [run] = runs();
    expect(run.status).toBe("success");
    expect(run.turns).toBe(12); // earlier prompt data preserved
    expect(runs()).toHaveLength(1);
  });

  test("keeps the earliest timestamp as the run start", () => {
    write([
      makeEvent({ timestamp: "2026-07-25T10:05:00.000Z" }),
      promptEvent({ timestamp: "2026-07-25T10:00:00.000Z" }),
    ]);
    ingestFile(db, logPath);

    const [run] = runs();
    expect(run.started_at).toBe("2026-07-25T10:00:00.000Z");
    expect(run.ended_at).toBe("2026-07-25T10:05:00.000Z");
  });

  test("records usage carried on a failed run's skill event", () => {
    write([
      makeEvent({
        meta: {
          status: "error",
          error_type: "exception",
          retry_count: 0,
          usage: {
            source: "bedrock",
            modelId: "us.anthropic.claude-sonnet-4-6",
            inputTokens: 1_000_000,
            turns: 80,
          },
        },
      }),
    ]);
    ingestFile(db, logPath);

    const [run] = runs();
    expect(run.status).toBe("error");
    expect(run.turns).toBe(80);
    expect(run.cost_usd).toBeCloseTo(3.0, 5);
  });

  test("leaves cost NULL for a model with no known rates", () => {
    write([
      promptEvent({
        model: "gpt5.4",
        meta: {
          prompt_chars: 10,
          response_chars: 10,
          usage: { source: "openai", inputTokens: 1000 },
        },
      }),
    ]);
    ingestFile(db, logPath);

    const [run] = runs();
    expect(run.input_tokens).toBe(1000);
    expect(run.cost_usd).toBeNull();
    // The model is still recorded so repricing can retry it if rates are added.
    expect(run.model_id).toBe("gpt5.4");
  });

  test("prices legacy events that carry only a short model alias", () => {
    write([
      promptEvent({
        meta: {
          prompt_chars: 10,
          response_chars: 10,
          // No modelId — older events omitted it.
          usage: { source: "bedrock", inputTokens: 1_000_000 },
        },
      }),
    ]);
    ingestFile(db, logPath);

    expect(runs()[0].cost_usd).toBeCloseTo(3.0, 5);
  });
});

describe("ingestFile: tool calls", () => {
  function toolCall(overrides: EventOverrides = {}): Record<string, any> {
    return makeEvent({
      event: "tool_call",
      subject: "bash",
      duration_ms: 120,
      meta: { input_summary: "npm test", output_bytes: 2048, error: false },
      ...overrides,
    });
  }

  test("stores each call and maintains per-run counts", () => {
    write([
      toolCall(),
      toolCall({ subject: "read_file" }),
      toolCall({
        meta: { input_summary: "bad", output_bytes: 10, error: true },
      }),
      makeEvent(),
    ]);
    ingestFile(db, logPath);

    const calls = db
      .prepare("SELECT * FROM tool_calls ORDER BY ordinal")
      .all() as any[];
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.tool)).toEqual(["bash", "read_file", "bash"]);
    expect(calls[2].error).toBe(1);

    const [run] = runs();
    expect(run.tool_call_count).toBe(3);
    expect(run.tool_error_count).toBe(1);
  });

  test("keeps same-millisecond calls distinct", () => {
    const ts = "2026-07-25T10:00:00.000Z";
    write([toolCall({ timestamp: ts }), toolCall({ timestamp: ts })]);
    ingestFile(db, logPath);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get() as any).n,
    ).toBe(2);
  });

  test("treats placeholder zero duration and size as unknown, not zero", () => {
    write([
      toolCall({
        duration_ms: 0,
        meta: { input_summary: "", output_bytes: 0, error: false },
      }),
    ]);
    ingestFile(db, logPath);

    const [call] = db.prepare("SELECT * FROM tool_calls").all() as any[];
    expect(call.duration_ms).toBeNull();
    expect(call.output_bytes).toBeNull();
  });
});

describe("ingestFile: incremental resume", () => {
  test("re-ingesting an unchanged file is a no-op", () => {
    write([promptEvent(), makeEvent()]);
    const first = ingestFile(db, logPath);
    const second = ingestFile(db, logPath);

    expect(second.eventsAccepted).toBe(0);
    expect(second.bytesConsumed).toBe(first.bytesConsumed);
    expect(runs()).toHaveLength(1);
  });

  test("only new lines are read on a second pass", () => {
    write([promptEvent()]);
    ingestFile(db, logPath);

    write([makeEvent({ run_id: "run-2" })], true);
    const second = ingestFile(db, logPath);

    expect(second.linesRead).toBe(1);
    expect(second.eventsAccepted).toBe(1);
    expect(runs()).toHaveLength(2);
  });

  test("holds back a trailing partial line until it is complete", () => {
    const full = `${JSON.stringify(promptEvent())}\n`;
    const partial = JSON.stringify(makeEvent({ run_id: "run-2" })).slice(0, 40);
    fs.writeFileSync(logPath, full + partial, "utf-8");

    const first = ingestFile(db, logPath);
    expect(first.eventsAccepted).toBe(1);
    expect(first.malformedLines).toBe(0);
    expect(runs()).toHaveLength(1);

    // Writer finishes the line.
    fs.appendFileSync(
      logPath,
      `${JSON.stringify(makeEvent({ run_id: "run-2" })).slice(40)}\n`,
      "utf-8",
    );
    ingestFile(db, logPath);
    expect(runs()).toHaveLength(2);
  });

  test("re-reads from the start when a file is truncated", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);
    expect(runs()).toHaveLength(1);

    // Rotated: smaller file with different content.
    fs.writeFileSync(
      logPath,
      `${JSON.stringify(makeEvent({ run_id: "run-9" }))}\n`,
      "utf-8",
    );
    fs.utimesSync(logPath, new Date(0), new Date(0));

    ingestFile(db, logPath);
    expect(runs().map((r) => r.run_id)).toContain("run-9");
  });

  test("missing source file is not an error", () => {
    const result = ingestFile(db, path.join(tmpDir, "nope.jsonl"));
    expect(result.eventsAccepted).toBe(0);
  });
});

describe("ingestFile: hygiene filters", () => {
  test("drops test-model pollution", () => {
    write([makeEvent({ model: "test-model" }), makeEvent({ run_id: "real" })]);
    const result = ingestFile(db, logPath);

    expect(result.eventsSkipped).toBe(1);
    expect(runs().map((r) => r.run_id)).toEqual(["real"]);
  });

  test("skips events before the modern-era cutover", () => {
    write([
      makeEvent({ run_id: "old", timestamp: "2026-05-01T00:00:00.000Z" }),
      makeEvent({ run_id: "new" }),
    ]);
    ingestFile(db, logPath);

    expect(runs().map((r) => r.run_id)).toEqual(["new"]);
  });

  test("skips pre-rename events that use phase instead of skill", () => {
    const legacy = makeEvent();
    delete legacy.skill;
    legacy.phase = "reviewer";
    write([legacy]);

    const result = ingestFile(db, logPath);
    expect(result.eventsSkipped).toBe(1);
    expect(runs()).toHaveLength(0);
  });

  test("skips unrecognized event types such as Auggie.create", () => {
    write([makeEvent({ event: "Auggie.create" })]);
    expect(ingestFile(db, logPath).eventsSkipped).toBe(1);
  });

  test("counts malformed lines without aborting the ingest", () => {
    fs.writeFileSync(
      logPath,
      `not json\n${JSON.stringify(makeEvent())}\n`,
      "utf-8",
    );
    const result = ingestFile(db, logPath);

    expect(result.malformedLines).toBe(1);
    expect(result.eventsAccepted).toBe(1);
  });

  test("discards a skill name stored in the model field", () => {
    write([makeEvent({ run_id: "b", model: "code-review" })]);
    ingestFile(db, logPath);

    const byId = Object.fromEntries(runs().map((r) => [r.run_id, r]));
    expect(byId.b.model).toBeNull();
  });

  test("MODERN_ERA_START is the phase-to-skill rename instant", () => {
    expect(Date.parse(MODERN_ERA_START)).toBe(
      Date.parse("2026-06-16T00:32:30Z"),
    );
  });
});

describe("workspace attribution", () => {
  test("derives the workspace from a per-directory log path", () => {
    expect(workspaceFromLogPath("/a/b/.carl/events.jsonl")).toBe("/a/b");
  });

  test("returns null for a log that is not under .carl", () => {
    expect(
      workspaceFromLogPath("/home/me/.config/carl/events.jsonl"),
    ).toBeNull();
  });

  test("backfills workspace from the path when the event lacks the field", () => {
    const legacyDir = path.join(tmpDir, "proj", ".carl");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyLog = path.join(legacyDir, "events.jsonl");
    const event = makeEvent();
    delete event.workspace;
    fs.writeFileSync(legacyLog, `${JSON.stringify(event)}\n`, "utf-8");

    ingestFile(db, legacyLog);
    expect(runs()[0].workspace).toBe(path.join(tmpDir, "proj"));
  });

  test("an explicit workspace field wins over the path", () => {
    const legacyDir = path.join(tmpDir, "proj", ".carl");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyLog = path.join(legacyDir, "events.jsonl");
    fs.writeFileSync(legacyLog, `${JSON.stringify(makeEvent())}\n`, "utf-8");

    ingestFile(db, legacyLog);
    expect(runs()[0].workspace).toBe("/ws/proj");
  });
});

describe("resetMetricsDb", () => {
  test("clears all rows and watermarks so a rebuild re-reads everything", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);

    resetMetricsDb(db);
    expect(runs()).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM ingest_log").get() as any).n,
    ).toBe(0);

    const after = ingestFile(db, logPath);
    expect(after.eventsAccepted).toBe(2);
    expect(runs()).toHaveLength(1);
  });

  test("a rebuild reproduces identical aggregates", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);
    const before = db
      .prepare("SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost FROM runs")
      .get();

    resetMetricsDb(db);
    ingestFile(db, logPath);
    const after = db
      .prepare("SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost FROM runs")
      .get();

    expect(after).toEqual(before);
  });
});

describe("openMetricsDb: schema drift", () => {
  test("rebuilds a cache written by an older carl instead of failing on it", () => {
    const dbPath = path.join(tmpDir, "old.db");
    let old = openMetricsDb(dbPath);
    // Simulate the pre-model_id schema: CREATE TABLE IF NOT EXISTS would leave
    // this table as-is, and the first ingest would die on the missing column.
    old.exec("DROP TABLE runs; CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
    old.close();

    const warn = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      old = openMetricsDb(dbPath);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Schema"));
    } finally {
      warn.mockRestore();
    }

    logPath = path.join(tmpDir, "old-events.jsonl");
    write([promptEvent(), makeEvent()]);
    expect(ingestFile(old, logPath).eventsAccepted).toBe(2);
    old.close();
  });
});

describe("repricing at current rates", () => {
  /** Fakes a past ingest under a different rate table. */
  function pretendRatesChanged(): void {
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(
      "stale-rates",
      "rates_fingerprint",
    );
  }

  function setCost(runId: string, cost: number | null): void {
    db.prepare("UPDATE runs SET cost_usd = ? WHERE run_id = ?").run(
      cost,
      runId,
    );
  }

  test("the fingerprint is derived from the rate numbers, not hand-maintained", () => {
    // Every rate appears in the fingerprint, so editing any of them changes it.
    // A version constant would have to be remembered; this cannot be forgotten.
    expect(RATES_FINGERPRINT).toContain("sonnet");
    expect(RATES_FINGERPRINT).toContain("3/15/3.75/0.3");
    expect(RATES_FINGERPRINT).toContain("opus");
    expect(RATES_FINGERPRINT).toContain("5/25/6.25/0.5");
  });

  test("recomputes stored costs when the rate table has changed", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);

    // A cost frozen under an older, 3x-too-high opus-era rate table.
    setCost("run-1", 54.0);
    pretendRatesChanged();

    const result = repriceIfRatesChanged(db);

    expect(result.repriced).toBe(true);
    expect(result.runsRepriced).toBe(1);
    // Back to 1M input @ $3 + 1M output @ $15 at current rates.
    expect(runs()[0].cost_usd).toBeCloseTo(18.0, 5);
  });

  test("records the new fingerprint so the next call is a no-op", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);
    pretendRatesChanged();
    repriceIfRatesChanged(db);

    // The second call must not touch rows; proven by leaving a bogus cost in
    // place and showing it survives.
    setCost("run-1", 99.0);
    expect(repriceIfRatesChanged(db).repriced).toBe(false);
    expect(runs()[0].cost_usd).toBe(99.0);
  });

  test("leaves unpriced runs NULL rather than costing them at zero", () => {
    write([
      promptEvent({
        model: "gpt5.4",
        meta: {
          prompt_chars: 10,
          response_chars: 10,
          usage: { source: "openai", modelId: "gpt5.4", inputTokens: 1000 },
        },
      }),
    ]);
    ingestFile(db, logPath);
    pretendRatesChanged();

    repriceIfRatesChanged(db);

    expect(runs()[0].cost_usd).toBeNull();
  });

  test("skips runs with no model instead of zeroing them", () => {
    // A failed run with no usage records no model, so there is nothing to price.
    write([makeEvent()]);
    ingestFile(db, logPath);
    pretendRatesChanged();

    expect(repriceIfRatesChanged(db).runsRepriced).toBe(0);
    expect(runs()[0].cost_usd).toBeNull();
  });

  test("a first-ever open is not reported as a rate change", () => {
    // openMetricsDb already ran once in beforeEach, so clear the fingerprint to
    // reach the genuine first-open state.
    db.exec("DELETE FROM meta");
    expect(repriceIfRatesChanged(db).repriced).toBe(false);
    expect(
      db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("rates_fingerprint"),
    ).toEqual({ value: RATES_FINGERPRINT });
  });

  test("opening the DB reprices, so every report reflects current rates", () => {
    write([promptEvent(), makeEvent()]);
    ingestFile(db, logPath);
    setCost("run-1", 54.0);
    pretendRatesChanged();
    const dbPath = path.join(tmpDir, "metrics.db");
    db.close();

    db = openMetricsDb(dbPath);

    expect(runs()[0].cost_usd).toBeCloseTo(18.0, 5);
  });
});
