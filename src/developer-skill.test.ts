import { loadSkillContent } from "./skill-markdown-test-utils";

describe("Developer skill file placement rule", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("developer");
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

describe("t-5: Improve blocked reporting for Developer", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("developer");
  });

  test("developer.md Mikado Escalation section mentions blocked: prefix for escalation", () => {
    expect(skillContent).toMatch(/Mikado.*Escalation/i);
    expect(skillContent).toMatch(/blocked:/);
  });

  test("developer.md Mikado Escalation includes guidance for ## Blocked ticket section", () => {
    expect(skillContent).toMatch(/##\s+Blocked/i);
  });

  test("developer.md Mikado Escalation includes guidance for ## What is missing subsection", () => {
    expect(skillContent).toMatch(/##.*What is missing/i);
  });

  test("developer.md references .agent/dev-tickets.md when discussing blocked escalation", () => {
    // Find the Mikado section and check that it references dev-tickets.md not tickets.md
    const mikadoMatch = skillContent.match(
      /## Mikado Escalation\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (mikadoMatch) {
      const mikadoSection = mikadoMatch[1];
      // Should mention dev-tickets.md in context of Mikado escalation
      expect(mikadoSection).toMatch(/\.agent\/dev-tickets\.md/);
    }
  });

  test("developer.md 'Done Means' section aligns ticket completion with .agent/dev-tickets.md", () => {
    expect(skillContent).toMatch(/## Done Means/i);
    // The Done Means section should reference dev-tickets.md when marking tickets as complete
    const doneMeansMatch = skillContent.match(
      /## Done Means\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (doneMeansMatch) {
      const doneMeansSection = doneMeansMatch[1];
      expect(doneMeansSection).toMatch(/\.agent\/dev-tickets\.md/);
    }
  });

  test("developer.md cycle step 10 references .agent/dev-tickets.md not .agent/tickets.md", () => {
    // Step 10 should mark tickets in dev-tickets.md, not tickets.md
    expect(skillContent).toMatch(/10\./);
    const step10Match = skillContent.match(
      /10\.\s+Mark the ticket.*?\[x\][^\n]*\.agent\/dev-tickets\.md/i,
    );
    expect(step10Match).toBeTruthy();
  });
});
