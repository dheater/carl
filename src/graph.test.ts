import {
  HAPPY_PATH_GRAPH,
  getPhaseModel,
  GATE_PHASES,
  getNextPhase,
} from "./graph";

describe("Workflow graph - verifier phase addition (t-1)", () => {
  test("HAPPY_PATH_GRAPH is exactly ['architect', 'developer', 'verifier', 'reviewer']", () => {
    expect(HAPPY_PATH_GRAPH).toEqual([
      "architect",
      "developer",
      "verifier",
      "reviewer",
    ]);
  });

  test("HAPPY_PATH_GRAPH includes verifier in the correct position", () => {
    expect(HAPPY_PATH_GRAPH).toContain("verifier");
    expect(HAPPY_PATH_GRAPH.indexOf("verifier")).toBe(2);
  });

  test("getPhaseModel handles architect, developer, verifier, and reviewer", () => {
    expect(getPhaseModel("architect")).toBe("gpt5.1");
    expect(getPhaseModel("developer")).toBe("haiku4.5");
    expect(getPhaseModel("verifier")).toBe("code-review");
    expect(getPhaseModel("reviewer")).toBe("code-review");
  });

  test("GATE_PHASES only includes architect and reviewer, not verifier or developer", () => {
    expect(GATE_PHASES.has("architect")).toBe(true);
    expect(GATE_PHASES.has("reviewer")).toBe(true);
    expect(GATE_PHASES.has("verifier")).toBe(false);
    expect(GATE_PHASES.has("developer")).toBe(false);
  });

  test("getNextPhase returns verifier when called with developer", () => {
    expect(getNextPhase("developer")).toBe("verifier");
  });

  test("getNextPhase returns reviewer when called with verifier", () => {
    expect(getNextPhase("verifier")).toBe("reviewer");
  });
});
