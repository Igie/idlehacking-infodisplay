// Recorded combat data: data/combat.json.gz (written by tools/compact-combat.mjs) merged with any
// idlehacking-combat*.json(.gz) exports (ihInfoDisplay.exportCombat(), yours or from GitHub issues)
// still in the project root.
//
// The archive keeps every export's game state as a snapshot (oldest first) and each recorded
// fight, round log and message once. Fights are matched on their recording time; a fight whose
// number is already taken (a reset or another browser) gets the next free one, and its round
// log moves with it.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const ARCHIVE = path.join('data', 'combat.json.gz');

export function exportFiles(root) {
  return readdirSync(root).filter((f) => /^idlehacking-combat.*\.json(\.gz)?$/.test(f)).map((f) => path.join(root, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

// The script gzips its exports where the browser can (CompressionStream); older ones are plain JSON.
export const readExport = (file) => {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
};

export function readArchive(root) {
  const file = path.join(root, ARCHIVE);
  return existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) : null;
}

export const emptyArchive = () => ({ format: 'ih-combat-archive', version: 1, snapshots: [], recorded: { fights: [], logs: [], events: [] } });
const snapshotOf = (exp) => Object.fromEntries(Object.entries(exp).filter(([k]) => k !== 'recorded'));
export const withoutN = (x) => JSON.stringify({ ...x, n: undefined });
const eventKey = (e) => `${e.type}|${e.at}`;

// Adds exports (parsed) to an archive in place; returns how many new records each brought, in the
// order given (they are merged oldest first).
export function mergeInto(archive, exports) {
  const { fights, logs, events } = archive.recorded;
  const fightAt = new Map(fights.map((f) => [f.at, f]));
  const fightN = new Set(fights.map((f) => f.n));
  const logN = new Set(logs.map((l) => l.n));
  const eventKeys = new Set(events.map(eventKey));
  const eventN = new Set(events.map((e) => e.n));
  const snaps = new Set(archive.snapshots.map((s) => JSON.stringify(s)));
  let maxFightN = fights.reduce((m, f) => Math.max(m, f.n), 0), maxEventN = events.reduce((m, e) => Math.max(m, e.n), 0);
  const added = new Map();
  for (const exp of [...exports].sort((a, b) => String(a.exported_at).localeCompare(String(b.exported_at)))) {
    const count = { fights: 0, logs: 0, events: 0, renumbered: 0 };
    const snap = snapshotOf(exp);
    if (!snaps.has(JSON.stringify(snap))) {
      snaps.add(JSON.stringify(snap));
      archive.snapshots.push(snap);
    }
    const rec = exp.recorded || {};
    const nMap = new Map(); // this export's fight number -> archive fight number
    for (const f of rec.fights || []) {
      const have = fightAt.get(f.at);
      if (have) { nMap.set(f.n, have.n); continue; }
      let n = f.n;
      if (fightN.has(n)) { n = ++maxFightN; count.renumbered++; }
      maxFightN = Math.max(maxFightN, n);
      const fight = n === f.n ? f : { ...f, n };
      fights.push(fight); fightAt.set(f.at, fight); fightN.add(n); nMap.set(f.n, n);
      count.fights++;
    }
    for (const l of rec.logs || []) {
      const n = nMap.get(l.n) ?? l.n;
      if (logN.has(n)) continue;
      logs.push(n === l.n ? l : { ...l, n }); logN.add(n);
      count.logs++;
    }
    for (const e of rec.events || []) {
      if (eventKeys.has(eventKey(e))) continue;
      let n = e.n;
      if (eventN.has(n)) n = ++maxEventN;
      maxEventN = Math.max(maxEventN, n);
      events.push(n === e.n ? e : { ...e, n }); eventKeys.add(eventKey(e)); eventN.add(n);
      count.events++;
    }
    added.set(exp, count);
  }
  archive.snapshots.sort((a, b) => String(a.exported_at).localeCompare(String(b.exported_at)));
  fights.sort((a, b) => a.n - b.n);
  logs.sort((a, b) => a.n - b.n);
  events.sort((a, b) => a.n - b.n);
  return exports.map((exp) => added.get(exp));
}

// Everything recorded, shaped like a single export (newest game state + all records), plus every
// snapshot and where it came from.
export function loadCombatData(root) {
  const archive = readArchive(root) || emptyArchive();
  const files = exportFiles(root);
  mergeInto(archive, files.map(readExport));
  if (!archive.snapshots.length) throw new Error(`no ${ARCHIVE} or idlehacking-combat*.json in the project root (ihInfoDisplay.exportCombat())`);
  const sources = [...(existsSync(path.join(root, ARCHIVE)) ? [ARCHIVE] : []), ...files.map((f) => path.basename(f))];
  return { data: { ...archive.snapshots.at(-1), recorded: archive.recorded }, snapshots: archive.snapshots, sources, archive };
}

