import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listLocalModels,
  matchesModelName,
  normalizeModelName,
  resolveLocalModel,
  type LocalModel,
} from "./dsh-runner";

/**
 * Starting mtplx, the local inference server carl prefers over Bedrock.
 *
 * carl routes by model name and takes a locally hosted copy whenever one is
 * being served (see createRunner in src/carl.ts). That left a hole: the model is
 * on the machine, mtplx can serve it, and carl silently billed Bedrock because
 * nothing had started the server yet. So when the configured model is not served
 * and is not a Bedrock alias either, carl asks mtplx whether it has the model
 * cached and starts it if so.
 *
 * The server outlives the run that started it, which is the point — a model load
 * costs tens of seconds and every later run reuses it.
 */

/** Where mtplx's installer puts its CLI, which is not on PATH. */
export const MTPLX_HOME_COMMAND = path.join(
  os.homedir(),
  ".mtplx",
  "bin",
  "mtplx",
);

/** How long `mtplx models` gets to answer before carl gives up on it. */
const MTPLX_LIST_TIMEOUT_MS = 10_000;

/**
 * How long carl waits for a started server to answer. Generous because this is
 * dominated by mapping weights: seconds for a 9B, up to a minute or two for a
 * 27B on a cold page cache.
 */
const MTPLX_READY_TIMEOUT_MS = 300_000;

/** How often carl re-asks a starting server what it serves. */
const MTPLX_POLL_INTERVAL_MS = 1_000;

/** How long each of those polls gets. */
const MTPLX_POLL_TIMEOUT_MS = 2_000;

/** How much of the server log a failure quotes. */
const MTPLX_LOG_TAIL_LINES = 12;

/** One model pack in mtplx's local cache. */
export type MtplxPack = {
  repoId: string;
  path: string;
};

/**
 * The mtplx CLI, or undefined when this machine has none.
 *
 * PATH first, so a deliberate install wins, then the location the mtplx app
 * installs to — which is where it usually is, since that installer adds nothing
 * to PATH.
 */
export function mtplxCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.CARL_MTPLX_COMMAND?.trim();
  if (configured) return configured;

  const onPath = spawnSync("which", ["mtplx"], { encoding: "utf8" });
  const found = onPath.stdout?.trim();
  if (onPath.status === 0 && found) return found;

  return fs.existsSync(MTPLX_HOME_COMMAND) ? MTPLX_HOME_COMMAND : undefined;
}

/**
 * The packs in an `mtplx models --json` body.
 *
 * A pack mtplx itself reports as invalid is skipped: it cannot be served, so
 * offering it would trade a clear "no local copy" for a model load that fails
 * two minutes in. Absent validation is not a failed validation, so an added or
 * renamed field costs carl the check rather than the pack.
 */
export function parseMtplxPacks(body: unknown): MtplxPack[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const packs: MtplxPack[] = [];
  for (const entry of models) {
    const repoId = (entry as { repo_id?: unknown })?.repo_id;
    const packPath = (entry as { path?: unknown })?.path;
    if (typeof repoId !== "string" || !repoId.trim()) continue;
    const ok = (entry as { validation?: { ok?: unknown } })?.validation?.ok;
    if (ok === false) continue;
    packs.push({
      repoId,
      path: typeof packPath === "string" ? packPath : "",
    });
  }
  return packs;
}

/**
 * What mtplx has cached, or `[]` when it cannot say.
 *
 * Every way of not knowing answers "nothing cached", because the caller's next
 * move is Bedrock either way and a broken mtplx install must not fail a run that
 * never needed it.
 */
