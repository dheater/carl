import { spawnSync } from "child_process";

import { collectPrompt, openFileInEditor } from "./editor";

jest.mock("child_process", () => ({ spawnSync: jest.fn() }));

const spawnSyncMock = spawnSync as jest.MockedFunction<typeof spawnSync>;

/**
 * A terminal editor needs both streams, so the tests set both. `undefined` is
 * what node reports for a pipe, which is what a backgrounded run gets.
 */
function setTty(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: stdin || undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: stdout || undefined,
    configurable: true,
  });
}

describe("editor without a terminal", () => {
  const stdinTty = process.stdin.isTTY;
  const stdoutTty = process.stdout.isTTY;
  let log: jest.SpyInstance;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    setTty(Boolean(stdinTty), Boolean(stdoutTty));
  });

  test("openFileInEditor reports the path instead of waiting on an editor", () => {
    setTty(false, false);

    openFileInEditor("/tmp/notes/review.md");

    // An editor spawned here would block on a stdin nobody can type into, and
    // the run would hang until someone found the process and killed it.
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("review.md"));
  });

  test("a piped stdin is not a terminal, even with a terminal stdout", () => {
    setTty(false, true);

    openFileInEditor("/tmp/notes/review.md");

    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  test("collectPrompt says to pass a file, since it cannot ask", () => {
    setTty(false, false);

    expect(() => collectPrompt("# What should Carl implement?")).toThrow(
      /pass it: carl <command> <file>/,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  test("openFileInEditor opens the editor when there is a terminal", () => {
    setTty(true, true);
    process.env.EDITOR = "vi";
    spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);

    openFileInEditor("/tmp/notes/review.md");

    expect(spawnSyncMock).toHaveBeenCalledWith("vi", ["/tmp/notes/review.md"], {
      stdio: "inherit",
    });
  });
});
