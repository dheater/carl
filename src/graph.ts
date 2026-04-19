export const HAPPY_PATH_GRAPH = [
  "architect",
  "developer",
  "verifier",
  "reviewer",
];

export const GATE_PHASES = new Set(["architect", "reviewer"]);

export function getNextPhase(currentPhase: string): string | null {
  const index = HAPPY_PATH_GRAPH.indexOf(currentPhase);
  if (index === -1 || index === HAPPY_PATH_GRAPH.length - 1) return null;
  return HAPPY_PATH_GRAPH[index + 1];
}

export function getFallbackPhase(currentPhase: string): string {
  switch (currentPhase) {
    case "verifier":
    case "reviewer":
      return "developer";
    case "developer":
      return "architect";
    default:
      return "architect";
  }
}

export function getPhaseModel(phase: string): string {
  if (phase === "architect") return "gpt5.1";
  if (phase === "reviewer") return "gemini-3.1-pro-preview";
  return "haiku4.5"; // developer, verifier, default
}
