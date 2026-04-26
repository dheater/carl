import * as fs from "fs";
import * as path from "path";

describe("Verifier skill file structure and parsing (t-3)", () => {
  let skillContent: string;

  beforeEach(() => {
    const skillPath = path.join(__dirname, "..", "skills", "verifier.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    skillContent = fs.readFileSync(skillPath, "utf-8");
  });

  test("verifier.md exists and is readable", () => {
    expect(skillContent).toBeTruthy();
    expect(skillContent.length).toBeGreaterThan(0);
  });

  test("verifier.md has valid YAML frontmatter", () => {
    // Should start with --- and have closing ---
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
  });

  test("verifier.md frontmatter includes required fields", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();

    const frontmatter = frontmatterMatch![1];

    // Check required fields
    expect(frontmatter).toMatch(/type:\s*agent_requested/);
    expect(frontmatter).toMatch(/name:\s*Verifier/);
    expect(frontmatter).toMatch(/description:/);
    expect(frontmatter).toMatch(/when_to_use:/);
    expect(frontmatter).toMatch(/version:\s*1\.0\.0/);
    expect(frontmatter).toMatch(/prerequisites:/);
    expect(frontmatter).toMatch(/next_skills:/);
  });

  test("verifier.md frontmatter includes 'developer' in prerequisites", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/prerequisites:\s*\n\s*-\s*developer/);
  });

  test("verifier.md frontmatter includes 'reviewer' in next_skills", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/next_skills:\s*\n\s*-\s*reviewer/);
  });

  test("verifier.md does NOT include 'developer' in next_skills", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter = frontmatterMatch![1];

    // next_skills should not have developer
    const nextSkillsMatch = frontmatter.match(
      /next_skills:([\s\S]*?)(?=\w+:|$)/,
    );
    if (nextSkillsMatch) {
      expect(nextSkillsMatch[1]).not.toMatch(/developer/);
    }
  });

  test("verifier.md description mentions cleanup/check phase", () => {
    expect(skillContent).toMatch(/cleanup|check/i);
  });

  test("verifier.md content includes 'Lint and test status' section", () => {
    // Should have this as an output structure example
    expect(skillContent).toMatch(/Lint and test status/);
  });

  test("verifier.md content includes 'Changes made' section", () => {
    expect(skillContent).toMatch(/Changes made/);
  });

  test("verifier.md content includes 'Recommendations for Developer/Architect' section", () => {
    expect(skillContent).toMatch(/Recommendations for Developer\/Architect/);
  });

  test("verifier.md mentions deterministic artifacts", () => {
    expect(skillContent).toMatch(/\.agent\/tests-summary\.json/);
    expect(skillContent).toMatch(/\.agent\/tests\.log/);
    expect(skillContent).toMatch(/\.agent\/lint\.log/);
  });

  test("verifier.md instructs NOT to re-run tests or lint", () => {
    expect(skillContent).toMatch(/Do NOT.*re-run.*just lint.*just test/is);
  });

  test("verifier.md explains subtract-first cleanup approach", () => {
    expect(skillContent).toMatch(/Subtract-First Cleanup/);
    expect(skillContent).toMatch(/Remove low-value tests/i);
    expect(skillContent).toMatch(/Remove or simplify low-value comments/i);
  });
});
