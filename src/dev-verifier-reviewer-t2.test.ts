import * as fs from "fs";
import * as path from "path";

describe("t-2: Update Coder/Verifier/Reviewer skills for split tickets", () => {
  describe("skills/developer.md", () => {
    let skillContent: string;

    beforeEach(() => {
      const skillPath = path.join(__dirname, "..", "skills", "developer.md");
      skillContent = fs.readFileSync(skillPath, "utf-8");
    });

    test("developer.md 'Starting a Session' instructs to read .agent/dev-tickets.md", () => {
      expect(skillContent).toMatch(/\.agent\/dev-tickets\.md/);
    });

    test("developer.md distinguishes ephemeral *.dev.test.ts as temporary Coder-owned tests", () => {
      expect(skillContent).toMatch(/\*\.dev\.test\.ts|dev\.test/i);
      expect(skillContent).toMatch(/ephemeral|temporary/i);
      expect(skillContent).toMatch(/Coder/);
    });

    test("developer.md distinguishes durable tests as long-lived and not auto-deleted", () => {
      expect(skillContent).toMatch(/durable|long-lived/i);
      expect(skillContent).toMatch(/\*\.test\.ts|not.*delete/i);
    });
  });

  describe("skills/verifier.md", () => {
    let skillContent: string;

    beforeEach(() => {
      const skillPath = path.join(__dirname, "..", "skills", "verifier.md");
      skillContent = fs.readFileSync(skillPath, "utf-8");
    });

    test("verifier.md mentions both .agent/dev-tickets.md and .agent/test-tickets.md", () => {
      expect(skillContent).toMatch(/\.agent\/dev-tickets\.md/);
      expect(skillContent).toMatch(/\.agent\/test-tickets\.md/);
    });

    test("verifier.md Recommendations section includes 'Recommendations for Developer' heading", () => {
      expect(skillContent).toMatch(/Recommendations for Developer/);
    });

    test("verifier.md Recommendations section includes 'Recommendations for TestWriter' heading", () => {
      expect(skillContent).toMatch(/Recommendations for TestWriter/);
    });

    test("verifier.md states implementation/code issues should become Developer tickets", () => {
      expect(skillContent).toMatch(/implementation|code.*Developer.*ticket/is);
    });

    test("verifier.md states weak regression tests should become TestWriter tickets", () => {
      expect(skillContent).toMatch(/regression|behavior.*TestWriter.*ticket/is);
    });
  });

  describe("skills/reviewer.md", () => {
    let skillContent: string;

    beforeEach(() => {
      const skillPath = path.join(__dirname, "..", "skills", "reviewer.md");
      skillContent = fs.readFileSync(skillPath, "utf-8");
    });

    test("reviewer.md references both .agent/dev-tickets.md and .agent/test-tickets.md", () => {
      expect(skillContent).toMatch(/\.agent\/dev-tickets\.md/);
      expect(skillContent).toMatch(/\.agent\/test-tickets\.md/);
    });

    test("reviewer.md notes regression-test gaps should route to TestWriter tickets", () => {
      expect(skillContent).toMatch(/regression.*TestWriter|gap.*TestWriter/i);
    });

    test("reviewer.md does not treat .agent/tickets.md as primary for new work", () => {
      // Should mention per-agent files as the primary, not tickets.md
      const hasPrimaryPerAgent =
        skillContent.includes(".agent/dev-tickets.md") &&
        skillContent.includes(".agent/test-tickets.md");
      expect(hasPrimaryPerAgent).toBe(true);
    });
  });
});
