import { loadSkillContent } from "./skill-markdown-test-utils";

describe("TestWriter skill", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("test-writer");
  });

  test("frontmatter includes type: agent_requested and name: TestWriter", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/type:\s*agent_requested/);
    expect(frontmatter).toMatch(/name:\s*TestWriter/);
  });

  test("reads .agent/decisions.md and .agent/test-tickets.md", () => {
    expect(skillContent).toMatch(/\.agent\/decisions\.md/);
    expect(skillContent).toMatch(/\.agent\/test-tickets\.md/);
  });

  test("has a 'Blocked' section that references .agent/test-tickets.md", () => {
    expect(skillContent).toMatch(/##\s+Blocked/i);
    const blockedMatch = skillContent.match(
      /##\s+Blocked[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (blockedMatch) {
      expect(blockedMatch[1]).toMatch(/\.agent\/test-tickets\.md/);
    }
  });
});
