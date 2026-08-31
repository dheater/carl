# What one-shot context costs, and what it buys

_Draft. Numbers from one developer's log, 2026-07-20 to 2026-08-31._

Most coding agents keep one conversation alive across many prompts. carl does the
opposite: it spawns a fresh runtime per skill run, hands it a persona and an
instruction, and throws the conversation away. The human is the thing that
carries state from one run to the next.

That is a real trade and it is usually argued from first principles. I have 672
runs of it in a log, so this is the arithmetic instead.

## The data, and its limits

`~/.config/carl/events.jsonl`: 672 runs across 15 workspaces over six weeks,
$303.35 of Bedrock spend, mostly Sonnet 4.6. 527 of the runs are the `code`
skill, at 16.8 turns and $0.51 each on average.

Two limitations dominate everything below, so they go first.

**This log has one arm.** carl always starts over. Nothing here compares carl
against a preserved-context harness doing the same work, because there is no such
log. What the data can do is price the two sides separately and measure decay
_within_ a run — where the task, the repository, and the model are all held fixed
by construction. Every cross-arm number in this piece is a bound with a method
attached, not a measurement.

**Some of the instrumentation is younger than the log.** Token totals, turn
counts, durations, tool calls, and run outcomes go back to the first run. Per-turn
detail — what turn 1 specifically cost, peak prompt size, compaction counts —
started recording on the last day, so it covers two runs. Where a number rests on
that, I say so and treat it as an anecdote.

## Cost: history is the bill

The headline is not close.

|                                            | tokens      |
| ------------------------------------------ | ----------- |
| Cache reads (re-sent conversation history) | 515,292,252 |
| Cache writes                               | 26,503,578  |
| Fresh input                                | 81,621      |
| Output                                     | 3,150,643   |

**95% of billed input tokens are conversation history being re-sent.** Model
output is 0.58% of all tokens that moved. Nearly everything an agent pays for is
the cost of remembering what it already said.

And it compounds with run length:

| turns | runs | history as % of billed input | history re-sent per turn | $/run |
| ----- | ---- | ---------------------------- | ------------------------ | ----- |
| 1–5   | 174  | 64%                          | 9.3k                     | $0.08 |
| 6–10  | 174  | 84%                          | 16.5k                    | $0.18 |
| 11–20 | 149  | 92%                          | 34.3k                    | $0.39 |
| 21–40 | 86   | 96%                          | 60.4k                    | $0.97 |
| 41+   | 53   | 98%                          | 84.1k                    | $2.22 |

A 60-turn run re-sends 84,000 tokens _per turn_. Nothing about that is carl
specific — it is what a growing conversation costs anyone.

So what does throwing the conversation away save? Take each sitting of runs in
one workspace (gap ≤ 30 min), estimate what each run _adds_ to a conversation
(model output plus tool-result bytes at 4 bytes/token), and charge a preserved
session cache-read on that accumulation for every turn of every later run in the
sitting. Across 450 repeat runs, the mean inherited context at turn 1 would be
**121,000 tokens**, and the extra cost is **about $302 — roughly a doubling** of
the $303 actually spent.

Stated honestly: that is an upper bound, because it assumes a preserved session
never compacts. A harness that sheds context aggressively pays less than double
and gets a different quality profile instead. It is also an estimate of _added
content_, not a measurement of it.

### The other direction, and why I can't price it yet

The cost carl pays for starting over is the _rate difference_ on turn 1: fresh
input and cache write on a prefix a live session would have read at cache-read
rates. I only started recording per-turn detail on 2026-08-31, so **two runs in
this log carry it**, and one of them is a repeat. That is an anecdote, not a
measurement, and I am reporting it as one.

The anecdote: the tax on that run was **$0.0008**, because **89% of its turn-1
tokens arrived as cache reads.** The mechanism is real even if the sample is not —
the provider's prompt cache outlives carl's subprocess, so a run started minutes
after the last one finds its persona prefix still warm and reads it at cache-read
rates despite the fresh conversation. If that generalizes, starting over costs you
the conversation and not the prefix, and the entire cost argument against one-shot
collapses to the ~$302 above with nothing on the other side of the ledger. Ask me
again in a month.

## Speed: not where I expected

The obvious objection to one-shot is re-reading. A fresh run has to re-discover
files an earlier run already read. In this log, 708 of 2,004 attributed file
reads (35%) are of a file an earlier run in the same sitting had already read.

The wall clock on that: every file read carl has ever done, 2,341 of them,
totals **5.7 seconds**. Reads average 3.4 ms. Filesystem re-reading is free.

The real cost is a round trip, not a syscall. A repeat run spends roughly one
extra turn re-orienting, and a `code` turn averages 8.2 seconds — so call it
**~8 seconds per repeat run**, and it never compounds, because it happens once at
the start.

Set that against what run length does to the clock:

| turns | mean duration |
| ----- | ------------- |
| 1–5   | 41 s          |
| 6–10  | 63 s          |
| 11–20 | 109 s         |
| 21–40 | 265 s         |
| 41+   | 489 s         |

Eight seconds of re-orientation versus a run that grows to eight minutes. Speed
is not the axis on which this trade is decided.

