import { describe, expect, it } from 'vitest';

import { selectCacheGenerations } from '../src/cachePolicy';

const generations = [
  { createdAt: '2026-01-03T00:00:00.000Z', generationId: 'current', totalBytes: 40 },
  { createdAt: '2026-01-02T00:00:00.000Z', generationId: 'previous', totalBytes: 35 },
  { createdAt: '2026-01-01T00:00:00.000Z', generationId: 'oldest', totalBytes: 30 },
];

describe('cache generation policy', () => {
  it('keeps the active generation and one rollback generation by default', () => {
    const result = selectCacheGenerations({
      activeGeneration: 'current',
      generations,
      maxBytes: 100,
      maxGenerations: 2,
    });

    expect(result.kept.map((item) => item.generationId)).toEqual(['current', 'previous']);
    expect(result.removed.map((item) => item.generationId)).toEqual(['oldest']);
  });

  it('honors the byte budget without evicting the active generation', () => {
    const result = selectCacheGenerations({
      activeGeneration: 'current',
      generations,
      maxBytes: 60,
      maxGenerations: 3,
    });

    expect(result.kept.map((item) => item.generationId)).toEqual(['current']);
    expect(result.removed).toHaveLength(2);
  });
});
