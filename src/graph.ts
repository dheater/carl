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

export function getFallbackPhase(currentPhase: string): string {
  switch (currentPhase) {
    case 'qa-gate':
      return 'dani';
    case 'lewis-qa':
    case 'lewis':
    case 'commit-review-gate':
      return 'grey';
    case 'grey':
      return 'dani';
    default:
      return 'dani';
  }
}

export function getPhaseModel(phase: string): string {
  if (phase === 'dani') {
    return 'opus4.5';
  }
  return 'sonnet4.6';
}
