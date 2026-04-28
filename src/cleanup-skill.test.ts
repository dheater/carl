import { loadSkillContent } from "./skill-markdown-test-utils";

describe("cleanup skill file structure and parsing (t-3)", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("cleanup");
  });

  test("cleanup.md has valid YAML frontmatter", () => {
    // Should start with --- and have closing ---
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
  });

  test("cleanup.md frontmatter includes required fields", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();

    const frontmatter = frontmatterMatch![1];

    // Check required fields
    expect(frontmatter).toMatch(/type:\s*agent_requested/);
    expect(frontmatter).toMatch(/name:\s*Cleanup/);
    expect(frontmatter).toMatch(/description:/);
    expect(frontmatter).toMatch(/when_to_use:/);
    expect(frontmatter).toMatch(/version:\s*1\.0\.0/);
    expect(frontmatter).toMatch(/prerequisites:/);
    expect(frontmatter).toMatch(/next_skills:/);
  });

  test("cleanup.md frontmatter includes 'developer' in prerequisites", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/prerequisites:\s*\n\s*-\s*developer/);
  });

  test("cleanup.md frontmatter includes 'reviewer' in next_skills", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/next_skills:\s*\n\s*-\s*reviewer/);
  });

  test("cleanup.md does NOT include 'developer' in next_skills", () => {
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

  test("cleanup.md description mentions cleanup/check phase", () => {
    expect(skillContent).toMatch(/cleanup|check/i);
  });

  test("cleanup.md content includes 'Changes made' section", () => {
    expect(skillContent).toMatch(/Changes made/);
  });

  test("cleanup.md content includes 'Recommendations for Developer and TestWriter' sections", () => {
    expect(skillContent).toMatch(/Recommendations for Developer/);
    expect(skillContent).toMatch(/Recommendations for TestWriter/);
  });

  test("cleanup.md explains subtract-first cleanup approach", () => {
    expect(skillContent).toMatch(/Subtract-First Cleanup/);
    expect(skillContent).toMatch(/Remove low-value tests/i);
    expect(skillContent).toMatch(/Remove or simplify low-value comments/i);
  });

  test("cleanup.md explicitly mentions that cleanup does not directly edit ticket files", () => {
    // cleanup should provide recommendations, not edit tickets directly
    expect(skillContent).toMatch(
      /does not.*directly edit.*\.agent\/dev-tickets\.md|does not.*directly edit.*\.agent\/test-tickets\.md/i,
    );
  });

  test("cleanup.md instructs cleanup to provide recommendations for Architect to turn into tickets", () => {
    // cleanup's role is to recommend, not to create tickets
    expect(skillContent).toMatch(
      /provides.*recommendations.*Architect|recommendations.*turn into tickets/i,
    );
  });
});
