// Fits the enemy model the streak simulator draws its enemies from, on data/combat.json.gz plus any
// idlehacking-combat*.json exports, and writes src/enemy-model.json (the build inlines it).
//
//   node tools/fit-enemies.mjs
//
// Per zone and stat:  ln stat = class constant + b·x + q·x² + g·t + noise,  x = ln(level / 800)
// t is the enemy's one random roll, which trades defense for offense. It is measured as the
// enemy's Regeneration residual (so g = 1 there), and its spread is pooled over all zones. A zone
// is fitted once it has MIN_FIGHTS recorded enemies of every class over a wide enough level range.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCombatData } from './combat-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'enemy-model.json');
const STATS = ['max_hp', 'attack_damage', 'defense', 'accuracy', 'evasion', 'crit_chance', 'crit_damage', 'attack_speed',
  'regeneration', 'damage_barrier', 'armor_penetration', 'thorns', 'corruption'];
const MIN_FIGHTS = 100, MIN_PER_CLASS = 5, MIN_SPAN = 1.5; // hi / lo level
const L0 = Math.log(800);

const { data, sources } = loadCombatData(root);
const enemies = data.recorded.fights
  .filter((f) => f.zone && f.enemy_class && f.enemy_level > 0 && f.enemy_stats && STATS.every((k) => Number(f.enemy_stats[k]) > 0))
  .map((f) => ({ zone: f.zone, cls: f.enemy_class, level: f.enemy_level, x: Math.log(f.enemy_level) - L0, s: STATS.map((k) => Number(f.enemy_stats[k])) }));
const classes = [...new Set(enemies.map((e) => e.cls))].sort();

// Least squares by the normal equations (a handful of columns).
function lsq(X, y) {
  const p = X[0].length, A = Array.from({ length: p }, () => Array(p + 1).fill(0));
  X.forEach((r, i) => {
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) A[a][b] += r[a] * r[b];
      A[a][p] += r[a] * y[i];
    }
  });
  for (let c = 0; c < p; c++) {
    let m = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[p] / r[i]);
}

const round = (v) => Number(v.toPrecision(6));
const REGEN = STATS.indexOf('regeneration');
const zones = {}, rolls = [];
for (const zone of [...new Set(enemies.map((e) => e.zone))].sort()) {
  const list = enemies.filter((e) => e.zone === zone);
  const lo = Math.min(...list.map((e) => e.level)), hi = Math.max(...list.map((e) => e.level));
  const perClass = classes.map((c) => list.filter((e) => e.cls === c).length);
  const why = list.length < MIN_FIGHTS ? `${list.length} fights (needs ${MIN_FIGHTS})`
    : Math.min(...perClass) < MIN_PER_CLASS ? `too few of some enemy types (${Math.min(...perClass)})`
      : hi < MIN_SPAN * lo ? `levels only ${lo}–${hi} (needs a ${MIN_SPAN}× span; play a longer streak)` : null;
  if (why) {
    console.log(`skip ${zone}: ${why}`);
    continue;
  }
  const base = (e) => [...classes.map((c) => (e.cls === c ? 1 : 0)), e.x, e.x * e.x];
  // The roll: each enemy's Regeneration residual from the zone's curve (class constants, shared b and q).
  const regen = lsq(list.map(base), list.map((e) => Math.log(e.s[REGEN])));
  const t = new Map(list.map((e) => [e, Math.log(e.s[REGEN]) - base(e).reduce((v, x, m) => v + x * regen[m], 0)]));
  rolls.push(...t.values());
  const stats = {};
  STATS.forEach((k, j) => {
    const X = list.map((e) => [...base(e), t.get(e)]);
    const y = list.map((e) => Math.log(e.s[j]));
    const co = lsq(X, y);
    const sd = Math.sqrt(X.reduce((s, r, i) => s + (y[i] - r.reduce((v, x, m) => v + x * co[m], 0)) ** 2, 0) / X.length);
    const n = classes.length;
    stats[k] = { a: co.slice(0, n).map(round), b: round(co[n]), q: round(co[n + 1]), g: round(co[n + 2]), sd: round(sd) };
  });
  zones[zone] = { n: list.length, lo, hi, stats };
  console.log(`${zone}: ${list.length} enemies, Lv ${lo}–${hi}; leftover noise ${STATS.map((k) => `${k} ${(stats[k].sd * 100).toFixed(1)}%`).join(', ')}`);
}

rolls.sort((a, b) => a - b);
const model = {
  fitted: new Date().toISOString().slice(0, 10),
  from: `${enemies.length} recorded enemies (${sources.join(' + ')})`,
  stats: STATS,
  classes,
  roll: Array.from({ length: 21 }, (_, i) => round(rolls[Math.round((i / 20) * (rolls.length - 1))])), // quantiles 0%, 5%, ... 100%
  zones,
};
writeFileSync(out, `${JSON.stringify(model, null, 1)}\n`);
console.log(`\nwrote src/enemy-model.json: ${Object.keys(zones).join(', ')} (rebuild to put it in the script)`);
