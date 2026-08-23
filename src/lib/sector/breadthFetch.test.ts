import { describe, it, expect } from 'vitest';
import { chunkSymbols, SPARK_MAX_SYMBOLS } from '../../../api/yahoo';
import { SECTOR_ETFS, BREADTH_SETTINGS } from '../../config/sectorConfig';

// Yahoo's spark endpoint 400s above 20 symbols. Requesting all ~165 sector
// constituents at once returned nothing, and because breadth silently degrades
// to null, every sector's Breadth column read "unavail." with no error shown.
describe('spark request chunking', () => {
  const allConstituents = SECTOR_ETFS.flatMap(s => s.constituents);

  it('the full constituent list exceeds what one request allows', () => {
    // If this ever stops being true the chunking is harmless, but the guard
    // below is what actually matters.
    expect(allConstituents.length).toBeGreaterThan(SPARK_MAX_SYMBOLS);
  });

  it('never emits a chunk larger than the endpoint accepts', () => {
    for (const chunk of chunkSymbols(allConstituents)) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(SPARK_MAX_SYMBOLS);
    }
  });

  it('covers every symbol exactly once, in order', () => {
    const flat = chunkSymbols(allConstituents).flat();
    expect(flat).toEqual(allConstituents);
    expect(new Set(flat).size).toBe(new Set(allConstituents).size);
  });

  it('handles empty and exact-multiple inputs', () => {
    expect(chunkSymbols([])).toEqual([]);
    const exact = Array.from({ length: SPARK_MAX_SYMBOLS * 3 }, (_, i) => `T${i}`);
    const chunks = chunkSymbols(exact);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(c => c.length === SPARK_MAX_SYMBOLS)).toBe(true);
  });

  it('rejects a nonsensical chunk size rather than looping forever', () => {
    expect(() => chunkSymbols(['A', 'B'], 0)).toThrow();
  });

  // Each chunk is one sector's worth of names or fewer, so a single failed
  // chunk must not drop a sector below the minimum needed to score breadth.
  it('every sector has enough constituents to produce a breadth score', () => {
    for (const s of SECTOR_ETFS) {
      expect(s.constituents.length).toBeGreaterThanOrEqual(BREADTH_SETTINGS.minConstituents);
    }
  });
});
