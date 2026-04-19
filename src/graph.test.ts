import { HAPPY_PATH_GRAPH, getPhaseModel, GATE_PHASES } from "./graph";

describe("Workflow graph - verifier phase removal (t-1)", () => {
  test("HAPPY_PATH_GRAPH is exactly ['architect', 'developer', 'reviewer']", () => {
    expect(HAPPY_PATH_GRAPH).toEqual(["architect", "developer", "reviewer"]);
  });

  test("HAPPY_PATH_GRAPH does not include 'verifier'", () => {
    expect(HAPPY_PATH_GRAPH).not.toContain("verifier");
  });

  test("getPhaseModel only handles architect, developer, and reviewer; no verifier case", () => {
    expect(getPhaseModel("architect")).toBe("gpt5.1");
    expect(getPhaseModel("developer")).toBe("haiku4.5");
    expect(getPhaseModel("reviewer")).toBe("gemini-3.1-pro-preview");
    // "verifier" should not be a special case; it should fall to default
    expect(getPhaseModel("verifier")).toBe("haiku4.5");
  });

  test("GATE_PHASES only includes architect and reviewer, not verifier", () => {
    expect(GATE_PHASES.has("architect")).toBe(true);
    expect(GATE_PHASES.has("reviewer")).toBe(true);
    expect(GATE_PHASES.has("verifier")).toBe(false);
    expect(GATE_PHASES.has("developer")).toBe(false);
  });
});
