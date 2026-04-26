import * as fs from "fs";
import * as path from "path";

describe("README Homebrew documentation", () => {
  let readmeContent: string;

  beforeAll(() => {
    const readmePath = path.join(__dirname, "..", "README.md");
    readmeContent = fs.readFileSync(readmePath, "utf-8");
  });

  describe("Install section structure", () => {
    it("should contain an Install section", () => {
      expect(readmeContent).toMatch(/##\s+Install/);
    });

    it("should have both Homebrew and source build subsections", () => {
      expect(readmeContent).toMatch(/###\s+Using Homebrew/);
      expect(readmeContent).toMatch(/###\s+Building from source/);
    });
  });

  describe("Homebrew installation path", () => {
    it("should document brew tap dheater/carl (concrete tap)", () => {
      expect(readmeContent).toMatch(/brew tap dheater\/carl/);
    });

    it("should document brew install carl", () => {
      expect(readmeContent).toMatch(/brew install carl/);
    });

    it("should include a Homebrew example command", () => {
      expect(readmeContent).toMatch(/carl start/);
    });

    it("should show complete brew workflow in code block", () => {
      const brewSection = readmeContent.match(
        /###\s+Using Homebrew[\s\S]*?```[\s\S]*?```/,
      );
      expect(brewSection).toBeTruthy();
      if (brewSection) {
        expect(brewSection[0]).toMatch(/brew tap/);
        expect(brewSection[0]).toMatch(/brew install/);
      }
    });
  });

  describe("Source installation path remains available", () => {
    it("should document git clone", () => {
      expect(readmeContent).toMatch(/git clone/);
    });

    it("should document just install", () => {
      expect(readmeContent).toMatch(/just install/);
    });

    it("should show complete source build workflow in code block", () => {
      const sourceSection = readmeContent.match(
        /###\s+Building from source[\s\S]*?```[\s\S]*?```/,
      );
      expect(sourceSection).toBeTruthy();
      if (sourceSection) {
        expect(sourceSection[0]).toMatch(/git clone/);
        expect(sourceSection[0]).toMatch(/just/);
      }
    });
  });

  describe("No unsafe configuration in install steps", () => {
    it("should not include ~/.augment configuration in install steps", () => {
      const installSection = readmeContent.match(
        /##\s+Install[\s\S]*?(?=##|\Z)/,
      );
      expect(installSection).toBeTruthy();
      if (installSection) {
        expect(installSection[0]).not.toMatch(/~\/\.augment/);
      }
    });

    it("should not require manual configuration file creation in install section", () => {
      const installSection = readmeContent.match(
        /##\s+Install[\s\S]*?(?=##|\Z)/,
      );
      expect(installSection).toBeTruthy();
      if (installSection) {
        expect(installSection[0]).not.toMatch(/config|CONFIG/);
      }
    });
  });
});
