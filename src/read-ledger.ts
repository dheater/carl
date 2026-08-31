/**
 * The read ledger: within one session, lines the model has already been shown
 * are not shown to it a second time.
 *
 * Measured over the whole of ~/.config/carl/events.jsonl: 317 of 2,321 reads
 * (14%) re-requested a file the same run had already read. Every one of those
 * bytes is charged twice — once when it enters the context and again on every
 * cached turn after it — which is why the recoverable spend, ~1.2% of the total,
 * is an order of magnitude larger than the duplicate bytes alone.
 *
 * An earlier version of this comment cited 42%, measured over the v8 era only.
 * That slice was not representative, and the honest average is a weak case for
 * this file. The case is the tail: the revisit rate runs 3% in the first fifth
 * of a long run and 66% in the last, and that last fifth is also where tool
 * errors peak at 10.7% and where 15% of 40-plus-turn runs fail outright — see
 * src/degradation.ts, which tracks both series. The ledger is aimed at the
 * failure mode, not at the mean. If it does not move those series in practice,
 * it has not earned 400 lines and should go.
 *
 * The ledger is exact, not heuristic. It remembers the text of each delivered
 * line, so "already shown" is a comparison rather than a guess: a re-read whose
 * lines differ is a changed file and is delivered in full. It rewrites only the
 * model-facing content; the canonical value a Code Mode program receives is
 * untouched, and so is the `fs/observed` record that read-before-edit depends
 * on. Eliding a re-read never blocks an edit.
 *
 * The one way it can lie is by claiming a copy is "above" after the copy has
 * been evicted from the context. Compaction is what evicts, so the plugin drops
 * the whole ledger when a compaction starts — see src/read-ledger-plugin.ts.
 */

/** One line of a read window, as the `read` tool's canonical value carries it. */
export interface ReadLine {
  number: number;
  text: string;
}

/** The `read` tool's canonical value: one contiguous window over one file. */
export interface ReadWindow {
  path: string;
  offset: number;
  lines: ReadLine[];
  totalLines: number;
}

/**
 * What the model should be shown for a window. `elide` carries the exact
 * numbered-line body the tool rendered and the shorter body that replaces it,
 * so the caller can splice it into the tool's own envelope rather than
 * reconstructing one.
 */
export type LedgerDecision =
  | { kind: "deliver" }
  | { kind: "elide"; originalBody: string; replacementBody: string };

/**
 * Repeated lines below this count are delivered anyway: rewriting a short result
 * is how a ledger becomes noise. It is a floor, not the whole test — a window
 * whose replacement would not be shorter than the lines it replaces is also
 * delivered, which is what rules out short files no matter how this is set.
 */
export const DEFAULT_MIN_ELIDED_LINES = 10;

/** The tool's own numbered-line rendering, reproduced for exact splicing. */
export function renderBody(lines: ReadLine[]): string {
  return lines.map((line) => `${line.number}: ${line.text}`).join("\n");
}

function marker(from: number, to: number): string {
  const span = from === to ? `line ${from}` : `lines ${from}-${to}`;
  return `[read ledger] ${span} unchanged since shown earlier in this conversation; omitted here`;
}

const REUSE_NOTE =
  "[read ledger] nothing new here — reuse the copy already in the conversation";

interface LineRun {
  repeated: boolean;
  lines: ReadLine[];
}

/** Split a window into maximal runs of same-verdict lines, in file order. */
function groupRuns(lines: ReadLine[], repeated: Set<number>): LineRun[] {
  const runs: LineRun[] = [];
  for (const line of lines) {
    const isRepeat = repeated.has(line.number);
    const current = runs.at(-1);
    if (current !== undefined && current.repeated === isRepeat) {
      current.lines.push(line);
      continue;
    }
    runs.push({ repeated: isRepeat, lines: [line] });
  }
  return runs;
}

/**
 * Per-session record of what has been delivered, keyed by the backend-resolved
 * display path and then by line number. Bounded by the distinct bytes the run
 * reads, which the event log puts in single-digit megabytes even for carl's
 * heaviest runs — so the lines are stored verbatim rather than hashed, and
 * "unchanged" carries no collision risk.
 */
export class ReadLedger {
  private delivered = new Map<string, Map<number, string>>();
  private readonly minElidedLines: number;

  constructor(minElidedLines: number = DEFAULT_MIN_ELIDED_LINES) {
    this.minElidedLines = Math.max(1, Math.floor(minElidedLines));
  }

  /**
   * Forget everything. Called when the context the ledger points at is no
   * longer intact, which makes "shown earlier" false for every entry.
   */
  forget(): void {
    this.delivered = new Map();
  }

  /** Record a delivered window and decide what the model should see for it. */
  consider(window: ReadWindow): LedgerDecision {
    if (window.lines.length === 0) return { kind: "deliver" };

    const known = this.delivered.get(window.path);
    if (known === undefined) {
      this.remember(window);
      return { kind: "deliver" };
    }

    // A line that changed means the file moved under us, and after an insertion
    // a line number no longer names the line it did before — so every later
    // entry for this path is stale, not just the ones that differ. Drop the
    // path and start over from this window.
    const changed = window.lines.some((line) => {
      const prior = known.get(line.number);
      return prior !== undefined && prior !== line.text;
    });
    if (changed) {
      this.delivered.delete(window.path);
      this.remember(window);
      return { kind: "deliver" };
    }

    const repeated = new Set(
      window.lines
        .filter((line) => known.has(line.number))
        .map((line) => line.number),
    );
    this.remember(window);
    if (repeated.size < this.minElidedLines) return { kind: "deliver" };

    const runs = groupRuns(window.lines, repeated);
    const bodies = runs.map((run) =>
      run.repeated
        ? marker(run.lines[0].number, run.lines[run.lines.length - 1].number)
        : renderBody(run.lines),
    );
    if (runs.every((run) => run.repeated)) bodies.push(REUSE_NOTE);

    const originalBody = renderBody(window.lines);
    const replacementBody = bodies.join("\n");
    // An interleaved window can cost more in markers than it saves in lines.
    // The ledger exists to shrink the context, so it declines when it wouldn't.
    if (replacementBody.length >= originalBody.length)
      return { kind: "deliver" };
    return { kind: "elide", originalBody, replacementBody };
  }

  private remember(window: ReadWindow): void {
    let byLine = this.delivered.get(window.path);
    if (byLine === undefined) {
      byLine = new Map();
      this.delivered.set(window.path, byLine);
    }
    for (const line of window.lines) byLine.set(line.number, line.text);
  }
}
