# Metrics & SLOs

**Enforcement:** Not yet automated

**TODO:**
- Detect performance regressions (compare against baseline)
- Detect memory usage violations (RSS, allocations)
- Detect latency target violations (p50, p99)

## Principle

Always measure: latency (p50/p95/p99), throughput, memory, CPU. Projects set thresholds per metric (including zero = no target). Regressions beyond declared SLOs are release blockers. Use profilers/sanitizers before architectural changes.

---

## Why

- **Measure to improve** - Can't optimize what you don't measure
- **Prevent regressions** - Catch performance degradation early
- **Validate changes** - Prove optimizations work
- **Avoid premature optimization** - Profile before rewriting

---

## Key Metrics (Always Considered)

| Metric | What | When |
|--------|------|------|
| **Latency** | p50, p95, p99 per critical operation | All user-facing operations |
| **Throughput** | ops/sec or bytes/sec | Sustained workloads |
| **Memory** | Steady-state footprint + peak | Representative load |
| **CPU** | Utilization under load | Avoid spin/contention |

---

## Setting Thresholds

**Document per project:** Target values (or 0 = no gate), methodology, workload

```yaml
latency: { connect_p95: 100ms, auth_p95: 50ms }
throughput: { sustained_mbps: 1000 }
memory: { steady_state_mb: 50, peak_mb: 100 }
cpu: { max_utilization: 80% }
experimental_feature_p95: 0  # Measure, don't block
```

---

## Instrumentation

**Minimal overhead:** Zero-cost counters, low-overhead timers at seams

```zig
var errors: std.atomic.Atomic(u64) = .{ .value = 0 };
errors.fetchAdd(1, .Monotonic);

const start = std.time.nanoTimestamp();
defer recordLatency("connect", std.time.nanoTimestamp() - start);
```

**Expose at seams:**
```c
typedef struct LibMetrics {
    uint64_t total_connections, failed_connections;
    uint64_t bytes_sent, bytes_received;
    uint64_t p50_latency_ns, p95_latency_ns, p99_latency_ns;
} LibMetrics;
```

---

## Repro Harness

**Simple, scripted benchmark (<5 min, representative, stable):**
```bash
./app --benchmark --connections 100 --duration 60s > metrics.json
```

**Avoid:** Synthetic microbenchmarks, unrealistic workloads, non-deterministic scenarios

---

## CI Checks

```bash
# Optional gating
carl check-slos --baseline baseline.json --current current.json

# Minimum: publish metrics
./benchmark.sh > metrics-${GIT_SHA}.json
```

---

## Performance Debugging

**Profile before architectural changes:**
```bash
perf record -g ./app --benchmark && perf report
valgrind --tool=massif ./app --benchmark
zig build -Dsanitize=address
```

**Document wins:**
```
Optimization: Hash map instead of linear search
Before: p95=150ms, CPU=95%
After: p95=12ms, CPU=45%
Improvement: 12.5x latency, 2.1x CPU
```

**Avoid premature optimization:** Profile → identify bottleneck → optimize specific path

---

## Checklists

**Adding SLOs:**
- [ ] Metrics identified, thresholds set
- [ ] Repro harness (<5 min, representative)
- [ ] Baseline captured, CI publishes metrics

**Optimizing:**
- [ ] Profiled, bottleneck identified
- [ ] Baseline captured, improvement documented
- [ ] No regressions in other metrics



---

## Enforcement

**Automated:** `carl check-slos`, `carl check-benchmark`

**Code review:** Performance claims have numbers? Baseline captured? Profiling done?

---

## References

- `plans/metrics-and-slos.md`
- `carl/rules/subtract-first.md`

