import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSkill } from "./skill";

jest.mock("@augmentcode/auggie-sdk");

const mockCreate = jest.requireMock("@augmentcode/auggie-sdk").Auggie
  .create as jest.MockedFunction<any>;

describe("runSkill", () => {
  let workspaceRoot: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carl-skill-"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockCreate.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("excludes write tools for review skill", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("# Summary\n\nDone."),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    await runSkill(workspaceRoot, "review", undefined, "test-model");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedTools: expect.arrayContaining([
          "remove-files",
          "save-file",
          "str-replace-editor",
        ]),
      }),
    );
  });

  test("does not exclude write tools for code skill", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("# Summary\n\nDone."),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    await runSkill(workspaceRoot, "code", "implement this", "test-model");

    const opts = mockCreate.mock.calls[0][0];
    expect(opts.excludedTools ?? []).toEqual([]);
  });

  test("does not exclude write tools for pr-review skill", async () => {
    const client = {
      onSessionUpdate: jest.fn(),
      prompt: jest.fn().mockResolvedValue("draft updated"),
      close: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(client as any);

    await runSkill(workspaceRoot, "pr-review", "review this", "test-model");

    const opts = mockCreate.mock.calls[0][0];
    expect(opts.excludedTools ?? []).toEqual([]);
  });
});
