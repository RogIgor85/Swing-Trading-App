// ─────────────────────────────────────────────────────────────────────────────
// Watch List structured metadata sidecar.
//
// Thesis / Entry Trigger / Catalyst / Last Reviewed live in localStorage keyed
// by watch item id, NOT in the Supabase row. This keeps the existing
// watch_items schema untouched — no migration required and no risk of an
// insert failing because a column doesn't exist. Existing `notes` are never
// modified; they seed the Thesis display until the user edits it.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'swing_watch_meta';

export interface WatchMeta {
  thesis?: string;
  trigger?: string;
  catalyst?: string;
  catalyst_date?: string;   // YYYY-MM-DD
  last_reviewed?: string;   // YYYY-MM-DD
  thesis_broken?: boolean;
  sector_etf?: string;      // manual override of detected sector
}

type MetaMap = Record<string, WatchMeta>;

function readAll(): MetaMap {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as MetaMap; } catch { return {}; }
}

function writeAll(m: MetaMap) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* quota */ }
}

export function loadWatchMeta(): MetaMap {
  return readAll();
}

export function getWatchMeta(id: string): WatchMeta {
  return readAll()[id] ?? {};
}

export function setWatchMeta(id: string, patch: WatchMeta): MetaMap {
  const all = readAll();
  all[id] = { ...all[id], ...patch };
  writeAll(all);
  return all;
}

export function markReviewed(id: string): MetaMap {
  return setWatchMeta(id, { last_reviewed: new Date().toISOString().split('T')[0] });
}

export function removeWatchMeta(id: string): void {
  const all = readAll();
  delete all[id];
  writeAll(all);
}
