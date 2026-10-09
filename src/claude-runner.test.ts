import {
  BEDROCK_MODEL_IDS,
  RunRecorder,
  USAGE_SOURCE,
  buildQueryOptions,
  describeFailure,
  type SdkMessage,
} from "./claude-runner";
import type { ToolCallEvent } from "./types";

/**
 * The SDK messages these tests build are hand-written to the shapes the Agent
 * SDK declares (`SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`).
 * They are the contract carl reads; an SDK upgrade that renames a field should
 * break here rather than silently report zero tokens and no tool calls.
 */
function assistant(
  id: string,
  content: unknown[],
  usage: Record<string, number> = {},
): SdkMessage {
  return {
    type: "assistant",
    message: { id, content: content as never, usage },
  };
}

function toolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): SdkMessage {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ] as never,
    },
  };
}

function success(modelUsage: SdkMessage["modelUsage"] = {}): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the answer",
    terminal_reason: "completed",
    modelUsage,
  };
}

describe("BEDROCK_MODEL_IDS", () => {
  test("every alias maps to a us-prefixed inference profile id", () => {
    const ids = Object.values(BEDROCK_MODEL_IDS);
    expect(ids.length).toBeGreaterThan(0);
    // A bare `anthropic.*` id is refused by AWS: on-demand throughput is not
    // supported for these models, so only an inference profile invokes.
    for (const id of ids) expect(id).toMatch(/^us\.anthropic\.[a-z0-9.:-]+$/);
  });

  test("aliases are unique per model id", () => {
    const ids = Object.values(BEDROCK_MODEL_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildQueryOptions", () => {
  const base = {
    workspaceRoot: "/work",
    modelId: "us.anthropic.claude-sonnet-4-6",
    persona: "# Rules",
    effort: "default" as const,
  };

  test("a read-only run gets no write tools and a sandbox that refuses the workspace", () => {
    const options = buildQueryOptions({ ...base, readOnly: true });
    expect(options.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(options.sandbox?.failIfUnavailable).toBe(true);
    expect(options.sandbox?.filesystem?.denyWrite).toEqual(["/work"]);
  });

  test("a writable run gets edit and write", () => {
    const options = buildQueryOptions({ ...base, readOnly: false });
    expect(options.tools).toEqual(expect.arrayContaining(["Edit", "Write"]));
  });

  test("default effort sends none; any other level is passed through", () => {
    expect(
      buildQueryOptions({ ...base, readOnly: true }).effort,
    ).toBeUndefined();
    expect(
      buildQueryOptions({ ...base, readOnly: true, effort: "high" }).effort,
    ).toBe("high");
  });
});

describe("RunRecorder", () => {
  function recorder() {
    let clock = 1000;
    const progress: string[] = [];
    const calls: ToolCallEvent[] = [];
    const rec = new RunRecorder(
      "us.anthropic.claude-sonnet-4-6",
      (line) => progress.push(line),
      (event) => calls.push(event),
      () => clock,
    );
    return {
      rec,
      progress,
      calls,
      tick: (ms: number) => (clock += ms),
    };
  }

  test("pairs a tool call with its result and times it", () => {
    const { rec, calls, tick } = recorder();
    rec.record(
      assistant("m1", [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
      ]),
    );
    tick(250);
    rec.record(toolResult("t1", "1\tline"));

    expect(calls).toEqual([
      {
        tool: "read",
        inputSummary: '{"file_path":"a"}',
        outputBytes: Buffer.byteLength("1\tline"),
        durationMs: 250,
        error: false,
        errorMessage: undefined,
      },
    ]);
  });

  test("a failed tool result carries its text", () => {
    const { rec, calls, progress } = recorder();
    rec.record(
      assistant("m1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } },
      ]),
    );
    rec.record(toolResult("t1", "command not found", true));
    expect(calls[0].error).toBe(true);
    expect(calls[0].errorMessage).toBe("command not found");
    expect(progress).toContain("bash failed");
  });

  test("a result for a call it never saw is filed as unknown", () => {
    const { rec, calls } = recorder();
    rec.record(toolResult("t9", "x"));
    expect(calls[0].tool).toBe("unknown");
  });

  test("prints thinking once every pending call has settled", () => {
    const { rec, progress } = recorder();
    rec.start();
    rec.record(
      assistant("m1", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ]),
    );
    rec.record(toolResult("t1", ""));
    rec.record(toolResult("t2", ""));
    expect(progress.filter((line) => line === "thinking…")).toHaveLength(2);
  });

  test("counts one turn per model request, not per streamed block", () => {
    const { rec } = recorder();
    const first = { input_tokens: 10, cache_creation_input_tokens: 7000 };
    rec.record(assistant("m1", [{ type: "thinking" }], first));
    rec.record(
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Read" }], first),
    );
    rec.record(
      assistant("m2", [{ type: "text", text: "done" }], {
        input_tokens: 5,
        cache_read_input_tokens: 7000,
        cache_creation_input_tokens: 300,
      }),
    );
    rec.record(success());

    const usage = rec.usage();
    expect(usage.turns).toBe(2);
    expect(usage.firstTurn).toEqual({
      inputTokens: 10,
      cacheWriteTokens: 7000,
    });
    expect(usage.turnPromptTokens).toEqual([7010, 7305]);
  });

  test("totals come from the result's per-model usage", () => {
    const { rec } = recorder();
    rec.record(
      success({
        a: {
          inputTokens: 17,
          outputTokens: 281,
          cacheReadInputTokens: 7720,
          cacheCreationInputTokens: 9047,
        },
        b: { inputTokens: 3, outputTokens: 19 },
      }),
    );
    const usage = rec.usage(1234);
    expect(usage).toMatchObject({
      source: USAGE_SOURCE,
      modelId: "us.anthropic.claude-sonnet-4-6",
      inputTokens: 20,
      outputTokens: 300,
      cacheReadTokens: 7720,
      cacheWriteTokens: 9047,
      latencyMs: 1234,
      compactions: 0,
    });
  });

  test("a stream that ended without a result totals its per-request usage", () => {
    const { rec } = recorder();
    rec.record(
      assistant("m1", [{ type: "text", text: "a" }], {
        input_tokens: 10,
        output_tokens: 40,
        cache_creation_input_tokens: 7000,
      }),
    );
    rec.record(
      assistant("m2", [{ type: "text", text: "b" }], {
        input_tokens: 5,
        output_tokens: 60,
        cache_read_input_tokens: 7000,
      }),
    );
    expect(rec.usage()).toMatchObject({
      inputTokens: 15,
      outputTokens: 100,
      cacheReadTokens: 7000,
      cacheWriteTokens: 7000,
    });
  });

  test("counts compactions", () => {
    const { rec } = recorder();
    rec.record({ type: "system", subtype: "compact_boundary" });
    expect(rec.usage().compactions).toBe(1);
  });

  test("the outcome is the result text on success", () => {
    const { rec } = recorder();
    rec.record(success());
    expect(rec.outcome()).toEqual({ text: "the answer" });
  });

  test("a stream with no result is a failure", () => {
    const { rec } = recorder();
    expect(rec.outcome()).toEqual({
      failure: "The agent ended without a result.",
    });
  });
});

describe("describeFailure", () => {
  test("names the turn limit plainly", () => {
    expect(
      describeFailure({ type: "result", subtype: "error_max_turns" }),
    ).toMatch(/hit its 80-turn limit/);
  });

  test("carries the terminal reason and the errors", () => {
    expect(
      describeFailure({
        type: "result",
        subtype: "error_during_execution",
        terminal_reason: "api_error",
        errors: ["AccessDeniedException"],
      }),
    ).toBe("The agent turn ended as api_error: AccessDeniedException");
  });

  test("an API error reported as a success result keeps its text", () => {
    expect(
      describeFailure({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        result: "Throttled",
      }),
    ).toBe("The agent turn ended as api_error: Throttled");
  });
});
