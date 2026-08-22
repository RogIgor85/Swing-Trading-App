// ─────────────────────────────────────────────────────────────────────────────
// Intentional sector overrides.
//
// Legacy holdings carry a `sector` value chosen in the Add form long before
// provider detection existed, so a stored value that disagrees with the
// provider is NOT evidence of an intentional override — it is usually stale
// (e.g. TSLA saved as "Technology"). Provider classification therefore wins by
// default, and only tickers the user deliberately pins are recorded here.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'swing_sector_overrides';

type OverrideMap = Record<string, string>;   // TICKER → sector label

function readAll(): OverrideMap {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as OverrideMap; } catch { return {}; }
}

function writeAll(m: OverrideMap) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* quota */ }
}

export function loadSectorOverrides(): OverrideMap {
  return readAll();
}

export function setSectorOverride(ticker: string, sector: string): OverrideMap {
  const all = readAll();
  all[ticker.toUpperCase()] = sector;
  writeAll(all);
  return all;
}

/** Clear the pin so provider classification takes over again. */
export function clearSectorOverride(ticker: string): OverrideMap {
  const all = readAll();
  delete all[ticker.toUpperCase()];
  writeAll(all);
  return all;
}
