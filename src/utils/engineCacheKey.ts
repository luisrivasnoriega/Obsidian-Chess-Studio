function hashStringFnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashMoves(moves: string[]): string {
  let hashA = 2166136261;
  let hashB = 2166136261 ^ 0x9e3779b9;

  for (const move of moves) {
    hashA = hashStringFnv1a(move, hashA);
    // Delimiter so sequences like ["ab","c"] and ["a","bc"] don't collide trivially.
    hashA = hashStringFnv1a(",", hashA);

    // Second lane with reversed input to reduce collision probability.
    const reversed = move.split("").reverse().join("");
    hashB = hashStringFnv1a(reversed, hashB);
    hashB = hashStringFnv1a(";", hashB);
  }

  return `${hashA.toString(36)}${hashB.toString(36)}`;
}

export function buildEngineVariationCacheKey(fen: string, moves: string[]): string {
  if (moves.length === 0) {
    return `${fen}:0:0`;
  }
  return `${fen}:${moves.length}:${hashMoves(moves)}`;
}
