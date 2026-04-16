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
  if (phase === 'dani' || phase.startsWith('dani-')) {
    return 'gpt5.4';
  }
  if (phase === 'grey' || phase.startsWith('grey-') || phase === 'qa-gate') {
    return 'haiku4.5';
  }
  if (phase === 'lewis' || phase.startsWith('lewis-') || phase === 'commit-review-gate') {
    return 'gemini-3.1-pro-preview';
  }
  // Default fallback
  return 'haiku4.5';
}
