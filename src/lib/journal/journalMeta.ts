// ─────────────────────────────────────────────────────────────────────────────
// Trade Journal structured metadata sidecar.
//
// Entry/exit reasons, plan adherence, mistake tags and sector snapshots live in
// localStorage keyed by trade id — the trade_journal schema is untouched, so
// existing rows and inserts cannot break. `strategy` and `notes` already exist
// as real columns and continue to be stored there.
//
// Sector snapshots are written ONCE, at entry and at exit. They are never
// recomputed from current data — a historical trade with no snapshot shows N/A.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExitReason, MistakeCategory, FollowedPlan } from '../../config/journalConfig';

export interface SectorSnapshot {
  /** ISO timestamp when this snapshot was captured. */
  capturedAt: string;
  sectorLabel: string;
  sectorEtf: string | null;
  rotationPressure: number | null;
  rotationStatus: string | null;
  pressureDelta5D: number | null;
  stockVsSector1M: number | null;
}

export interface JournalMeta {
  entry_reason?: string;
  exit_reason?: ExitReason;
  exit_note?: string;
  followed_plan?: FollowedPlan;
  followed_plan_note?: string;
  mistake?: boolean;
  mistake_category?: MistakeCategory;
  sector_entry?: SectorSnapshot;
  sector_exit?: SectorSnapshot;
}

const KEY = 'swing_journal_meta';
type MetaMap = Record<string, JournalMeta>;

function readAll(): MetaMap {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as MetaMap; } catch { return {}; }
}
function writeAll(m: MetaMap) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* quota */ }
}

export function loadJournalMeta(): MetaMap { return readAll(); }

export function getJournalMeta(id: string): JournalMeta { return readAll()[id] ?? {}; }

export function setJournalMeta(id: string, patch: JournalMeta): MetaMap {
  const all = readAll();
  all[id] = { ...all[id], ...patch };
  writeAll(all);
  return all;
}

export function removeJournalMeta(id: string): void {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

/**
 * Capture a snapshot only if one doesn't already exist for that phase.
 * Entry conditions must never be overwritten by later market data.
 */
export function captureSnapshotOnce(
  id: string,
  phase: 'entry' | 'exit',
  snapshot: SectorSnapshot,
): MetaMap {
  const all = readAll();
  const key = phase === 'entry' ? 'sector_entry' : 'sector_exit';
  if (all[id]?.[key]) return all;             // already captured — leave it alone
  all[id] = { ...all[id], [key]: snapshot };
  writeAll(all);
  return all;
}
