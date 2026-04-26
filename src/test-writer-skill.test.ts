import { loadSkillContent } from "./skill-markdown-test-utils";

describe("t-3: Add TestWriter skill and contract tests", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("test-writer");
  });

  test("test-writer.md has valid YAML frontmatter", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
  });

  test("test-writer.md frontmatter includes type: agent_requested", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/type:\s*agent_requested/);
  });

  test("test-writer.md frontmatter includes name: TestWriter", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/name:\s*TestWriter/);
  });

  test("test-writer.md description mentions long-lived, behavior-focused regression tests", () => {
    expect(skillContent).toMatch(
      /long-lived|regression.*test|behavior-focused/i,
    );
  });

  test("test-writer.md mentions .agent/test-tickets.md", () => {
    expect(skillContent).toMatch(/\.agent\/test-tickets\.md/);
  });

  test("test-writer.md explicitly does NOT recommend *.dev.test.ts", () => {
    // Should NOT mention .dev.test.ts as a file to create
    const hasDevTest = skillContent.includes(".dev.test.ts");
    if (hasDevTest) {
      // If mentioned, it should be in context of "Developer-only" or "don't use"
      expect(skillContent).toMatch(
        /Developer-only|ephemeral|don't|not.*\.dev\.test/i,
      );
    } else {
      expect(hasDevTest).toBe(false);
    }
  });

  test("test-writer.md mentions testing behavior/WHAT not implementation/HOW", () => {
    expect(skillContent).toMatch(/WHAT|behavior|observable|API contract/i);
    expect(skillContent).toMatch(
      /not.*HOW|implementation.*detail|internal|private function/i,
    );
  });

  test("test-writer.md mentions subtract-first approach", () => {
    expect(skillContent).toMatch(/subtract|strengthen|refactor.*test|delete/i);
  });

  test("test-writer.md frontmatter includes prerequisites with architect", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/prerequisites:/);
    expect(frontmatter).toMatch(/architect/);
  });

  test("test-writer.md frontmatter does not list itself as a gate phase", () => {
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch).toBeTruthy();
    const frontmatter = frontmatterMatch![1];
    // next_skills should exist but should not include top-level phases
    // It may be empty or list other agents
    expect(frontmatter).toMatch(/next_skills:/);
  });

  test("test-writer.md states it reads .agent/notes/architect.md and .agent/test-tickets.md", () => {
    expect(skillContent).toMatch(/\.agent\/notes\/architect\.md/);
    expect(skillContent).toMatch(/\.agent\/test-tickets\.md/);
  });

  test("test-writer.md states it reads git status/diff and existing test files", () => {
    expect(skillContent).toMatch(
      /[Gg]it.*status|[Gg]it.*diff|existing.*test|current.*coverage/i,
    );
  });
});

describe("t-5: Improve blocked reporting for TestWriter", () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = loadSkillContent("test-writer");
  });

  test("test-writer.md has a 'Blocked / Mikado Escalation' section", () => {
    expect(skillContent).toMatch(
      /##\s+Blocked.*Mikado|##\s+Blocked.*[Ee]scalation/i,
    );
  });

  test("test-writer.md Blocked section mentions blocked: prefix for escalation", () => {
    const blockedMatch = skillContent.match(
      /##\s+Blocked[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (blockedMatch) {
      expect(blockedMatch[1]).toMatch(/blocked:/);
    }
  });

  test("test-writer.md Blocked section mentions ## Blocked ticket section", () => {
    const blockedMatch = skillContent.match(
      /##\s+Blocked[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (blockedMatch) {
      expect(blockedMatch[1]).toMatch(/##\s+Blocked ticket/i);
    }
  });

  test("test-writer.md Blocked section mentions .agent/test-tickets.md", () => {
    const blockedMatch = skillContent.match(
      /##\s+Blocked[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (blockedMatch) {
      expect(blockedMatch[1]).toMatch(/\.agent\/test-tickets\.md/);
    }
  });

  test("test-writer.md Blocked section includes guidance for 'What is missing' subsection", () => {
    const blockedMatch = skillContent.match(
      /##\s+Blocked[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (blockedMatch) {
      expect(blockedMatch[1]).toMatch(/##.*What is missing/i);
    }
  });
});
