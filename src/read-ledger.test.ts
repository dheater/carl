import {
  ReadLedger,
  renderBody,
  DEFAULT_MIN_ELIDED_LINES,
  type ReadWindow,
} from "./read-ledger";

/** A window of `count` lines starting at `offset`, with distinguishable text. */
function windowOf(
  path: string,
  offset: number,
  count: number,
  totalLines = offset + count - 1,
  text: (n: number) => string = (n) => `line ${n}`,
): ReadWindow {
  const lines = [];
  for (let n = offset; n < offset + count; n += 1) {
    lines.push({ number: n, text: text(n) });
  }
  return { path, offset, lines, totalLines };
}

describe("ReadLedger", () => {
  test("delivers a file it has not seen", () => {
    const ledger = new ReadLedger();
    expect(ledger.consider(windowOf("src/a.ts", 1, 40)).kind).toBe("deliver");
  });

  test("elides an identical re-read down to a pointer", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40));
    const verdict = ledger.consider(windowOf("src/a.ts", 1, 40));

    expect(verdict.kind).toBe("elide");
    if (verdict.kind !== "elide") return;
    expect(verdict.originalBody).toBe(
      renderBody(windowOf("src/a.ts", 1, 40).lines),
    );
    expect(verdict.replacementBody).toContain("lines 1-40 unchanged");
    expect(verdict.replacementBody).toContain("nothing new here");
    expect(verdict.replacementBody).not.toContain("line 20");
  });

  test("keeps only the new lines of an overlapping window", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40, 80));
    const verdict = ledger.consider(windowOf("src/a.ts", 1, 80, 80));

    expect(verdict.kind).toBe("elide");
    if (verdict.kind !== "elide") return;
    expect(verdict.replacementBody).toContain("lines 1-40 unchanged");
    expect(verdict.replacementBody).toContain("41: line 41");
    expect(verdict.replacementBody).toContain("80: line 80");
    expect(verdict.replacementBody).not.toContain("40: line 40");
    // Partially fresh: the reuse note would be wrong here.
    expect(verdict.replacementBody).not.toContain("nothing new here");
  });

  test("marks an interior gap without renumbering the lines around it", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 20, 20, 100));
    const verdict = ledger.consider(windowOf("src/a.ts", 1, 100, 100));

    expect(verdict.kind).toBe("elide");
    if (verdict.kind !== "elide") return;
    const body = verdict.replacementBody.split("\n");
    expect(body).toContain("19: line 19");
    expect(body).toContain(
      "[read ledger] lines 20-39 unchanged since shown earlier in this conversation; omitted here",
    );
    expect(body).toContain("40: line 40");
  });

  test("delivers the whole window again when a line changed", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40));
    const edited = windowOf("src/a.ts", 1, 40, 40, (n) =>
      n === 7 ? "line 7 (edited)" : `line ${n}`,
    );

    expect(ledger.consider(edited).kind).toBe("deliver");
  });

  test("forgets the rest of a changed file rather than trusting old numbering", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40));
    ledger.consider(
      windowOf("src/a.ts", 1, 20, 40, (n) =>
        n === 7 ? "line 7 (edited)" : `line ${n}`,
      ),
    );

    // Lines 21-40 were recorded before the change and are not claimed now.
    const verdict = ledger.consider(windowOf("src/a.ts", 21, 20, 40));
    expect(verdict.kind).toBe("deliver");
  });

  test("keeps files apart", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40));
    expect(ledger.consider(windowOf("src/b.ts", 1, 40)).kind).toBe("deliver");
  });

  test("delivers a repeat of fewer lines than the threshold", () => {
    const ledger = new ReadLedger();
    const small = windowOf(
      "src/a.ts",
      1,
      DEFAULT_MIN_ELIDED_LINES - 1,
      DEFAULT_MIN_ELIDED_LINES - 1,
      (n) => `line ${n} ${"padding ".repeat(10)}`,
    );
    ledger.consider(small);
    expect(ledger.consider(small).kind).toBe("deliver");
  });

  test("honors a configured threshold", () => {
    const ledger = new ReadLedger(3);
    const small = windowOf(
      "src/a.ts",
      1,
      3,
      3,
      (n) => `line ${n} ${"padding ".repeat(10)}`,
    );
    ledger.consider(small);
    expect(ledger.consider(small).kind).toBe("elide");
  });

  test("declines when the markers would cost more than the lines", () => {
    const ledger = new ReadLedger(1);
    // Every other line already seen: 50 one-line markers replacing 50 short
    // lines is a longer result, not a shorter one.
    const odd: ReadWindow = {
      path: "src/a.ts",
      offset: 1,
      lines: Array.from({ length: 50 }, (_, i) => ({
        number: i * 2 + 1,
        text: "x",
      })),
      totalLines: 100,
    };
    ledger.consider(odd);
    const verdict = ledger.consider(
      windowOf("src/a.ts", 1, 100, 100, () => "x"),
    );
    expect(verdict.kind).toBe("deliver");
  });

  test("delivers in full again after forgetting", () => {
    const ledger = new ReadLedger();
    ledger.consider(windowOf("src/a.ts", 1, 40));
    ledger.forget();
    expect(ledger.consider(windowOf("src/a.ts", 1, 40)).kind).toBe("deliver");
  });

  test("ignores an empty window", () => {
    const ledger = new ReadLedger();
    const empty: ReadWindow = {
      path: "src/empty.ts",
      offset: 1,
      lines: [],
      totalLines: 0,
    };
    expect(ledger.consider(empty).kind).toBe("deliver");
    expect(ledger.consider(empty).kind).toBe("deliver");
  });
});
