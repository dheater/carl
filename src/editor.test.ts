import { openFileInEditor, getPhaseOutputPath } from "./editor";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("child_process");

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe("Editor helper and phase output path mapping", () => {
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

    test("prefers $EDITOR over $VISUAL", () => {
      process.env.EDITOR = "emacs";
      process.env.VISUAL = "vi";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith("emacs", [tmpFile], {
        stdio: "inherit",
        shell: true,
      });
    });

    test("falls back to $VISUAL when $EDITOR is not set", () => {
      delete process.env.EDITOR;
      process.env.VISUAL = "nano";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith("nano", [tmpFile], {
        stdio: "inherit",
        shell: true,
      });
    });

    test("falls back to 'vi' when neither $EDITOR nor $VISUAL is set", () => {
      delete process.env.EDITOR;
      delete process.env.VISUAL;
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith("vi", [tmpFile], {
        stdio: "inherit",
        shell: true,
      });
    });

    test("uses spawnSync with stdio: inherit and shell: true", () => {
      process.env.EDITOR = "vim";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        expect.any(String),
        [tmpFile],
        {
          stdio: "inherit",
          shell: true,
        },
      );
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

    test("passes exact file path to editor", () => {
      process.env.EDITOR = "vim";
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      openFileInEditor(tmpFile);

      const callArgs = mockSpawnSync.mock.calls[0];
      expect(callArgs[1]).toEqual([tmpFile]);
    });
  });

  describe("getPhaseOutputPath", () => {
    const workspaceRoot = "/workspace";

    test("maps architect phase to .agent/decisions.md", () => {
      const result = getPhaseOutputPath(workspaceRoot, "architect");
      expect(result).toBe(path.join(workspaceRoot, ".agent", "decisions.md"));
    });

    test("maps developer phase to .agent/notes/developer.md", () => {
      const result = getPhaseOutputPath(workspaceRoot, "developer");
      expect(result).toBe(
        path.join(workspaceRoot, ".agent", "notes", "developer.md"),
      );
    });

    test("maps test-writer phase to .agent/notes/test-writer.md", () => {
      const result = getPhaseOutputPath(workspaceRoot, "test-writer");
      expect(result).toBe(
        path.join(workspaceRoot, ".agent", "notes", "test-writer.md"),
      );
    });

    test("maps reviewer phase to .agent/notes/reviewer.md", () => {
      const result = getPhaseOutputPath(workspaceRoot, "reviewer");
      expect(result).toBe(
        path.join(workspaceRoot, ".agent", "notes", "reviewer.md"),
      );
    });


  });
});
