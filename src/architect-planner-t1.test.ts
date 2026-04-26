import * as fs from "fs";
import * as path from "path";
import { HAPPY_PATH_GRAPH, GATE_PHASES, getNextPhase } from "./graph";

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

    test("architect.md describes two kinds of tickets: Coder and TestWriter", () => {
      expect(skillContent).toMatch(/Coder/);
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

    test("planner.md does not mention .agent/tickets.md (split ticket files only)", () => {
      plannerContent = fs.readFileSync(plannerPath, "utf-8");
      // Planner should not reference the monolithic tickets.md at all
      expect(plannerContent).not.toMatch(/\.agent\/tickets\.md/);
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

  describe("t-1 new AC: Enforce phase/tool separation", () => {
    describe("Skills/docs updated", () => {
      let architectContent: string;
      let reviewerContent: string;
      let verifierContent: string;

      beforeEach(() => {
        architectContent = fs.readFileSync(
          path.join(__dirname, "..", "skills", "architect.md"),
          "utf-8",
        );
        reviewerContent = fs.readFileSync(
          path.join(__dirname, "..", "skills", "reviewer.md"),
          "utf-8",
        );
        verifierContent = fs.readFileSync(
          path.join(__dirname, "..", "skills", "verifier.md"),
          "utf-8",
        );
      });

      test("architect.md states Architect can write .agent/dev-tickets.md and .agent/test-tickets.md", () => {
        expect(architectContent).toMatch(/may write/i);
        expect(architectContent).toMatch(/dev-tickets\.md/i);
        expect(architectContent).toMatch(/test-tickets\.md/i);
      });

      test("architect.md states Architect never edits source or test files", () => {
        expect(architectContent).toMatch(/never edits/i);
      });

      test("architect.md states Architect never runs tests", () => {
        expect(architectContent).toMatch(/never.*run.*test|does.*not.*run/i);
      });

      test("reviewer.md explicitly states it does not edit source or tests", () => {
        expect(reviewerContent).toMatch(
          /does.*not.*edit.*source|does.*not.*edit.*test/i,
        );
      });

      test("reviewer.md explicitly states it does not run tests", () => {
        expect(reviewerContent).toMatch(
          /does.*not.*run.*test|not.*run.*test|Do.*NOT.*run/i,
        );
      });

      test("verifier.md explicitly states it does not edit source (only tests/comments/dead code)", () => {
        expect(verifierContent).toMatch(/low-risk|subtract-first/i);
        expect(verifierContent).toMatch(/Code edits only/i);
      });

      test("verifier.md states it should not run tests", () => {
        expect(verifierContent).toMatch(/Do.*NOT.*run|Do not.*run/i);
      });
    });

    describe("Workflow graph and phase ordering", () => {
      test("HAPPY_PATH_GRAPH ensures architect is first phase", () => {
        expect(HAPPY_PATH_GRAPH[0]).toBe("architect");
      });

      test("HAPPY_PATH_GRAPH ensures developer comes before verifier", () => {
        expect(HAPPY_PATH_GRAPH.indexOf("developer")).toBeLessThan(
          HAPPY_PATH_GRAPH.indexOf("verifier"),
        );
      });

      test("HAPPY_PATH_GRAPH ensures verifier comes before reviewer", () => {
        expect(HAPPY_PATH_GRAPH.indexOf("verifier")).toBeLessThan(
          HAPPY_PATH_GRAPH.indexOf("reviewer"),
        );
      });

      test("getNextPhase returns developer after architect", () => {
        expect(getNextPhase("architect")).toBe("developer");
      });

      test("GATE_PHASES includes architect and reviewer, not developer", () => {
        expect(GATE_PHASES.has("architect")).toBe(true);
        expect(GATE_PHASES.has("reviewer")).toBe(true);
        expect(GATE_PHASES.has("developer")).toBe(false);
      });

      test("GATE_PHASES does not include verifier", () => {
        expect(GATE_PHASES.has("verifier")).toBe(false);
      });

      test("Happy path enforces architect → developer → verifier → reviewer order", () => {
        expect(HAPPY_PATH_GRAPH).toEqual([
          "architect",
          "developer",
          "verifier",
          "reviewer",
        ]);
      });

      test("After architect approval, next phase is developer (not verifier or reviewer)", () => {
        // Verify no short-circuit paths from architect
        expect(getNextPhase("architect")).toBe("developer");
        expect(getNextPhase("architect")).not.toBe("verifier");
        expect(getNextPhase("architect")).not.toBe("reviewer");
      });

      test("Architect is a gate phase (requires human approval)", () => {
        expect(GATE_PHASES.has("architect")).toBe(true);
      });

      test("Developer is not a gate phase (runs deterministically)", () => {
        expect(GATE_PHASES.has("developer")).toBe(false);
      });

      test("Reviewer is a gate phase (final approval)", () => {
        expect(GATE_PHASES.has("reviewer")).toBe(true);
      });
    });
  });
});
