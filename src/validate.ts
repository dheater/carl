import { spawnSync } from "child_process";

/**
 * Deterministic validation of a skill's work.
 *
 * Carl runs the project's own check command itself rather than asking the model
 * whether it is done. Whether the tests pass is a fact about the workspace, and
 * a `spawnSync` answers it for free; a model's claim that it validated is a
 * report about a fact, and the two come apart exactly when it matters most.
 */

/**
 * How much of a failing command's output the model gets to see. Test runners
 * print the failures last, so the tail is the informative end; a full suite log
 * can run to megabytes and would crowd out the code under repair.
 */
export const VALIDATION_OUTPUT_LIMIT = 8000;

/** Enough for a real suite, short of hanging carl until the human notices. */
export const VALIDATION_TIMEOUT_MS = 15 * 60 * 1000;

/** 1 MB (Node's default) is small for a verbose suite; the tail is cut later. */
const VALIDATION_MAX_BUFFER = 16 * 1024 * 1024;

export type ValidationResult = {
  command: string;
  ok: boolean;
  /** null when the command was killed rather than exited. */
  exitCode: number | null;
  /**
   * True when the command was killed at VALIDATION_TIMEOUT_MS. Carl does not
   * retry these: `spawnSync` discards a killed command's output, so there is
   * nothing to hand the model, and a second attempt costs the same wait again.
   */
  timedOut: boolean;
  /** Combined stdout and stderr, tail-truncated to VALIDATION_OUTPUT_LIMIT. */
  output: string;
  durationMs: number;
};

/**
 * Keeps the last `limit` characters, since a failing build reports the failure
 * at the end. Cuts on a line boundary so the model never sees half a line.
 */
export function tailOutput(
  text: string,
  limit = VALIDATION_OUTPUT_LIMIT,
): string {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - limit);
  const firstBreak = tail.indexOf("\n");
  const trimmed = firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
  return `[... ${text.length - trimmed.length} earlier characters omitted ...]\n${trimmed}`;
}

/**
 * stdout and stderr are captured on separate pipes, so their true interleaving
 * is gone by the time carl sees them. They are labelled rather than concatenated
 * silently, so a stack trace in stderr is not read as the tail of stdout.
 */
function combineStreams(stdout: string, stderr: string): string {
  const out = stdout.trimEnd();
  const err = stderr.trimEnd();
  if (out && err) return `--- stdout ---\n${out}\n--- stderr ---\n${err}`;
  return out || err;
}

/**
 * Runs the configured check command in the workspace and reports what happened.
 *
 * The command runs through a shell because it is the user's own one-liner
 * (`just lint && just test`), the same contract a `Makefile` recipe has.
 */
export function runValidation(
  workspaceRoot: string,
  command: string,
  timeoutMs = VALIDATION_TIMEOUT_MS,
): ValidationResult {
  const started = Date.now();
  const result = spawnSync(command, {
    shell: true,
    cwd: workspaceRoot,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: VALIDATION_MAX_BUFFER,
  });
  const durationMs = Date.now() - started;

  const timedOut =
    (result.error as NodeJS.ErrnoException)?.code === "ETIMEDOUT";
  const output = combineStreams(result.stdout ?? "", result.stderr ?? "");

  // A spawn that failed for any other reason (ENOBUFS on a huge log, for
  // instance) has no exit status to judge, so it reports as a failure carrying
  // the spawn error rather than as a pass.
  const spawnError = !timedOut && result.error ? result.error.message : "";

  return {
    command,
    ok: !timedOut && !spawnError && result.status === 0,
    exitCode: result.status,
    timedOut,
    output: tailOutput(
      spawnError ? [output, spawnError].filter(Boolean).join("\n") : output,
    ),
    durationMs,
  };
}

/** One line naming what carl ran and how it went. */
export function describeValidation(result: ValidationResult): string {
  const secs = (result.durationMs / 1000).toFixed(1);
  if (result.ok) return `Validation passed in ${secs}s: \`${result.command}\``;
  if (result.timedOut) {
    return (
      `Validation timed out after ${secs}s: \`${result.command}\`\n` +
      `The command was killed, so its output was lost — run it yourself to see ` +
      `why. Carl does not retry a timeout. Point \`validate\` at a faster check ` +
      `if this one cannot finish in ${Math.round(VALIDATION_TIMEOUT_MS / 60000)} minutes.`
    );
  }
  return `Validation failed (exit ${result.exitCode ?? "killed"}) in ${secs}s: \`${result.command}\``;
}

/** Which repair this is, 1-based, out of the configured budget. */
export type RepairAttempt = {
  attempt: number;
  total: number;
};

/**
 * The prompt for the run that repairs a validation failure.
 *
 * Each attempt is a fresh session with no memory of the last one, so everything
 * the repair needs has to be restated: the original request (or the model cannot
 * tell an in-scope fix from a rewrite), the previous attempt's own summary, the
 * failure itself, and — once more than one repair is allowed — how many repairs
 * have already failed. A session that does not know it is the second attempt has
 * no reason not to try the first attempt's fix again.
 */
export function buildValidationRetryPrompt(
  originalPrompt: string,
  previousResponse: string,
  result: ValidationResult,
  repair: RepairAttempt,
): string {
  const earlierRepairs = repair.attempt - 1;
  const standing =
    earlierRepairs === 0
      ? []
      : [
          `This is repair attempt ${repair.attempt} of ${repair.total}. ${earlierRepairs} earlier repair ` +
            `session${earlierRepairs === 1 ? "" : "s"} already saw this failure and did not fix it, so ` +
            `whatever the obvious fix looked like, it has been tried. Find the actual cause, or stop and ` +
            `say what you cannot determine — do not guess again.`,
          "",
        ];
  return [
    "# Original request",
    "",
    originalPrompt,
    "",
    "---",
    "",
    "# Previous attempt",
    "",
    "A previous session worked on the request above and reported this. You do",
    "not share its memory — this summary and the workspace are all that carried",
    "over:",
    "",
    previousResponse.trim() || "(it reported nothing)",
    "",
    "---",
    "",
    "# Validation failure",
    "",
    `Carl then ran \`${result.command}\` in the workspace. It exited ${result.exitCode ?? "killed"}:`,
    "",
    "```",
    result.output.trim() || "(no output)",
    "```",
    "",
    ...standing,
    "Fix the cause of this failure.",
    "",
    "- Do not weaken, skip, or delete a check to make it pass. If the check",
    "  itself is wrong, say so and stop rather than editing around it.",
    "- If this failure pre-dates the change above and is unrelated to it, say so",
    "  and stop. Carl does not know what the workspace looked like before.",
    "- Your summary replaces the previous attempt's, so describe the whole",
    "  change — what that attempt did and what you fixed — not just this repair.",
  ].join("\n");
}
