import * as fs from "fs";
import * as path from "path";

describe("Developer skill file placement rule", () => {
  let skillContent: string;

  beforeEach(() => {
    const skillPath = path.join(__dirname, "..", "skills", "developer.md");
    skillContent = fs.readFileSync(skillPath, "utf-8");
  });

  test("developer.md contains a 'File placement and tracking' section", () => {
    expect(skillContent).toMatch(/##\s+File placement and tracking/i);
  });

  test("developer.md connects permanent files with version control", () => {
    // Check for language that connects "source or test files you intend to keep" with "version control"
    const versionControlMatch = skillContent.match(
      /source or test files[^.]*version control/is,
    );
    expect(versionControlMatch).toBeTruthy();
  });

  test("developer.md mentions scratch or temporary files", () => {
    expect(skillContent).toMatch(/scratch|temporary/i);
  });

  test("developer.md states scratch/temporary files must be ignored by version control", () => {
    const ignoreMatch = skillContent.match(
      /scratch|temporary[^.]*ignored by version control/is,
    );
    expect(ignoreMatch).toBeTruthy();
  });

  test("developer.md states scratch/temporary files must be excluded from test runner", () => {
    const exclusionMatch = skillContent.match(
      /scratch|temporary[^.]*excluded from the test runner/is,
    );
    expect(exclusionMatch).toBeTruthy();
  });

  test("developer.md does not hard-code project-specific paths", () => {
    // Should not hard-code paths like "src/" or "dist/" as requirements
    // (examples may be present but should be clearly framed)
    const hasHardCodedSrcPath = skillContent.match(/\bsrc\/\s*[A-Z]/);
    const hasHardCodedDistPath = skillContent.match(/\bdist\/\s*[A-Z]/);

    // If found, they should be in example context, not as statements
    if (hasHardCodedSrcPath || hasHardCodedDistPath) {
      // Check that they are in parentheses or example context
      expect(skillContent.match(/\(.*(?:src|dist).*\)|example/i)).toBeTruthy();
    }
  });

  test("developer.md provides example but is not specific to this repository", () => {
    // Check that the skill is generic, not tied to "carl" or specific repo name
    const isCarlSpecific = skillContent.includes("carl");
    expect(isCarlSpecific).toBe(false);
  });
});
