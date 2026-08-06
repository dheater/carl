import {
  percentile,
  mean,
  formatUsd,
  formatDuration,
  formatTokens,
  formatCount,
  formatPercent,
  renderTable,
  bucketize,
  renderHistogram,
  NO_DATA,
} from "./stats-format";

describe("percentile", () => {
  test("returns null for an empty sample rather than zero", () => {
    expect(percentile([], 50)).toBeNull();
  });

  test("returns the only value for a single-element sample", () => {
    expect(percentile([42], 99)).toBe(42);
  });

  test("interpolates between neighbours", () => {
    // rank = 0.5 * 3 = 1.5 → midpoint of 20 and 30
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  test("hits exact elements at the endpoints", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 100)).toBe(30);
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });

  test("sorts numerically, not lexicographically", () => {
    expect(percentile([100, 9, 80], 50)).toBe(80);
  });

  test("ignores non-finite values", () => {
    expect(percentile([1, NaN, 3], 50)).toBe(2);
  });
});

describe("mean", () => {
  test("is null on an empty sample", () => {
    expect(mean([])).toBeNull();
  });

  test("averages finite values only", () => {
    expect(mean([1, 2, 3, NaN])).toBe(2);
  });
});

describe("formatters", () => {
  test("render the no-data placeholder for null and undefined", () => {
    expect(formatUsd(null)).toBe(NO_DATA);
    expect(formatDuration(undefined)).toBe(NO_DATA);
    expect(formatTokens(null)).toBe(NO_DATA);
    expect(formatCount(null)).toBe(NO_DATA);
    expect(formatPercent(null)).toBe(NO_DATA);
  });

  test("formatUsd keeps sub-cent amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(1.239)).toBe("$1.24");
    expect(formatUsd(84.53)).toBe("$84.53");
  });

  test("formatDuration scales from seconds to hours", () => {
    expect(formatDuration(57_000)).toBe("57s");
    expect(formatDuration(95_000)).toBe("1m35s");
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(5_400_000)).toBe("1h30m");
  });

  test("formatTokens abbreviates thousands and millions", () => {
    expect(formatTokens(945)).toBe("945");
    expect(formatTokens(129_000)).toBe("129k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });

  test("formatCount keeps integers exact and rounds fractions", () => {
    expect(formatCount(10)).toBe("10");
    expect(formatCount(10.25)).toBe("10.3");
  });

  test("formatPercent scales the fraction", () => {
    expect(formatPercent(0.0625)).toBe("6%");
    expect(formatPercent(0.0625, 1)).toBe("6.3%");
  });
});

describe("renderTable", () => {
  test("right-aligns numbers and left-aligns labels", () => {
    const out = renderTable(
      [{ header: "SKILL", align: "left" }, { header: "COST" }],
      [
        ["code", "$78.95"],
        ["review", "$5.58"],
      ],
    );
    expect(out.split("\n")).toEqual([
      "SKILL     COST",
      "code    $78.95",
      "review   $5.58",
    ]);
  });

  test("widens a column to fit its widest cell", () => {
    const out = renderTable([{ header: "N" }], [["12345"]]);
    expect(out.split("\n")).toEqual(["    N", "12345"]);
  });

  test("tolerates short rows and emits no trailing whitespace", () => {
    const out = renderTable(
      [{ header: "A", align: "left" }, { header: "B" }],
      [["only"]],
    );
    expect(out.split("\n")).toEqual(["A     B", "only"]);
  });
});

describe("bucketize", () => {
  const asIs = (v: number) => String(v);

  test("returns no buckets for an empty sample", () => {
    expect(bucketize([], 4, asIs)).toEqual([]);
  });

  test("collapses a single distinct value into one bucket", () => {
    expect(bucketize([5, 5, 5], 8, asIs)).toEqual([{ label: "5", count: 3 }]);
  });

  test("splits the observed range into equal-width bins", () => {
    const buckets = bucketize([0, 1, 2, 3], 4, asIs);
    expect(buckets.map((b) => b.count)).toEqual([1, 1, 1, 1]);
    expect(buckets[0].label).toBe("0–0.75");
  });

  test("closes the last bucket on the right so the maximum lands inside", () => {
    const buckets = bucketize([0, 10], 2, asIs);
    expect(buckets.map((b) => b.count)).toEqual([1, 1]);
    expect(buckets.reduce((a, b) => a + b.count, 0)).toBe(2);
  });

  test("every value is counted exactly once", () => {
    const values = [1, 1, 2, 3, 5, 8, 13, 21, 34];
    const buckets = bucketize(values, 5, asIs);
    expect(buckets.reduce((a, b) => a + b.count, 0)).toBe(values.length);
  });

  test("emits the requested number of buckets when the range is wide", () => {
    expect(bucketize([0, 100], 8, asIs)).toHaveLength(8);
  });
});

describe("renderHistogram", () => {
  test("notes absent data instead of drawing an empty chart", () => {
    expect(renderHistogram([])).toContain("no data");
  });

  test("scales the longest bar to the largest bucket", () => {
    const out = renderHistogram([
      { label: "a", count: 10 },
      { label: "b", count: 5 },
      { label: "c", count: 0 },
    ]);
    const lines = out.split("\n");
    const bars = lines.map((l) => (l.match(/█+/)?.[0] ?? "").length);
    expect(bars[0]).toBe(40);
    expect(bars[1]).toBe(20);
    expect(bars[2]).toBe(0);
    // A zero bucket shows no count, so it cannot be mistaken for a small bar.
    expect(lines[2]).not.toMatch(/\d/);
  });

  test("gives a nonzero bucket at least one visible cell", () => {
    const out = renderHistogram([
      { label: "big", count: 1000 },
      { label: "tiny", count: 1 },
    ]);
    expect(out.split("\n")[1]).toContain("█");
  });
});
