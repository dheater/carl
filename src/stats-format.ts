/**
 * Pure formatting helpers for `carl stats`. No DB or filesystem access, so the
 * report layout is unit-testable in isolation.
 */

/**
 * Linear-interpolated percentile over unsorted numbers. Returns null for an
 * empty sample so callers render "no data" rather than a misleading zero.
 */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function mean(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** Placeholder for a metric with no data, so absent never reads as zero. */
export const NO_DATA = "—";

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return NO_DATA;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return NO_DATA;
  const secs = ms / 1000;
  // Tool calls finish in milliseconds; rounding those to "0s" would read as
  // unmeasured rather than fast.
  if (secs < 1) return `${Math.round(ms)}ms`;
  if (secs < 60) return `${secs.toFixed(0)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  if (mins < 60) return `${mins}m${String(rem).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${String(mins % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return NO_DATA;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return NO_DATA;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatPercent(
  fraction: number | null | undefined,
  digits = 0,
): string {
  if (fraction == null) return NO_DATA;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export type Column = {
  header: string;
  /** Right-align numbers, left-align labels. */
  align?: "left" | "right";
};

/**
 * Renders a fixed-width table. Column widths come from the widest cell, so
 * output stays aligned without assuming terminal width.
 */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const pad = (text: string, i: number): string =>
    columns[i].align === "left"
      ? text.padEnd(widths[i])
      : text.padStart(widths[i]);

  const lines = [
    columns.map((c, i) => pad(c.header, i)).join("  "),
    ...rows.map((row) =>
      columns.map((_, i) => pad(row[i] ?? "", i)).join("  "),
    ),
  ];
  return lines.map((l) => l.trimEnd()).join("\n");
}

export type HistogramBucket = {
  label: string;
  count: number;
};

/**
 * Buckets values into `bucketCount` equal-width bins across the observed range.
 * Equal-width (rather than quantile) bins keep the x-axis readable as a scale.
 */
export function bucketize(
  values: number[],
  bucketCount: number,
  formatEdge: (v: number) => string,
): HistogramBucket[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];

  const min = Math.min(...finite);
  const max = Math.max(...finite);

  // A single distinct value has no range to divide; show it as one bucket
  // rather than emitting bucketCount-1 empty bins.
  if (min === max) {
    return [{ label: formatEdge(min), count: finite.length }];
  }

  const width = (max - min) / bucketCount;
  const buckets: HistogramBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = min + i * width;
    const hi = i === bucketCount - 1 ? max : lo + width;
    buckets.push({
      label: `${formatEdge(lo)}–${formatEdge(hi)}`,
      count: 0,
    });
  }

  for (const v of finite) {
    // Last bucket is closed on the right so the maximum lands inside it.
    const idx = Math.min(bucketCount - 1, Math.floor((v - min) / width));
    buckets[idx].count++;
  }
  return buckets;
}

const BAR_CHAR = "█";
const MAX_BAR_WIDTH = 40;

/**
 * ASCII bar chart. Bars scale to the largest bucket, so the shape of the
 * distribution is visible regardless of absolute counts.
 */
export function renderHistogram(buckets: HistogramBucket[]): string {
  if (buckets.length === 0) return `  (no data)`;

  const labelWidth = Math.max(...buckets.map((b) => b.label.length));
  const maxCount = Math.max(...buckets.map((b) => b.count));

  return buckets
    .map((b) => {
      const width =
        maxCount === 0 || b.count === 0
          ? 0
          : Math.max(1, Math.round((b.count / maxCount) * MAX_BAR_WIDTH));
      return `  ${b.label.padStart(labelWidth)}  ${BAR_CHAR.repeat(width)}${
        b.count > 0 ? ` ${b.count}` : ""
      }`;
    })
    .join("\n");
}

/**
 * Renders a labeled histogram section, or a "no data" note when the metric was
 * never recorded — silence would read as "zero cost" instead of "unmeasured".
 */
export function renderHistogramSection(
  title: string,
  values: number[],
  formatEdge: (v: number) => string,
  bucketCount = 8,
): string {
  const buckets = bucketize(values, bucketCount, formatEdge);
  return `${title}\n${renderHistogram(buckets)}`;
}
