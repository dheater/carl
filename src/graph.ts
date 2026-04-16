export const HAPPY_PATH_GRAPH = [
  'dani',
  'dani-tickets',
  'grey',
  'qa-gate',
  'lewis-qa',
  'lewis',
  'commit-review-gate'
];

export function getNextPhase(currentPhase: string): string | null {
  const index = HAPPY_PATH_GRAPH.indexOf(currentPhase);
  if (index === -1 || index === HAPPY_PATH_GRAPH.length - 1) {
    return null;
  }
  return HAPPY_PATH_GRAPH[index + 1];
}

export function getPriorPhase(currentPhase: string): string | null {
  const index = HAPPY_PATH_GRAPH.indexOf(currentPhase);
  if (index <= 0) {
    return null;
  }
  return HAPPY_PATH_GRAPH[index - 1];
}
