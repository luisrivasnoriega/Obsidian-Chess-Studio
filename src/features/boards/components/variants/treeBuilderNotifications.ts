export type TreeBuilderTranslator = (key: string, options?: Record<string, unknown>) => string;

type WarningMatch = {
  pattern: RegExp;
  key: string;
  params?: (match: RegExpExecArray) => Record<string, unknown>;
};

const warningMatches: WarningMatch[] = [
  {
    pattern: /^SMART stopped at positions with fewer than (\d+) source games\.$/,
    key: "features.board.variants.treeBuilder.warnings.smartLowSourceGames",
    params: (match) => ({ minSourceGames: match[1] }),
  },
  {
    pattern: /^SMART could not find a fully validated move and fell back to the best engine move\.$/,
    key: "features.board.variants.treeBuilder.warnings.smartValidationFallback",
  },
  {
    pattern:
      /^SMART could not produce a candidate in at least one visible branch and fell back to the best engine move\.$/,
    key: "features.board.variants.treeBuilder.warnings.smartCandidateFallback",
  },
  {
    pattern:
      /^Lichess explorer request budget was exhausted before all visible branches reached the requested depth\.$/,
    key: "features.board.variants.treeBuilder.warnings.lichessBudgetExhausted",
  },
];

export function normalizeTreeBuilderWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];

  return warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);
}

export function translateTreeBuilderWarning(warning: string, t: TreeBuilderTranslator): string {
  const trimmed = warning.trim();

  for (const item of warningMatches) {
    const match = item.pattern.exec(trimmed);
    if (match) {
      return t(item.key, item.params?.(match));
    }
  }

  return trimmed;
}

export function shouldShowTreeBuilderDone(expandedAny: boolean): boolean {
  return expandedAny;
}
