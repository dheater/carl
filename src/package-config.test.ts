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
    it("should have bin.carl pointing to dist/carl.mjs", () => {
      expect(packageJson.bin).toBeDefined();
      expect(packageJson.bin.carl).toBe("./dist/carl.mjs");
    });

    it("should have a build script that produces dist/carl.mjs", () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.build).toBeDefined();
      expect(packageJson.scripts.build).toContain("dist/carl.mjs");
    });
  });
});
