export type CacheGeneration = {
  createdAt: string;
  generationId: string;
  totalBytes: number;
};

export function selectCacheGenerations<T extends CacheGeneration>({
  activeGeneration,
  generations,
  maxBytes,
  maxGenerations,
}: {
  activeGeneration: string;
  generations: T[];
  maxBytes: number;
  maxGenerations: number;
}): {
  kept: T[];
  removed: T[];
} {
  const sorted = [...generations].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  const kept: T[] = [];
  let bytes = 0;
  const active = sorted.find((generation) => generation.generationId === activeGeneration);
  if (active) {
    kept.push(active);
    bytes += active.totalBytes;
  }
  for (const generation of sorted) {
    if (
      generation.generationId === activeGeneration ||
      kept.length >= maxGenerations ||
      bytes + generation.totalBytes > maxBytes
    ) {
      continue;
    }
    kept.push(generation);
    bytes += generation.totalBytes;
  }
  const keptIds = new Set(kept.map((generation) => generation.generationId));
  return {
    kept,
    removed: sorted.filter((generation) => !keptIds.has(generation.generationId)),
  };
}
