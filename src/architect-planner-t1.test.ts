import * as fs from "fs";
import * as path from "path";

describe("t-1: Strengthen Architect/Planner specs and introduce per-agent ticket files", () => {
  describe("skills/architect.md", () => {
    let skillContent: string;

    beforeEach(() => {
      const skillPath = path.join(__dirname, "..", "skills", "architect.md");
      skillContent = fs.readFileSync(skillPath, "utf-8");
    });

    test("architect.md explicitly states it must read relevant code, tests, PRDs, and .agent/* before asking questions", () => {
      expect(skillContent).toMatch(/read.*code.*tests.*PRDs?.*\.agent/is);
    });

    test("architect.md provides concrete example of question that must be answered from the repo", () => {
      // Should mention reading code before asking (e.g., a question like "Do we have a verifier phase?")
      expect(skillContent).toMatch(
        /questions answerable by reading code|answer.*from.*code/is,
      );
    });

    test("architect.md describes two kinds of tickets: Developer and TestWriter", () => {
      expect(skillContent).toMatch(/Developer/);
      expect(skillContent).toMatch(/TestWriter|test.?writer/i);
      expect(skillContent).toMatch(/implementation|regression.?test/i);
    });
  });

  describe("skills/planner.md", () => {
    let plannerPath: string;
    let plannerContent: string;

    beforeEach(() => {
      plannerPath = path.join(__dirname, "..", "skills", "planner.md");
    });

    test("planner.md has valid YAML frontmatter", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      const frontmatterMatch = plannerContent.match(/^---\n([\s\S]*?)\n---\n/);
      expect(frontmatterMatch).toBeTruthy();
    });

    test("planner.md frontmatter includes required fields", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      const frontmatterMatch = plannerContent.match(/^---\n([\s\S]*?)\n---\n/);
      expect(frontmatterMatch).toBeTruthy();

      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toMatch(/type:\s*agent_requested/);
      expect(frontmatter).toMatch(/name:\s*Planner/);
      expect(frontmatter).toMatch(/description:/);
    });

    test("planner.md describes writing .agent/dev-tickets.md", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      expect(plannerContent).toMatch(/\.agent\/dev-tickets\.md/);
    });

    test("planner.md describes writing .agent/test-tickets.md", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      expect(plannerContent).toMatch(/\.agent\/test-tickets\.md/);
    });

    test("planner.md clarifies that .agent/tickets.md is not primary for new work", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      expect(plannerContent).toMatch(
        /\.agent\/tickets\.md|monolithic|not.*primary|legacy/i,
      );
    });

    test("planner.md states each file uses standard ticket format", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      expect(plannerContent).toMatch(/ticket format|## \[ \] t-|AC\)/i);
    });

    test("planner.md notes Planner is the single writer for these files", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      expect(plannerContent).toMatch(
        /single writer|only writer|Planner.*write/i,
      );
    });
  });
});
