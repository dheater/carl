/**
 * carl's read ledger as a DeepSeek Harness plugin, bundled to
 * dist/plugins/read-ledger.mjs and loaded by runtime/cordis.yml.
 *
 * It lives here rather than in the CLI because carl only ever *observes* a run:
 * it reads JSON-RPC notifications after the fact and cannot change what a tool
 * result says. `tools/post-execute` is the only seam that can, and that seam is
 * a cordis listener, so the ledger has to be inside the harness process.
 *
 * Three rules keep it honest:
 *
 *   - It rewrites `content` only, never `value`. Under Code Mode the program
 *     receives the value; a program that reads a file still gets every line.
 *   - It ignores sub-dispatches (`exec.parent`). A program's read result never
 *     reaches the model, so recording one would let the ledger claim a copy is
 *     "above" when the model never saw it.
 *   - It splices into the tool's own rendered body, found by exact match. If the
 *     upstream format ever changes, the match fails and the result passes
 *     through unchanged — the ledger never rewrites content it cannot identify.
 *
 * See src/read-ledger.ts for the ledger itself.
 */

import {
  ReadLedger,
  DEFAULT_MIN_ELIDED_LINES,
  type ReadLine,
  type ReadWindow,
} from "./read-ledger";

/** Cordis plugin name, used by loader diagnostics. */
export const name = "carl-read-ledger";

/** The model-facing tool this ledger applies to (@deepseek-ai/dsh-tool-fs). */
const READ_TOOL = "read";

/**
 * The durable session event that means earlier turns have been summarized away.
 * Once it fires, "shown earlier in this conversation" is no longer true of
 * anything the ledger remembers.
 */
const COMPACTION_START = "compaction/start";

export interface ReadLedgerConfig {
  /** Off is a supported state: it makes the ledger's cost measurable by A/B. */
  enabled?: boolean;
  /** Repeated-line count below which a result is delivered unchanged. */
  minElidedLines?: number;
}

/**
 * The slices of the harness's tool pipeline this plugin touches, typed
 * structurally. carl declares them itself so the bundled plugin pulls in no
 * @deepseek-ai types at build time; the shapes are from
 * @deepseek-ai/dsh-tools (ToolExecution, ToolExecutionResult, PostToolDecision).
 */
interface ToolExecutionLike {
  readonly name: string;
  /** Present on a Code Mode sub-dispatch, absent on a model-direct call. */
  readonly parent?: unknown;
  readonly agent?: { readonly session?: object } | undefined;
}

interface ToolResultLike {
  readonly isError: boolean;
  readonly value?: unknown;
  readonly content?: unknown;
}

interface PostToolDecisionLike {
  readonly kind: string;
  readonly content?: unknown;
  readonly value?: unknown;
  readonly additionalContexts?: unknown;
}

type PostExecuteListener = (
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
) => Promise<PostToolDecisionLike>;

type SessionEventListener = (
  session: object,
  event: { readonly type: string },
) => void;

export interface PluginContext {
  on(event: "tools/post-execute", listener: PostExecuteListener): unknown;
  on(event: "session/event", listener: SessionEventListener): unknown;
  effect(setup: () => () => void, label: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Narrow a `read` result's canonical value to a window, or decline. The shape
 * check is the ledger's guard against a differently-shaped `read`: carl cannot
 * compare tool identity from outside the registry, so it compares the contract.
 */
export function readWindowFrom(value: unknown): ReadWindow | undefined {
  if (!isRecord(value)) return undefined;
  const { path, offset, lines, totalLines } = value;
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (!isLineNumber(offset)) return undefined;
  if (typeof totalLines !== "number" || !Number.isInteger(totalLines)) {
    return undefined;
  }
  if (!Array.isArray(lines)) return undefined;

  const window: ReadLine[] = [];
  for (const line of lines) {
    if (!isRecord(line)) return undefined;
    if (!isLineNumber(line.number) || typeof line.text !== "string") {
      return undefined;
    }
    window.push({ number: line.number, text: line.text });
  }
  return { path, offset, lines: window, totalLines };
}

/** The sole text block of a result's content, or undefined if it isn't one. */
function soleTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block: unknown = content[0];
  if (!isRecord(block) || block.type !== "text") return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

/**
 * Replace the first occurrence of `body` with `replacement`, literally.
 * `String.replace` would interpret `$&` and friends in file content.
 */
export function spliceBody(
  text: string,
  body: string,
  replacement: string,
): string | undefined {
  const at = text.indexOf(body);
  if (at === -1) return undefined;
  return text.slice(0, at) + replacement + text.slice(at + body.length);
}

/**
 * True when this outcome is a model-direct, accepted, unmodified `read` success
 * — the only case the ledger may rewrite. Mirrors the eligibility gate
 * @deepseek-ai/dsh-tool-fs-search uses for its own spill rewrites.
 */
function isRewritableRead(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  decision: PostToolDecisionLike,
): boolean {
  return (
    exec.name === READ_TOOL &&
    exec.parent === undefined &&
    !result.isError &&
    decision.kind === "accept" &&
    decision.content === undefined &&
    !Object.hasOwn(decision, "value")
  );
}

/**
 * Register the ledger. One ledger per session, held weakly so a disposed
 * session's lines are collectable.
 */
export function apply(ctx: PluginContext, config: ReadLedgerConfig = {}): void {
  if (config.enabled === false) return;
  const minElidedLines = config.minElidedLines ?? DEFAULT_MIN_ELIDED_LINES;

  let ledgers = new WeakMap<object, ReadLedger>();
  ctx.effect(
    () => () => {
      ledgers = new WeakMap();
    },
    "carl-read-ledger teardown",
  );

  // Every ledger at once, not just the compacting session's: identifying "the"
  // session object across cordis's scoped service views is a guess, and
  // forgetting too much only costs one full copy while forgetting too little
  // points the model at content that is no longer there.
  ctx.on("session/event", (_session, event) => {
    if (event.type === COMPACTION_START) ledgers = new WeakMap();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (!isRewritableRead(exec, result, decision)) return decision;

    const session = exec.agent?.session;
    if (session === undefined) return decision;

    const window = readWindowFrom(result.value);
    if (window === undefined) return decision;
    const text = soleTextBlock(result.content);
    if (text === undefined) return decision;

    let ledger = ledgers.get(session);
    if (ledger === undefined) {
      ledger = new ReadLedger(minElidedLines);
      ledgers.set(session, ledger);
    }

    const verdict = ledger.consider(window);
    if (verdict.kind === "deliver") return decision;
    const rewritten = spliceBody(
      text,
      verdict.originalBody,
      verdict.replacementBody,
    );
    if (rewritten === undefined) return decision;

    return {
      kind: "accept",
      content: [{ type: "text", text: rewritten }],
      ...(decision.additionalContexts !== undefined
        ? { additionalContexts: decision.additionalContexts }
        : {}),
    };
  });
}
