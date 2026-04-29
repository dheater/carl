import { loadSkillContent } from "./skill-markdown-test-utils";

describe("Developer skill", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("developer");
  });

  test("contains a 'File placement and tracking' section", () => {
    expect(skillContent).toMatch(/##\s+File placement and tracking/i);
  });

  test("connects permanent files with version control", () => {
    const versionControlMatch = skillContent.match(
      /source or test files[^.]*version control/is,
    );
    expect(versionControlMatch).toBeTruthy();
  });

  test("mentions scratch or temporary files", () => {
    expect(skillContent).toMatch(/scratch|temporary/i);
  });

  test("scratch/temporary files must be ignored by version control", () => {
    const ignoreMatch = skillContent.match(
      /scratch|temporary[^.]*ignored by version control/is,
    );
    expect(ignoreMatch).toBeTruthy();
  });

  test("scratch/temporary files must be excluded from test runner", () => {
    const exclusionMatch = skillContent.match(
      /scratch|temporary[^.]*excluded from the test runner/is,
    );
    expect(exclusionMatch).toBeTruthy();
  });

  test("is not specific to this repository", () => {
    expect(skillContent.includes("carl")).toBe(false);
  });

  test("has a Blocked/Mikado section and references .agent/dev-tickets.md", () => {
    expect(skillContent).toMatch(/##\s+Blocked/i);
    expect(skillContent).toMatch(/\.agent\/dev-tickets\.md/);
  });
});