export function listMtplxPacks(command: string): MtplxPack[] {
  const result = spawnSync(command, ["models", "--json"], {
    encoding: "utf8",
    timeout: MTPLX_LIST_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    return parseMtplxPacks(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

/**
 * The cached pack a configured name asks for, or undefined for none.
 *
 * Matched the way a served model is matched, through the same normalization —
 * a fragment of the name is enough, and a fragment fitting several packs is
 * refused rather than resolved arbitrarily, since starting the wrong 20GB model
 * is expensive and silent.
 */
export function resolveMtplxPack(
  name: string,
  packs: MtplxPack[],
): MtplxPack | undefined {
  if (!normalizeModelName(name)) return undefined;

  const matches = packs.filter((pack) => matchesModelName(name, pack.repoId));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${name}" matches more than one model in mtplx's cache:\n` +
        matches.map((pack) => `  - ${pack.repoId}`).join("\n") +
        `\nName the one you want more precisely.`,
    );
  }
  return undefined;
}

/**
 * The port and host to serve on, or undefined when the endpoint is not this
 * machine's.
 *
 * carl only ever starts a server it could also stop, and that means a loopback
 * address: CARL_LOCAL_BASE_URL pointed at another host is someone else's server
 * to run.
 */
export function localServePort(baseURL: string): number | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return undefined;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"];
  if (!loopback.includes(url.hostname)) return undefined;
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * How carl starts mtplx.
 *
 * `--no-auth` because carl only starts loopback binds, where mtplx wants no
 * credential and carl's placeholder bearer token is accepted. It also keeps
 * every key out of this argv, and out of any file carl would otherwise have had
 * to write to avoid this argv.
 *
 * No `--profile`: mtplx resolves the right one per model, and second-guessing it
 * from here would silently change what a benchmark measures. `--yes` because
 * there is no terminal to confirm at — carl's stdin belongs to the skill run.
 */
export function mtplxServeArgs(repoId: string, port: number): string[] {
  return [
    "serve",
    "--model",
    repoId,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-auth",
    "--yes",
  ];
}

/**
 * How many requests the server is working on, or undefined when it did not say.
 *
 * `active_requests` is what mtplx's `/health` reports at the top level, and the
 * scheduler repeats its own count; the larger wins, so a busy server is never
 * read as idle because one of the two had not caught up.
 */
export function busyRequestCount(health: unknown): number | undefined {
  const body = health as {
    active_requests?: unknown;
    scheduler?: { active_requests?: unknown };
  };
  const counts = [
    body?.active_requests,
    body?.scheduler?.active_requests,
  ].filter((value): value is number => typeof value === "number" && value >= 0);
  return counts.length > 0 ? Math.max(...counts) : undefined;
}

/**
 * Whether the server answering this endpoint is idle enough to stop.
 *
 * A server that does not answer `/health`, or answers without a request count, is
 * not idle as far as carl is concerned: it is something carl did not start and
 * cannot reason about, and stopping it would be a guess made on someone else's
 * behalf.
 */
async function idleEnoughToStop(baseURL: string): Promise<boolean> {
  try {
    const health = new URL("/health", baseURL);
    const response = await fetch(health, {
      signal: AbortSignal.timeout(MTPLX_POLL_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    return busyRequestCount(await response.json()) === 0;
  } catch {
    return false;
  }
}

/** Where the started server's own output goes, since carl's stdout is taken. */
export function mtplxLogPath(port: number): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, ".config", "carl", "logs", `mtplx-${port}.log`);
}

function tail(logPath: string, lines: number): string {
  try {
    const text = fs.readFileSync(logPath, "utf8").trimEnd();
    if (!text) return "";
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts mtplx on the configured model and waits for it to serve.
 *
 * Answers undefined when carl has nothing to offer — no mtplx, no cached copy of
 * this model, or an endpoint on another host — so the caller can report the model
 * as unavailable rather than as broken. A start that carl does attempt and that
 * does not come up throws, because at that point silence would look like a
 * missing model and bill Bedrock for it.
 *
 * An already-answering server is stopped first when it serves something else:
 * mtplx serves one chat model per port, so there is no way to add a model to a
 * running one, and carl was asked for this model specifically. An idle one only —
 * a server working on a request is one another run is waiting on.
 */
export async function startLocalModel(
  name: string,
  baseURL: string,
  served: LocalModel[],
  log: (line: string) => void,
): Promise<LocalModel | undefined> {
  const port = localServePort(baseURL);
  if (port === undefined) return undefined;

  const command = mtplxCommand();
  if (!command) return undefined;

  const pack = resolveMtplxPack(name, listMtplxPacks(command));
  if (!pack) return undefined;

  // A server already serving this pack under a name the config did not resolve —
  // the full repo id in config.json, say — is the model carl was asked for, and
  // reloading it would cost a minute to arrive back where it started.
  const running = served.find((model) =>
    matchesModelName(model.id, pack.repoId),
  );
  if (running) return running;

  if (served.length > 0) {
    // A server mid-request belongs to whoever is waiting on it. Stopping it here
    // failed that run with a transport error and cost it everything it had done,
    // so a busy port stops carl instead of the other way around.
    if (!(await idleEnoughToStop(baseURL))) {
      throw new Error(
        `Port ${port} is serving ${served.map((m) => m.id).join(", ")} and is ` +
          `busy or unrecognized, so carl will not stop it to serve ` +
          `${pack.repoId}.\n` +
          `Wait for the run using it to finish, stop it yourself ` +
          `(mtplx stop --port ${port}), or point CARL_LOCAL_BASE_URL at ` +
          `another port.`,
      );
    }
    log(
      `mtplx on port ${port} is serving ${served.map((m) => m.id).join(", ")}; ` +
        `stopping it to serve ${pack.repoId}`,
    );
    spawnSync(command, ["stop", "--port", String(port)], { encoding: "utf8" });
  }

  const logPath = mtplxLogPath(port);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  log(`starting mtplx on ${pack.repoId} (log: ${logPath})`);
  const child = spawn(command, mtplxServeArgs(pack.repoId, port), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 0;
  });

  const deadline = Date.now() + MTPLX_READY_TIMEOUT_MS;
  try {
    for (;;) {
      const running = await listLocalModels(baseURL, MTPLX_POLL_TIMEOUT_MS);
      // The name is tried first, but a server carl started for one pack serves
      // one chat model, and that model is the one carl asked for even when the
      // server spells it unrecognizably.
      const model =
        resolveLocalModel(name, running) ??
        (running.length === 1 ? running[0] : undefined);
      if (model) {
        log(`mtplx is serving ${model.id}`);
        return model;
      }
      if (exited !== null) {
        throw new Error(
          `mtplx exited with status ${exited} while starting ${pack.repoId}.\n` +
            `${logPath}:\n${tail(logPath, MTPLX_LOG_TAIL_LINES)}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `mtplx did not serve ${pack.repoId} within ` +
            `${Math.round(MTPLX_READY_TIMEOUT_MS / 1000)}s.\n` +
            `${logPath}:\n${tail(logPath, MTPLX_LOG_TAIL_LINES)}`,
        );
      }
      await delay(MTPLX_POLL_INTERVAL_MS);
    }
  } finally {
    // The server is meant to outlive this run either way: on success so the next
    // run reuses the loaded weights, and on failure so its log keeps filling for
    // whoever reads the error.
    child.removeAllListeners("exit");
    child.unref();
  }
}
