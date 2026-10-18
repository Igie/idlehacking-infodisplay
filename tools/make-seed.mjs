// Builds src/tier-seed.json from item exports (files saved by ihInfoDisplay.exportAffixes()):
// every tier boundary the exported items pin down. The build inlines it into the script, so
// the upgrade preview starts with these instead of an empty table.
//
//   node tools/make-seed.mjs          reads idlehacking-affixes*.json(.gz) in the project root and data/*.json
//   node tools/make-seed.mjs --merge  also folds the root exports into data/items.json and deletes them
//
// Exports from GitHub issues work the same way: save them in the project root.
// Uses the same formulas as scaling() / tierValueInterval() in src/infodisplay.user.js; keep them in sync.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExport } from './combat-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'tier-seed.json');
const dataDir = path.join(root, 'data');
const merged = path.join(dataDir, 'items.json');
const UTILITY_PREFIXES = new Set(['prefix_item_rarity', 'prefix_drop_boost']);

const jsonIn = (dir, pattern) => (existsSync(dir) ? readdirSync(dir).filter((f) => pattern.test(f)).map((f) => path.join(dir, f)) : []);
const exportFiles = jsonIn(root, /^idlehacking-affixes.*\.json(\.gz)?$/).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
const files = [...jsonIn(dataDir, /\.json$/), ...exportFiles]; // oldest first: a newer copy of an item replaces it

// One entry per item state: an item seen again after an upgrade or reroll is a new sighting.
const items = new Map();
for (const file of files) {
  for (const item of readExport(file)) {
    items.set(JSON.stringify([item.id, item.item_level, item.prefixes, item.suffixes]), item);
  }
}

if (process.argv.includes('--merge') && exportFiles.length) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(merged, `[\n${[...items.values()].map((item) => JSON.stringify(item)).join(',\n')}\n]\n`);
  exportFiles.forEach((file) => unlinkSync(file));
  console.log(`merged ${exportFiles.length} export file(s) into ${path.relative(root, merged)} and deleted them`);
}

const SOFT_CAPPED = new Set(['credits', 'xp_gathering', 'xp_hack', 'xp_global']);
const SOFT_CAP_X = 550; // iLvl 550,000
const SOFT_CAP_C = 2.1;

const isPct = (effect) => effect.type === 'mult_add';

function scaling(item, affix, effect) {
  const x = Number(item.item_level ?? affix.item_level) / 1000;
  if (!(x > 0)) return null;
  if (!isPct(effect)) return 0.2 + 0.8 * x;
  if (UTILITY_PREFIXES.has(affix.affix_id)) return 0.3 + 0.7 * x ** 0.25;
  const factor = 0.3 + 0.7 * Math.sqrt(x);
  if (!SOFT_CAPPED.has(effect.resource) || x <= SOFT_CAP_X) return factor;
  const start = 0.3 + 0.7 * Math.sqrt(SOFT_CAP_X);
  return start + SOFT_CAP_C * Math.log(1 + (factor - start) / SOFT_CAP_C);
}

// Tier value grid: 4 decimals for percentages, whole numbers for single-stat flat suffixes,
// 0.05 for the flat half of two-stat suffixes (0.6, 0.65 or 0.7 x a single-stat table).
const gridStep = (affix, effect) => (isPct(effect) ? 1e-4 : (affix.effects || []).length === 1 ? 1 : 0.05);

function tierValueInterval(affix, effect, shown, factor) {
  const perUnit = Math.round(1 / gridStep(affix, effect)); // divide, don't multiply: 450 / 1e4 is exactly 0.045
  const [lo, hi] = isPct(effect) ? [(shown - 5e-5) / factor, (shown + 5e-5) / factor] : [(shown - 1) / factor, shown / factor];
  return [Math.ceil(lo * perUnit - 1e-6) / perUnit, Math.floor(hi * perUnit + 1e-6) / perUnit];
}

const table = {}; // 'affix|resource' -> { index: [lo, hi] }
let contradictions = 0;
for (const item of items.values()) {
  for (const affix of [...(item.prefixes || []), ...(item.suffixes || [])]) {
    if (typeof affix.affix_id !== 'string' || !(affix.tier >= 1 && affix.tier <= 9)) continue;
    for (const effect of affix.effects || []) {
      const factor = scaling(item, affix, effect);
      if (!factor) continue;
      const slots = (table[`${affix.affix_id}|${effect.resource}`] ||= {});
      for (const [index, shown] of [[affix.tier, effect.value_min], [affix.tier - 1, effect.value_max]]) {
        if (!(shown > 0)) continue;
        const seen = tierValueInterval(affix, effect, shown, factor);
        const known = slots[index];
        if (!known) {
          slots[index] = seen;
          continue;
        }
        const next = [Math.max(known[0], seen[0]), Math.min(known[1], seen[1])];
        if (next[0] > next[1] + 1e-9) contradictions++;
        else slots[index] = next;
      }
    }
  }
}

// Compact output: an exact boundary is a number, an uncertain one [lo, hi]; one stat per line.
const clean = (v) => Number(v.toFixed(4));
const lines = Object.keys(table).sort().map((key) => {
  const bounds = Object.fromEntries(Object.entries(table[key]).map(([i, [lo, hi]]) => [i, Math.abs(hi - lo) < 1e-9 ? clean(lo) : [clean(lo), clean(hi)]]));
  return `${JSON.stringify(key)}:${JSON.stringify(bounds)}`;
});
writeFileSync(out, `{\n${lines.join(',\n')}\n}\n`);

const all = Object.values(table).flatMap((slots) => Object.values(slots));
const exact = all.filter(([lo, hi]) => Math.abs(hi - lo) < 1e-9).length;
console.log(`${files.length} export file(s), ${items.size} distinct items -> ${Object.keys(table).length} affix stats, ${all.length} boundaries (${exact} exact)`);
if (contradictions) console.log(`  ! ${contradictions} sightings contradicted earlier ones and were skipped`);
console.log(`wrote ${path.relative(root, out)}; run "npm run build" to include it`);
