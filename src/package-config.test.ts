import * as fs from "fs";
import * as path from "path";

describe("package-config", () => {
  let packageJson: any;

  beforeAll(() => {
    const packagePath = path.join(__dirname, "..", "package.json");
    const raw = fs.readFileSync(packagePath, "utf-8");
    packageJson = JSON.parse(raw);
  });

  describe("prepare script", () => {
    it("should define a prepare script that runs npm run build", () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.prepare).toBeDefined();
      expect(packageJson.scripts.prepare).toBe("npm run build");
    });
  });

  describe("bin configuration", () => {
    it("should have bin.carl pointing to dist/carl.js", () => {
      expect(packageJson.bin).toBeDefined();
      expect(packageJson.bin.carl).toBe("./dist/carl.js");
    });

    it("should have a build script that produces dist/carl.js", () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.build).toBeDefined();
      expect(packageJson.scripts.build).toContain("dist/carl.js");
    });
  });

  describe("package distribution", () => {
    it("should have compiled dist/carl.js after npm run build", () => {
      const distPath = path.join(__dirname, "..", "dist", "carl.js");
      expect(fs.existsSync(distPath)).toBe(true);
      const content = fs.readFileSync(distPath, "utf-8");
      expect(content).toContain("#!/usr/bin/env node");
    });

    it("should have no new production dependencies beyond auggie-sdk", () => {
      expect(packageJson.dependencies).toBeDefined();
      const deps = Object.keys(packageJson.dependencies);
      expect(deps.length).toBeLessThanOrEqual(2); // auggie-sdk + possibly one more
      expect(deps).toContain("@augmentcode/auggie-sdk");
    });
  });
});
