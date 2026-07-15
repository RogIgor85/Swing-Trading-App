// Full-data JSON backup & restore.
// Backup: downloads every table's rows as one JSON file.
// Restore: re-inserts rows that don't already exist (matched by id) — never
// overwrites or deletes existing data, so it's safe to run on a live account.

import { storage } from './storage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const TABLES = [
  'holdings',
  'watch_items',
  'trade_journal',
  'fundamentals',
  'net_worth_items',
  'option_trades',
  'sprint_settings',
  'sprint_positions',
  'sprint_trades',
  'sprint_plans',
] as const;

interface BackupFile {
  app: 'swing-trading-app';
  version: 1;
  createdAt: string;
  tables: Record<string, Row[]>;
}

export async function downloadBackup(): Promise<void> {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES) {
    try {
      tables[t] = await storage.getAll<Row>(t);
    } catch {
      tables[t] = []; // table may not exist — skip quietly
    }
  }

  const payload: BackupFile = {
    app: 'swing-trading-app',
    version: 1,
    createdAt: new Date().toISOString(),
    tables,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const stamp = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `swing-trading-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface RestoreResult {
  restored: Record<string, number>;
  skipped: Record<string, number>;
  errors: string[];
}

export async function restoreBackup(file: File): Promise<RestoreResult> {
  const text = await file.text();
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (parsed.app !== 'swing-trading-app' || !parsed.tables) {
    throw new Error('This file is not a swing-trading-app backup.');
  }

  const result: RestoreResult = { restored: {}, skipped: {}, errors: [] };

  for (const t of TABLES) {
    const rows = parsed.tables[t];
    if (!rows || rows.length === 0) continue;

    let existingIds = new Set<string>();
    try {
      const existing = await storage.getAll<Row>(t);
      existingIds = new Set(existing.map(r => String(r.id)));
    } catch {
      result.errors.push(`${t}: could not read existing rows — skipped`);
      continue;
    }

    let restored = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.id && existingIds.has(String(row.id))) { skipped++; continue; }
      try {
        // user_id is stamped by storage.insert for the signed-in user;
        // strip any old one so restores work across accounts
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { user_id: _ignored, ...clean } = row;
        await storage.insert(t, clean);
        restored++;
      } catch (e) {
        result.errors.push(`${t}: row ${row.id ?? '?'} failed (${e instanceof Error ? e.message : 'unknown'})`);
      }
    }
    if (restored > 0) result.restored[t] = restored;
    if (skipped > 0)  result.skipped[t]  = skipped;
  }

  return result;
}
