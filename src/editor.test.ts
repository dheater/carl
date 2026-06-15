import { collectPrompt, openFileInEditor } from "./editor";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("child_process");

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe("Editor helper", () => {
  describe("collectPrompt", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.EDITOR;
      delete process.env.VISUAL;
    });

    test("passes editor args without shell expansion", () => {
      process.env.EDITOR = "code --wait";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      collectPrompt();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "code",
        ["--wait", expect.stringMatching(/carl-prompt-.*[\\/]prompt\.md$/)],
        { stdio: "inherit" },
      );
    });
  });

  describe("openFileInEditor", () => {
    let tmpFile: string;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), "test-editor-file.md");
      fs.writeFileSync(tmpFile, "test content", "utf-8");
      jest.clearAllMocks();
      delete process.env.EDITOR;
      delete process.env.VISUAL;
    });

    afterEach(() => {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    });

    test("splits editor commands with arguments", () => {
      process.env.EDITOR = "code --wait";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith("code", ["--wait", tmpFile], {
        stdio: "inherit",
      });
    });

    test("falls back to 'vi' when neither $EDITOR nor $VISUAL is set", () => {
      delete process.env.EDITOR;
      delete process.env.VISUAL;
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith("vi", [tmpFile], {
        stdio: "inherit",
      });
    });

    test("logs warning on spawn error and does not throw", () => {
      process.env.EDITOR = "nonexistent";
      const error = new Error("ENOENT: no such file");
      mockSpawnSync.mockReturnValue({
        error,
        status: null,
      } as any);
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      expect(() => {
        openFileInEditor(tmpFile);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(
        /failed to open.*editor|warning/i,
      );

      warnSpy.mockRestore();
    });

    test("logs warning on non-zero exit code and does not throw", () => {
      process.env.EDITOR = "vim";
      mockSpawnSync.mockReturnValue({ status: 1 } as any);
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      expect(() => {
        openFileInEditor(tmpFile);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