## Quality: the interesting one

This is the claim people actually care about — does a fresh context produce
better work than a long one? A single-arm log cannot answer that directly. What
it _can_ do is ask whether a conversation gets worse at using its own context as
that context grows, measured within one run by comparing its early tool calls to
its late ones. Same task, same repo, same model; only position varies.

Over the 251 runs with 20+ tool calls (11,221 calls), split into fifths:

|                                         | 1st  | 2nd   | 3rd   | 4th   | 5th   |
| --------------------------------------- | ---- | ----- | ----- | ----- | ----- |
| Reads of a file already read this run   | 3.3% | 19.1% | 29.6% | 55.1% | 66.3% |
| Tool error rate                         | 4.2% | 3.3%  | 5.9%  | 7.8%  | 8.8%  |
| Tool error rate, tool mix held constant | 5.7% | 3.6%  | 5.8%  | 7.3%  | 7.6%  |

The first row is the one I trust most. By the last fifth of a long run, **two in
three file reads are of a file the model has already been shown in that same
conversation.** The content is demonstrably in context and it fetched it again.
That is context rot measured rather than asserted.

The second row needs a caveat, and it is the reason for the third. Tool mix
shifts hard across a run — reads give way to bash — and bash fails more than
reads do, so some of the raw rise is mix, not decay. Holding mix at the period's
overall mix (direct standardization, thin cells dropped) barely changes the
trough-to-peak climb, 2.7× to 2.1×. What it changes is the _shape_: the
adjustment lifts the first fifth from 4.2% to 5.7%, because the raw first fifth
is diluted by reads, which never fail. First-to-last therefore drops from 2.1× to
1.3× while trough-to-peak holds. **The late rise survives the mix adjustment; the
apparently clean start does not.**

Where it is unambiguous is within a single tool, where mix cannot confound
anything:

| tool                    | 1st  | 2nd  | 3rd  | 4th  | 5th   |
| ----------------------- | ---- | ---- | ---- | ---- | ----- |
| bash (7,104 calls)      | 6.3% | 4.7% | 7.5% | 9.4% | 10.7% |
| str_replace (947 calls) | 7.7% | 0.8% | 2.1% | 2.3% | 2.3%  |
| read (485 calls)        | 1.4% | 0%   | 0%   | 0%   | 0%    |

bash more than doubles, 4.7% to 10.7%. Editing triples off its second-fifth
trough. Reading never fails, which is why it dilutes the adjusted row. Note also
that both tools are _worst in the first fifth or second-worst there_ — early
failures are a warm-up cost (wrong path, wrong assumption), and they are a
different phenomenon from late decay. Any honest reading of these series has a U
in it, not a ramp.

The bluntest quality signal is whole-run failure:

| turns | runs | failed |
| ----- | ---- | ------ |
| 1–5   | 174  | 13.2%  |
| 6–10  | 174  | 1.1%   |
| 11–20 | 149  | 0%     |
| 21–40 | 86   | 0%     |
| 41+   | 53   | 15.1%  |

(636 of the 672 runs recorded a turn count; the other 36 died early enough that
they have none. 33 of the log's 49 failures are in the table above.)

U-shaped, and the two arms are different failures. The 1–5 band is runs that
crashed on startup and never got going. The 41+ band is runs that went long and
fell over. Between 6 and 40 turns, essentially nothing fails.

## What this actually says

One-shot context does not _avoid_ context rot. Rot is a function of conversation
length, and a one-shot run has a conversation. What one-shot does is **bound**
it: every run starts at zero and the ceiling is one run's worth of growth instead
of a day's.

That reframes the lever. The question is not fresh-versus-preserved. It is **how
long you let a single conversation get**, and one-shot is one way — a coarse,
human-gated way — of keeping that number small. A preserved-context harness with
aggressive compaction is chasing the same variable from the other direction.

Which means the useful engineering follows from the 6-to-40-turn window, not from
the architecture argument:

- A turn cap is a quality feature, not a safety net. The 41+ band is 8% of runs
  and 39% of spend ($117 of $303), and it holds every single failure that was not
  a startup crash.
- Anything that keeps a run short is worth more than anything that makes a long
  run cheaper.
- Two thirds of late reads being redundant is a straightforwardly fixable waste,
  and it is concentrated exactly where runs fail.

## What I would measure next

The gaps I know about, in order of how much they'd change the above:

1. **A second arm.** Everything cross-arm here is a bound. Running the same task
   set through a preserved-context harness would replace three estimates with
   measurements.
2. **Whether elision moves the curves.** carl now suppresses re-reads of unchanged
   lines within a session. The prediction is that it flattens the revisit row; if
   the error rows do not follow, the revisit row was a symptom and not a cause.
3. **The U, properly.** Early failures and late failures are being treated as one
   series in the adjusted row and they are not one phenomenon.
4. **Cost of the counterfactual under compaction.** The doubling assumes a
   preserved session never sheds context, which no real harness does.

Reproduce any of it with `carl stats --all` — the "One-shot context" and "Within
a run" sections are the two tables above, computed from the log rather than typed
in by hand.
