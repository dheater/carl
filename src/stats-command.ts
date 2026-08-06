import * as fs from "fs";

import {
  openMetricsDb,
  resetMetricsDb,
  ingestLiveLog,
  getMetricsDbPath,
  getLiveEventsLogPath,
  type IngestResult,
} from "./metrics-db";
import {
  resolveRange,
  buildReport,
  renderReport,
  type RangeSelector,
} from "./stats";

export type StatsOptions = {
  range: RangeSelector;
  skill?: string;
  rebuild: boolean;
  json: boolean;
};

const RANGE_FLAGS: Record<string, RangeSelector> = {
  "--this-week": { kind: "this-week" },
  "--this-month": { kind: "this-month" },
  "--this-year": { kind: "this-year" },
  "--all": { kind: "all" },
};

export function parseStatsArgs(args: string[]): StatsOptions {
  const options: StatsOptions = {
    range: { kind: "this-week" },
    rebuild: false,
    json: false,
  };
  let from: string | undefined;
  let to: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (RANGE_FLAGS[arg]) {
      options.range = RANGE_FLAGS[arg];
    } else if (arg === "--from" || arg === "--to") {
      const value = args[++i];
      if (!value) throw new Error(`error: ${arg} requires a YYYY-MM-DD value`);
      if (arg === "--from") from = value;
      else to = value;
    } else if (arg === "--skill") {
      const value = args[++i];
      if (!value) throw new Error("error: --skill requires a value");
      options.skill = value;
    } else if (arg === "--rebuild") {
      options.rebuild = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(
        `error: unknown option for \`carl stats\`: ${arg}\n` +
          `Run \`carl\` with no arguments for usage.`,
      );
    }
  }

  if (from || to) {
    options.range = { kind: "explicit", from, to };
  }
  return options;
}

function summarizeIngest(results: IngestResult[]): string {
  const totals = results.reduce(
    (acc, r) => ({
      files: acc.files + (r.linesRead > 0 ? 1 : 0),
      accepted: acc.accepted + r.eventsAccepted,
      skipped: acc.skipped + r.eventsSkipped,
      malformed: acc.malformed + r.malformedLines,
      runs: acc.runs + r.runsTouched,
    }),
    { files: 0, accepted: 0, skipped: 0, malformed: 0, runs: 0 },
  );

  const parts = [
    `${totals.accepted} event(s) from ${totals.files} file(s)`,
    `${totals.runs} run(s)`,
  ];
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  if (totals.malformed > 0) parts.push(`${totals.malformed} malformed`);
  return `Ingested ${parts.join(", ")}.`;
}

export function cmdStats(args: string[]): void {
  const options = parseStatsArgs(args);
  const db = openMetricsDb();

  // Progress goes to stderr so `--json` stdout stays machine-parseable.
  const progress = (message: string): void => console.error(message);

  try {
    if (options.rebuild) {
      progress(`Rebuilding ${getMetricsDbPath()} from event logs...`);
      resetMetricsDb(db);
    }

    const ingested: IngestResult[] = [];
    const liveLog = getLiveEventsLogPath();
    if (!fs.existsSync(liveLog)) {
      console.error(`No event log at ${liveLog}.\nRun a skill first.`);
      return;
    }
    ingested.push(ingestLiveLog(db));

    const summary = summarizeIngest(ingested);
    const range = resolveRange(options.range);
    const report = buildReport(db, range, options.skill);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(summary);
    console.log("");
    console.log(renderReport(report));
    console.log(
      `Source: ${liveLog}\n` +
        `Cache:  ${getMetricsDbPath()} (derived; safe to delete, rebuild with --rebuild)`,
    );
  } finally {
    db.close();
  }
}
