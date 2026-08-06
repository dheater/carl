import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseStatsArgs, cmdStats } from "./stats-command";

describe("parseStatsArgs", () => {
  test("defaults to this week", () => {
    expect(parseStatsArgs([]).range).toEqual({ kind: "this-week" });
  });

  test("accepts each named range", () => {
    expect(parseStatsArgs(["--this-month"]).range).toEqual({
      kind: "this-month",
    });
    expect(parseStatsArgs(["--this-year"]).range).toEqual({
      kind: "this-year",
    });
    expect(parseStatsArgs(["--all"]).range).toEqual({ kind: "all" });
  });

  test("an explicit date overrides a named range", () => {
    expect(
      parseStatsArgs(["--this-year", "--from", "2026-08-01"]).range,
    ).toEqual({ kind: "explicit", from: "2026-08-01", to: undefined });
  });

  test("collects both explicit bounds", () => {
    expect(
      parseStatsArgs(["--from", "2026-08-01", "--to", "2026-08-05"]).range,
    ).toEqual({ kind: "explicit", from: "2026-08-01", to: "2026-08-05" });
  });

  test("rejects a date flag with no value", () => {
    expect(() => parseStatsArgs(["--from"])).toThrow(/requires a YYYY-MM-DD/);
  });

  test("rejects --skill with no value", () => {
    expect(() => parseStatsArgs(["--skill"])).toThrow(/requires a value/);
  });

  test("parses the boolean flags", () => {
    const options = parseStatsArgs(["--rebuild", "--json"]);
    expect(options.rebuild).toBe(true);
    expect(options.json).toBe(true);
  });

  test("takes --skill without warning for any value", () => {
    expect(parseStatsArgs(["--skill", "code"]).skill).toBe("code");
    expect(parseStatsArgs(["--skill", "duck"]).skill).toBe("duck");
  });

  test("rejects an unknown flag rather than silently ignoring it", () => {
    expect(() => parseStatsArgs(["--last-week"])).toThrow(/unknown option/);
    expect(() => parseStatsArgs(["--import-legacy"])).toThrow(/unknown option/);
  });
});


describe("cmdStats", () => {
  let tmpDir: string;
  let stdout: string[];
  let stderr: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  const EVENT = {
    timestamp: "2026-08-04T10:00:00.000Z",
    run_id: "run-1",
    invocation_id: "inv-1",
    event: "prompt",
    subject: "code/sonnet4.6",
    duration_ms: 60_000,
    skill: "code",
    model: "sonnet4.6",
    effort: "medium",
    workspace: "/ws/proj",
    git_branch: "main",
    git_sha: "abc",
    meta: {
      prompt_chars: 100,
      response_chars: 50,
      usage: {
        source: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 10,
      },
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carl-cmd-"));
    process.env.CARL_CONFIG_DIR = tmpDir;
    stdout = [];
    stderr = [];
    logSpy = jest
      .spyOn(console, "log")
      .mockImplementation((m?: any) => void stdout.push(String(m)));
    errSpy = jest
      .spyOn(console, "error")
      .mockImplementation((m?: any) => void stderr.push(String(m)));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.CARL_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLiveLog(): void {
    fs.writeFileSync(
      path.join(tmpDir, "events.jsonl"),
      `${JSON.stringify(EVENT)}\n`,
      "utf-8",
    );
  }

  test("explains how to proceed when no event log exists yet", () => {
    cmdStats(["--all"]);
    expect(stderr.join("\n")).toMatch(/No event log/);
    expect(stdout).toEqual([]);
  });

  test("reports on the live log", () => {
    writeLiveLog();
    cmdStats(["--all"]);

    const out = stdout.join("\n");
    expect(out).toContain("code");
    expect(out).toContain("$3.00");
    expect(out).toContain("Ingested 1 event(s)");
  });

  test("--json writes only parseable JSON to stdout, progress to stderr", () => {
    writeLiveLog();
    cmdStats(["--all", "--rebuild", "--json"]);

    // The whole of stdout must parse; a stray progress line would break it.
    const report = JSON.parse(stdout.join("\n"));
    expect(report.totalRuns).toBe(1);
    expect(report.totalCostUsd).toBeCloseTo(3.0, 5);
    expect(stderr.join("\n")).toMatch(/Rebuilding/);
  });

  test("--rebuild reproduces identical aggregates from the log alone", () => {
    writeLiveLog();
    cmdStats(["--all", "--json"]);
    const first = stdout.join("\n");

    stdout = [];
    cmdStats(["--all", "--rebuild", "--json"]);
    expect(stdout.join("\n")).toBe(first);
  });
});
