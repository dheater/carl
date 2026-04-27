import * as fs from "fs";
import * as path from "path";

describe("homebrew-formula", () => {
  let formulaContent: string;
  let packageJson: { version: string };

  beforeAll(() => {
    const formulaPath = path.join(__dirname, "..", "Formula", "carl-ai.rb");
    formulaContent = fs.readFileSync(formulaPath, "utf-8");

    const packageJsonPath = path.join(__dirname, "..", "package.json");
    const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
    packageJson = JSON.parse(packageJsonContent);
  });

  describe("Formula structure", () => {
    it("should have class CarlAi < Formula", () => {
      expect(formulaContent).toMatch(/class\s+CarlAi\s*<\s*Formula/);
    });

    it("should depend on node", () => {
      expect(formulaContent).toMatch(/depends_on\s+["']node["']/);
    });

    it("should define desc, homepage, url, version, sha256, and license", () => {
      expect(formulaContent).toMatch(/desc\s+["']/);
      expect(formulaContent).toMatch(/homepage\s+["']/);
      expect(formulaContent).toMatch(/url\s+["']/);
      expect(formulaContent).toMatch(/version\s+["']/);
      expect(formulaContent).toMatch(/sha256\s+["']/);
      expect(formulaContent).toMatch(/license\s+["']/);
    });
  });

  describe("Install approach", () => {
    it("should install pre-built carl.js into libexec", () => {
      expect(formulaContent).toMatch(/def\s+install/);
      expect(formulaContent).toMatch(/libexec\.install\s+["']carl\.js["']/);
    });

    it("should not run npm install (no Xcode dependency)", () => {
      expect(formulaContent).not.toMatch(/system\s+["']npm["']/);
    });

    it("should write a shell wrapper into bin", () => {
      expect(formulaContent).toMatch(/\(bin\/"carl"\)\.write/);
    });

    it("should have test block using system command", () => {
      expect(formulaContent).toMatch(/def\s+test/);
      expect(formulaContent).toMatch(/system\s+["']#{bin}\/carl["']/);
    });

    it("should not reference home directory paths in test", () => {
      const testBlock = formulaContent.match(/def\s+test[\s\S]*?end/);
      expect(testBlock).toBeTruthy();
      if (testBlock) {
        expect(testBlock[0]).not.toMatch(/~/);
        expect(testBlock[0]).not.toMatch(/\.augment/);
      }
    });
  });

  describe("Version synchronization with package.json", () => {
    it("should have version field that matches package.json.version", () => {
      const versionMatch = formulaContent.match(/version\s+["']([^"']+)["']/);
      expect(versionMatch).toBeTruthy();
      if (versionMatch) {
        expect(versionMatch[1]).toBe(packageJson.version);
      }
    });

    it("should have url field that includes releases/download/v<version>/carl.js", () => {
      const urlMatch = formulaContent.match(/url\s+["']([^"']+)["']/);
      expect(urlMatch).toBeTruthy();
      if (urlMatch) {
        const expectedUrl = `https://github.com/dheater/carl/releases/download/v${packageJson.version}/carl.js`;
        expect(urlMatch[1]).toBe(expectedUrl);
      }
    });
  });
});
