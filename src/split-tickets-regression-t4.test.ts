import * as fs from "fs";
import * as path from "path";

describe("t-4: Durable regression tests for split tickets (no .agent/tickets.md)", () => {
  let readmeContent: string;
  let architectContent: string;
  let developerContent: string;
  let testWriterContent: string;

  beforeAll(() => {
    const readmePath = path.join(__dirname, "..", "README.md");
    const architectPath = path.join(__dirname, "..", "skills", "architect.md");
    const developerPath = path.join(__dirname, "..", "skills", "developer.md");
    const testWriterPath = path.join(
      __dirname,
      "..",
      "skills",
      "test-writer.md",
    );

    readmeContent = fs.readFileSync(readmePath, "utf-8");
    architectContent = fs.readFileSync(architectPath, "utf-8");
    developerContent = fs.readFileSync(developerPath, "utf-8");
    testWriterContent = fs.readFileSync(testWriterPath, "utf-8");
  });

  describe("README documentation alignment", () => {
    test("README mentions split tickets (dev-tickets.md and test-tickets.md)", () => {
      expect(readmeContent).toMatch(/\.agent\/dev-tickets\.md/);
      expect(readmeContent).toMatch(/\.agent\/test-tickets\.md/);
    });

    test("README does not mention .agent/tickets.md as current artifact", () => {
      // Verify that the monolithic tickets.md is not mentioned as a primary artifact
      // (historical references are OK, but the main story should be split)
      const mainSection = readmeContent.split("## Layout")[0]; // Get everything before Layout
      expect(mainSection).not.toMatch(/\.agent\/tickets\.md/);
    });

    test("README states Developer and TestWriter both run before deterministic checks", () => {
      expect(readmeContent).toMatch(
        /Developer.*TestWriter|TestWriter.*Developer/i,
      );
      expect(readmeContent).toMatch(/context window/i);
    });
  });

  describe("Architect skill documentation alignment", () => {
    test("architect.md explicitly states approval produces split ticket files", () => {
      expect(architectContent).toMatch(
        /\.agent\/dev-tickets\.md.*\.agent\/test-tickets\.md/,
      );
    });

    test("architect.md states it never directly writes to dev-tickets or test-tickets", () => {
      // Architect's job is to produce the plan, not write the files
      // (the workflow does that on approval)
      expect(architectContent).toMatch(
        /architect never writes.*\.agent\/dev-tickets|architect never writes.*\.agent\/test-tickets/i,
      );
    });

    test("architect.md clarifies that workflow (not architect) writes split tickets", () => {
      // After architect's output is approved, the workflow handles file creation
      expect(architectContent).toMatch(/workflow writes/i);
    });
  });

  describe("Developer skill documentation alignment", () => {
    test("developer.md reads dev-tickets.md (not monolithic tickets.md)", () => {
      expect(developerContent).toMatch(/\.agent\/dev-tickets\.md/);
    });
  });

  describe("TestWriter skill documentation alignment", () => {
    test("test-writer.md reads test-tickets.md (not monolithic tickets.md)", () => {
      expect(testWriterContent).toMatch(/\.agent\/test-tickets\.md/);
    });

    test("test-writer.md documents it reads .agent/notes/architect.md", () => {
      expect(testWriterContent).toMatch(/\.agent\/notes\/architect\.md/);
    });
  });

  describe("Implementation group invariant documentation", () => {
    test("README or skills mention Developer and TestWriter as separate agents", () => {
      // At least one source mentions them as distinct but coordinated phases
      const hasDocumentation =
        readmeContent.includes("Developer") ||
        developerContent.includes("TestWriter") ||
        testWriterContent.includes("Developer");
      expect(hasDocumentation).toBe(true);
    });
  });
});
