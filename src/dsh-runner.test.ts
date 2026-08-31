import {
  BEDROCK_MODEL_IDS,
  DEFAULT_LOCAL_BASE_URL,
  REASONING_EFFORT,
  describeFailure,
  finalTurnReason,
  formatProgress,
  localBaseURL,
  matchesModelName,
  parseLocalModels,
  replayToolCalls,
  resolveLocalModel,
  sessionDirPath,
  summarizeArguments,
  summarizeUsage,
} from "./dsh-runner";
import type { ToolCallEvent } from "./types";

/**
 * The session events these tests build are hand-written to the shapes declared
 * by dsh-session and dsh-tools (`SessionEventMap`, `CodeDispatchEventData`,
 * `ToolResultBlock`, `TokenUsage`). They are the contract carl reads; a runtime
 * upgrade that renames a field should break here rather than silently report
 * zero tokens and no tool calls.
 */
type TestEvent = {
  type: string;
  time?: number;
  data?: Record<string, unknown>;
};

function assistantMessage(
  step: number,
  usage?: Record<string, number>,
): TestEvent {
  return {
    type: "assistant/message",
    data: {
      turn: 1,
      step,
      message: { role: "assistant", content: [] },
      ...(usage ? { usage } : {}),
    },
  };
}

function stepEnd(step: number): TestEvent {
  return { type: "step/end", data: { turn: 1, step } };
}

