// Folds every idlehacking-combat*.json(.gz) export in the project root into data/combat.json.gz, checks
// that the archive now holds each export's game state and every fight, round log and message, and
// then deletes those exports.
//
//   node tools/compact-combat.mjs [--keep]     --keep leaves the exports in place

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ARCHIVE, emptyArchive, exportFiles, mergeInto, readArchive, readExport, withoutN } from './combat-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const files = exportFiles(root);
if (!files.length) {
  console.log('no idlehacking-combat*.json(.gz) in the project root, nothing to compact');
  process.exit(0);
}

const archive = readArchive(root) || emptyArchive();
const before = { ...Object.fromEntries(Object.entries(archive.recorded).map(([k, v]) => [k, v.length])), snapshots: archive.snapshots.length };
const exports = files.map(readExport);
const added = mergeInto(archive, exports);
added.forEach((a, i) => {
  console.log(`${path.basename(files[i])}: ${a.fights} new fights, ${a.logs} new round logs, ${a.events} new messages${a.renumbered ? `, ${a.renumbered} renumbered` : ''}`);
});

const out = path.join(root, ARCHIVE);
writeFileSync(`${out}.tmp`, gzipSync(JSON.stringify(archive), { level: 9 }));
renameSync(`${out}.tmp`, out);

// Read it back and look for every record of every export.
const saved = readArchive(root);
const snaps = new Set(saved.snapshots.map((s) => JSON.stringify(s)));
const byAt = new Map(saved.recorded.fights.map((f) => [f.at, f]));
const logByN = new Map(saved.recorded.logs.map((l) => [l.n, l]));
const events = new Map(saved.recorded.events.map((e) => [`${e.type}|${e.at}`, e]));
const problems = [];
exports.forEach((exp, i) => {
  const name = path.basename(files[i]);
  const { recorded = {}, ...snap } = exp;
  if (!snaps.has(JSON.stringify(snap))) problems.push(`${name}: game state missing`);
  const nMap = new Map();
  for (const f of recorded.fights || []) {
    const got = byAt.get(f.at);
    if (!got || withoutN(got) !== withoutN(f)) problems.push(`${name}: fight #${f.n} missing or different`);
    else nMap.set(f.n, got.n);
  }
  for (const l of recorded.logs || []) {
    const got = logByN.get(nMap.get(l.n) ?? -1);
    if (!got || withoutN(got) !== withoutN(l)) problems.push(`${name}: round log #${l.n} missing or different`);
  }
  for (const e of recorded.events || []) {
    const got = events.get(`${e.type}|${e.at}`);
    if (!got || withoutN(got) !== withoutN(e)) problems.push(`${name}: message #${e.n} missing or different`);
  }
});

const r = saved.recorded;
const size = (readFileSync(out).length / 1e6).toFixed(1);
console.log(`\n${ARCHIVE} (${size} MB): ${r.fights.length} fights (+${r.fights.length - before.fights}), ${r.logs.length} round logs ` +
  `(+${r.logs.length - before.logs}), ${r.events.length} messages (+${r.events.length - before.events}), ${saved.snapshots.length} snapshots (+${saved.snapshots.length - before.snapshots})`);
if (problems.length) {
  console.log(`\nFAIL, exports kept:\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  ... ${problems.length - 20} more` : ''}`);
  process.exit(1);
}
if (keep) {
  console.log('everything is in the archive; exports kept (--keep)');
} else {
  for (const f of files) unlinkSync(f);
  console.log(`everything is in the archive; deleted ${files.map((f) => path.basename(f)).join(', ')}`);
}