describe("BEDROCK_MODEL_IDS", () => {
  test("every alias maps to a bare us-prefixed inference profile id", () => {
    const ids = Object.values(BEDROCK_MODEL_IDS);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      // A bare `anthropic.*` id is refused by AWS: on-demand throughput is not
      // supported for these models, so only an inference profile invokes. And
      // the id has to be the catalog's own spelling — the pi-ai route serves
      // the installed catalog unchanged, so an inference-profile ARN naming the
      // same profile is UNKNOWN_MODEL there even though Bedrock would take it.
      expect(id).toMatch(/^us\.anthropic\.[a-z0-9.:-]+$/);
    }
  });

  test("aliases are unique per model id", () => {
    const ids = Object.values(BEDROCK_MODEL_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("REASONING_EFFORT", () => {
  test("maps carl's three levels onto pi-ai thinking levels", () => {
    expect(REASONING_EFFORT).toEqual({
      low: "minimal",
      medium: "medium",
      high: "high",
    });
  });

  test("never sends off, which pi-ai spells as omitting the parameter", () => {
    // `off` leaves the provider's own default in force rather than disabling
    // thinking, and fable-5 does not offer it at all.
    expect(Object.values(REASONING_EFFORT)).not.toContain("off");
  });
});

describe("summarizeArguments", () => {
  test("renders an object as compact one-line JSON", () => {
    expect(summarizeArguments({ file_path: "src/a.ts" })).toBe(
      '{"file_path":"src/a.ts"}',
    );
  });

  test("collapses newlines and runs of whitespace", () => {
    expect(summarizeArguments("line one\n\n  line two")).toBe(
      "line one line two",
    );
  });

  test("truncates past the limit with an ellipsis", () => {
    const summary = summarizeArguments("x".repeat(50), 10);
    expect(summary).toBe(`${"x".repeat(10)}…`);
  });

  test("does not truncate at exactly the limit", () => {
    expect(summarizeArguments("x".repeat(10), 10)).toBe("x".repeat(10));
  });

  test("renders missing arguments as empty", () => {
    expect(summarizeArguments(undefined)).toBe('""');
  });
});

describe("summarizeUsage", () => {
  test("sums token counts across every step of the interval", () => {
    const usage = summarizeUsage(
      [
        assistantMessage(1, { inputTokens: 100, outputTokens: 20 }),
        stepEnd(1),
        assistantMessage(2, { inputTokens: 300, outputTokens: 40 }),
        stepEnd(2),
      ],
      "us.anthropic.claude-sonnet-4-6",
    );

    expect(usage).toEqual({
      source: "dsh-bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      turns: 2,
      inputTokens: 400,
      outputTokens: 60,
      firstTurn: { inputTokens: 100, outputTokens: 20 },
      turnPromptTokens: [100, 300],
      compactions: 0,
    });
  });

  test("carries cache tokens when the adapter reports them", () => {
    const usage = summarizeUsage(
      [
        assistantMessage(1, {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 900,
          cacheWriteTokens: 50,
        }),
        stepEnd(1),
      ],
      "m",
    );

    expect(usage.cacheReadTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBe(50);
  });

  test("omits token fields the adapter reported nothing for", () => {
    const usage = summarizeUsage(
      [assistantMessage(1, { inputTokens: 5, outputTokens: 5 }), stepEnd(1)],
      "m",
    );

    expect(usage).not.toHaveProperty("cacheReadTokens");
    expect(usage).not.toHaveProperty("cacheWriteTokens");
  });

  test("counts model calls as turns, not the harness's single turn", () => {
    // The harness's `turn` is one whole user-message-to-idle interval and would
    // read as 1 for every carl run; steps are what the old Bedrock loop counted.
    const usage = summarizeUsage(
      [
        { type: "turn/start", data: { turn: 1 } },
        stepEnd(1),
        stepEnd(2),
        stepEnd(3),
        { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      ],
      "m",
    );

    expect(usage.turns).toBe(3);
  });

  test("reports zero turns and no tokens for an empty interval", () => {
    expect(summarizeUsage([], "m")).toEqual({
      source: "dsh-bedrock",
      modelId: "m",
      turns: 0,
      // A measured zero, unlike the token fields: "did not compact" is a finding.
      compactions: 0,
    });
  });

  test("records the first turn on its own, as the cold-start tax", () => {
    // The totals cannot separate it: turn 3 writes cache too, so a run that
    // re-primed 40k tokens and one that grew into 40k look identical summed.
    const usage = summarizeUsage(
      [
        assistantMessage(1, {
          inputTokens: 20,
          outputTokens: 5,
          cacheWriteTokens: 40_000,
        }),
        stepEnd(1),
        assistantMessage(2, {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 40_000,
          cacheWriteTokens: 300,
        }),
        stepEnd(2),
      ],
      "m",
    );

    expect(usage.firstTurn).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheWriteTokens: 40_000,
    });
    expect(usage.cacheWriteTokens).toBe(40_300);
  });

  test("records the per-turn prompt size, in request order", () => {
    const usage = summarizeUsage(
      [
        assistantMessage(1, { inputTokens: 100, cacheWriteTokens: 900 }),
        stepEnd(1),
        assistantMessage(2, { inputTokens: 50, cacheReadTokens: 1000 }),
        stepEnd(2),
      ],
      "m",
    );

    // Output is excluded: this is the size of the conversation being sent.
    expect(usage.turnPromptTokens).toEqual([1000, 1050]);
  });

  test("counts compactions, which had no reader before", () => {
    const usage = summarizeUsage(
      [
        assistantMessage(1, { inputTokens: 1 }),
        { type: "compaction/start", data: {} },
        assistantMessage(2, { inputTokens: 1 }),
        { type: "compaction/start", data: {} },
      ],
      "m",
    );

    expect(usage.compactions).toBe(2);
  });

  test("tolerates an assistant message that carries no usage", () => {
    const usage = summarizeUsage(
      [
        assistantMessage(1),
        stepEnd(1),
        assistantMessage(2, { inputTokens: 7, outputTokens: 3 }),
      ],
      "m",
    );

    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(3);
  });
});

describe("replayToolCalls", () => {
  function collect(events: TestEvent[]): ToolCallEvent[] {
    const seen: ToolCallEvent[] = [];
    replayToolCalls(events, (event) => seen.push(event));
    return seen;
  }

  test("reports an inner code dispatch under the real tool name", () => {
    const seen = collect([
      {
        type: "tool/code-dispatch-start",
        time: 1000,
        data: { subCallId: "c1:code:0", name: "read", arguments: {} },
      },
      {
        type: "tool/code-dispatch",
        time: 1250,
        data: {
          subCallId: "c1:code:0",
          name: "read",
          arguments: { file_path: "src/a.ts" },
          isError: false,
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    expect(seen).toEqual([
      {
        tool: "read",
        inputSummary: '{"file_path":"src/a.ts"}',
        outputBytes: Buffer.byteLength(
          JSON.stringify([{ type: "text", text: "hello" }]),
        ),
        durationMs: 250,
        error: false,
      },
    ]);
  });

  test("reports the outer run_code call the program arrived in", () => {
    // The outer call measures one model round-trip; the inner ones measure the
    // work the program did.
    const seen = collect([
      {
        type: "tool/call",
        time: 500,
        data: {
          callId: "c1",
          name: "run_code",
          arguments: {
            code: "await tools.grep({})",
            description: "Search src",
          },
        },
      },
      {
        type: "tool/code-dispatch",
        time: 600,
        data: {
          subCallId: "c1:code:0",
          name: "grep",
          arguments: {},
          isError: false,
          content: [],
        },
      },
      {
        type: "tool/result",
        time: 900,
        data: {
          message: {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [{ type: "text", text: "ok" }],
                isError: false,
              },
            ],
          },
        },
      },
    ]);

    expect(seen.map((e) => e.tool)).toEqual(["grep", "run_code"]);
    expect(seen[1].durationMs).toBe(400);
    // The program body is too long to log, so the model's own description is
    // what makes a run_code row mineable.
    expect(seen[1].inputSummary).toBe("Search src");
  });

  test("marks a failed dispatch as an error", () => {
    const seen = collect([
      {
        type: "tool/code-dispatch",
        data: {
          subCallId: "c1:code:0",
          name: "write",
          arguments: {},
          isError: true,
          content: [{ type: "text", text: "read-only sandbox" }],
        },
      },
    ]);

    expect(seen[0].error).toBe(true);
  });

  test("reports a direct tool call under its own name", () => {
    // Under `both` the model calls a tool directly on a turn that needs one
    // call. Recording that as run_code would merge the model's round-trips with
    // the work its programs did, which is the one ratio these rows exist for.
    const seen = collect([
      {
        type: "tool/call",
        time: 500,
        data: {
          callId: "c1",
          name: "read",
          arguments: { file_path: "src/a.ts" },
        },
      },
      {
        type: "tool/result",
        time: 700,
        data: {
          message: {
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [{ type: "text", text: "hello" }],
                isError: false,
              },
            ],
          },
        },
      },
    ]);

    expect(seen).toEqual([
      {
        tool: "read",
        inputSummary: '{"file_path":"src/a.ts"}',
        outputBytes: Buffer.byteLength(
          JSON.stringify([{ type: "text", text: "hello" }]),
        ),
        durationMs: 200,
        error: false,
      },
    ]);
  });

  test("marks a failed result as an error", () => {
    const seen = collect([
      {
        type: "tool/call",
        data: { callId: "c1", name: "run_code", arguments: "{}" },
      },
      {
        type: "tool/result",
        data: {
          message: {
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [],
                isError: true,
              },
            ],
          },
        },
      },
    ]);

    expect(seen[0]).toEqual({
      tool: "run_code",
      inputSummary: "",
      outputBytes: Buffer.byteLength("[]"),
      durationMs: undefined,
      error: true,
    });
  });

  test("names a result whose call landed in an earlier interval", () => {
    // A resumed or compacted interval can carry a settle without its call, and
    // guessing a name there would attribute the row to whichever tool was
    // guessed.
    const seen = collect([
      {
        type: "tool/result",
        data: {
          message: {
            content: [{ type: "tool-result", toolCallId: "c1", content: [] }],
          },
        },
      },
    ]);

    expect(seen[0].tool).toBe("unknown");
    expect(seen[0].inputSummary).toBe("");
  });

  test("leaves duration undefined when no start was recorded", () => {
    // A resumed or compacted interval can carry a settle without its start.
    const seen = collect([
      {
        type: "tool/code-dispatch",
        time: 1000,
        data: {
          subCallId: "orphan",
          name: "read",
          arguments: {},
          isError: false,
          content: [],
        },
      },
    ]);

    expect(seen[0].durationMs).toBeUndefined();
  });

  test("ignores events that are not tool activity", () => {
    expect(
      collect([
        { type: "turn/start", data: { turn: 1 } },
        assistantMessage(1, { inputTokens: 1, outputTokens: 1 }),
        { type: "session/title", data: { title: "x" } },
      ]),
    ).toEqual([]);
  });
});

describe("formatProgress", () => {
  test("names the tool and arguments of a code-mode sub-dispatch", () => {
    expect(
      formatProgress({
        type: "tool/code-dispatch-start",
        data: {
          subCallId: "c1:code:0",
          name: "read",
          arguments: { file_path: "src/a.ts" },
        },
      }),
    ).toBe('read {"file_path":"src/a.ts"}');
  });

  test("stays silent for the run_code wrapper its sub-calls already describe", () => {
    expect(
      formatProgress({
        type: "tool/call",
        data: { callId: "c1", name: "run_code", arguments: "{}" },
      }),
    ).toBeUndefined();
  });

  test("reports a native tool call that is not run_code", () => {
    expect(
      formatProgress({
        type: "tool/call",
        data: { callId: "c1", name: "bash", arguments: '{"command":"ls"}' },
      }),
    ).toBe('bash {"command":"ls"}');
  });

  test("reports both reasoning and visible text from the assistant", () => {
    expect(
      formatProgress({
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "secret deliberation" },
              { type: "text", text: "Reading  the\nrunner" },
            ],
          },
        },
      }),
    ).toBe("secret deliberation Reading the runner");
  });

  test("stays silent for an assistant message with no visible text", () => {
    expect(
      formatProgress({
        type: "assistant/message",
        data: { message: { role: "assistant", content: [] } },
      }),
    ).toBeUndefined();
  });

  test("truncates a long line so it fits one terminal row", () => {
    const line = formatProgress({
      type: "assistant/message",
      data: {
        message: { content: [{ type: "text", text: "x".repeat(500) }] },
      },
    });
    expect(line).toBe(`${"x".repeat(120)}…`);
  });

  test("announces a failed sub-dispatch but not a successful one", () => {
    const failed = {
      subCallId: "c1:code:0",
      name: "write",
      arguments: {},
      content: [],
    };
    expect(
      formatProgress({
        type: "tool/code-dispatch",
        data: { ...failed, isError: true },
      }),
    ).toBe("write failed");
    expect(
      formatProgress({
        type: "tool/code-dispatch",
        data: { ...failed, isError: false },
      }),
    ).toBeUndefined();
  });

  test("breaks the silence of a long model request", () => {
    expect(
      formatProgress({ type: "step/start", data: { turn: 1, step: 2 } }),
    ).toBe("thinking…");
  });

  test("counts a provider retry", () => {
    expect(
      formatProgress({
        type: "llm/retry",
        data: { retry: 2, maxRetries: 5, provider: "amazon-bedrock" },
      }),
    ).toBe("model request failed, retrying (2/5)…");
  });

  test("stays silent for events a watching human gains nothing from", () => {
    expect(
      formatProgress({ type: "session/title", data: { title: "x" } }),
    ).toBeUndefined();
    expect(
      formatProgress({ type: "turn/start", data: { turn: 1 } }),
    ).toBeUndefined();
  });
});

describe("finalTurnReason", () => {
  test("returns the last turn's reason", () => {
    const reason = finalTurnReason([
      { type: "turn/end", data: { turn: 1, reason: { kind: "error" } } },
      { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    ]);

    expect(reason).toEqual({ kind: "completed" });
  });

  test("returns undefined when the interval logged no turn end", () => {
    expect(
      finalTurnReason([{ type: "turn/start", data: { turn: 1 } }]),
    ).toBeUndefined();
  });
});

describe("sessionDirPath", () => {
  const root = "/home/user/.config/carl/sessions";

  test("encodes a Unix workspace path to the expected project directory", () => {
    // /Users/alice/src/myproject → --Users-alice-src-myproject--
    const p = sessionDirPath(
      root,
      "/Users/alice/src/myproject",
      "session-abc123",
    );
    expect(p).toBe(
      "/home/user/.config/carl/sessions/--Users-alice-src-myproject--/session-abc123",
    );
  });

  test("collapses consecutive separators into a single dash", () => {
    // The leading / and each / between segments each become a dash; runs of
    // dashes collapse. The leading dash is stripped by the replace(/^-+/, "").
    const p = sessionDirPath(root, "/a/b/c", "sid");
    expect(p).toBe("/home/user/.config/carl/sessions/--a-b-c--/sid");
  });

  test("encodes a session id that contains only safe characters unchanged", () => {
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const p = sessionDirPath(root, "/ws", id);
    expect(p).toContain(id);
  });

  test("escapes unsafe characters in the session id", () => {
    // A session id that contains '~' must be escaped to avoid ambiguity.
    const p = sessionDirPath(root, "/ws", "a~b");
    expect(p).toContain("a~007Eb");
  });
});

describe("describeFailure", () => {
  test("names the output-token ceiling plainly", () => {
    expect(describeFailure({ kind: "max-tokens" })).toBe(
      "The model hit its output token limit before finishing the skill.",
    );
  });

  test("carries the structured failure's message and code", () => {
    expect(
      describeFailure({
        kind: "error",
        error: { message: "AccessDeniedException", code: "PROVIDER_ERROR" },
      }),
    ).toBe(
      "The agent turn ended as error (PROVIDER_ERROR): AccessDeniedException",
    );
  });

  test("describes a reason that carries no error detail", () => {
    expect(describeFailure({ kind: "aborted" })).toBe(
      "The agent turn ended as aborted",
    );
  });

  test("does not claim a kind it was not given", () => {
    expect(describeFailure({})).toBe("The agent turn ended as unknown");
  });
});

describe("localBaseURL", () => {
  test("defaults to the address the local server serves on", () => {
    expect(localBaseURL({})).toBe(DEFAULT_LOCAL_BASE_URL);
  });

  test("takes the configured endpoint", () => {
    expect(
      localBaseURL({ CARL_LOCAL_BASE_URL: "http://gpu.lan:9000/v1" }),
    ).toBe("http://gpu.lan:9000/v1");
  });

  test("treats a blank setting as unset rather than as an empty endpoint", () => {
    expect(localBaseURL({ CARL_LOCAL_BASE_URL: "  " })).toBe(
      DEFAULT_LOCAL_BASE_URL,
    );
  });
});

describe("parseLocalModels", () => {
  // The shape mtplx actually returns; a rename upstream should break here
  // rather than silently size the model with carl's fallback capacities.
  test("reads mtplx's listing, including its context length", () => {
    expect(
      parseLocalModels({
        object: "list",
        data: [
          {
            id: "mtplx-qwen38-27b-optimized-speed",
            object: "model",
            owned_by: "mtplx",
            context_length: 57344,
            max_context_length: 57344,
            max_model_len: 57344,
          },
        ],
      }),
    ).toEqual([
      { id: "mtplx-qwen38-27b-optimized-speed", contextWindow: 57344 },
    ]);
  });

  test("reads the other spellings servers use for the same capacities", () => {
    expect(
      parseLocalModels({
        data: [
          { id: "a", context_window: 8192, max_output_tokens: 1024 },
          { id: "b", max_model_len: 4096, max_tokens: 512 },
        ],
      }),
    ).toEqual([
      { id: "a", contextWindow: 8192, maxTokens: 1024 },
      { id: "b", contextWindow: 4096, maxTokens: 512 },
    ]);
  });

  test("leaves capacities absent when the listing discloses only ids", () => {
    expect(parseLocalModels({ data: [{ id: "bare" }] })).toEqual([
      { id: "bare" },
    ]);
  });

  test("skips unusable entries instead of dropping the whole listing", () => {
    expect(
      parseLocalModels({
        data: [{ id: "" }, { id: 7 }, null, { id: "real" }],
      }),
    ).toEqual([{ id: "real" }]);
  });

  test("reads nothing from a body with no data array", () => {
    expect(parseLocalModels({ error: "not found" })).toEqual([]);
    expect(parseLocalModels(undefined)).toEqual([]);
  });

  test("ignores a capacity that is not a usable size", () => {
    expect(
      parseLocalModels({
        data: [{ id: "a", context_length: 0, max_tokens: "lots" }],
      }),
    ).toEqual([{ id: "a" }]);
  });
});

describe("matchesModelName", () => {
  // mtplx's cache spelling and its served spelling disagree about where `mtplx`
  // goes, so neither is a substring of the other and only order-free matching
  // recognizes that a served model came from a given cached pack.
  test("links mtplx's served spelling back to its cache spelling", () => {
    expect(
      matchesModelName(
        "mtplx-qwen35-9b-optimized-speed",
        "Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed",
      ),
    ).toBe(true);
  });

  test("takes the part of the name that identifies the model", () => {
    expect(
      matchesModelName("qwen38-27b", "mtplx-qwen38-27b-optimized-speed"),
    ).toBe(true);
    expect(matchesModelName("qwen3.8-27b", "mtplx-qwen38-27b-speed")).toBe(
      true,
    );
  });

  test("holds every part of the name against the id", () => {
    expect(matchesModelName("qwen35-9b", "mtplx-qwen38-27b")).toBe(false);
    expect(matchesModelName("qwen38-27b-tuned", "mtplx-qwen38-27b")).toBe(
      false,
    );
  });
});

describe("resolveLocalModel", () => {
  const served = [
    { id: "mtplx-qwen38-27b-optimized-speed", contextWindow: 57344 },
    { id: "mtplx-qwen38-8b", contextWindow: 32768 },
  ];

  test("resolves the full id the server reports", () => {
    expect(resolveLocalModel("mtplx-qwen38-8b", served)).toBe(served[1]);
  });

  test("resolves the part of the id that identifies the model", () => {
    expect(resolveLocalModel("qwen38-27b", served)).toBe(served[0]);
  });

  test("ignores case, since a listing's casing is the server's business", () => {
    expect(resolveLocalModel("QWEN38-8B", served)).toBe(served[1]);
  });

  test("answers nothing for a model this server does not serve", () => {
    expect(resolveLocalModel("sonnet4.6", served)).toBeUndefined();
    expect(resolveLocalModel("qwen38-27b", [])).toBeUndefined();
  });

  // Picking one arbitrarily would change which model ran without changing
  // anything the config says, so the run stops and names the candidates.
  test("refuses a name that fits several models", () => {
    expect(() => resolveLocalModel("qwen38", served)).toThrow(
      /matches more than one model/,
    );
    expect(() => resolveLocalModel("qwen38", served)).toThrow(
      /mtplx-qwen38-27b-optimized-speed/,
    );
  });
});
