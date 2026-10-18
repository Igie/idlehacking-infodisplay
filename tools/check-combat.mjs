// Checks the streak simulator's rules against recorded fights (data/combat.json.gz plus any
// idlehacking-combat*.json exports in the project root), using the simulator code from
// the dev build (dev/infodisplay.user.js, npm run build). The game state (gear, zones, ...) is the newest export's.
//
//   node tools/check-combat.mjs [runs]     runs = simulated streaks per real streak (default 300)
//
// Exact rules are replayed on every logged event and must match all of them; random ones
// (hit chance, attacks per round) are compared as rates; the built-in enemy model is compared
// with the recorded enemies; whole streaks are compared with the real streak ends. Run it after
// new exports, especially from other zones or after a game update.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { paths } from './build.mjs';
import { loadCombatData } from './combat-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { data, snapshots, sources } = loadCombatData(root);
const runs = Number(process.argv[2]) || 300;

// The built script, in a page-like sandbox with nothing loaded.
const sandbox = {
  console: { ...console, warn() {}, info() {} }, // the script's "panel not found" notices
  setTimeout, clearTimeout, setInterval: () => 0,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  MutationObserver: class { observe() {} },
  document: { getElementById: () => null, querySelector: () => null, createElement: () => ({}), head: { append() {} }, addEventListener() {} },
  addEventListener() {}, // window's, e.g. popstate for the Info Display page
  fetch: () => Promise.reject(new Error('offline')),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
if (!existsSync(paths.dev)) throw new Error('no dev/infodisplay.user.js yet: npm run build');
vm.runInContext(readFileSync(paths.dev, 'utf8'), sandbox);
const sim = sandbox.ihInfoDisplay.sim;

function inflate(c) {
  return Array.from({ length: c.n }, (_, s) => {
    const round = { r: s + 1 };
    for (const [k, v] of Object.entries(c)) if (Array.isArray(v) && k !== 'events' && k !== 'event_ends') round[k] = v[s];
    round.events = (c.events || []).slice(s ? c.event_ends[s - 1] : 0, c.event_ends[s]);
    return round;
  });
}
const logs = new Map(data.recorded.logs.map((l) => [l.n, l.compact ? inflate(l.compact) : l.rounds]));
const fights = data.recorded.fights.map((f) => ({ ...f, log: logs.get(f.n) || null }));
const logged = fights.filter((f) => f.log && f.player && f.enemy_stats);
const zones = new Map((data.zones || []).map((z) => [z.id, z]));
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const report = (name, ok, total, extra = '') => console.log(`${ok === total ? 'ok  ' : 'FAIL'} ${name}: ${ok} / ${total}${extra ? `  ${extra}` : ''}`);

console.log(`${sources.join(' + ')}: ${fights.length} fights, ${logged.length} with round logs and player stats\n`);

// Enemy level: hack level + zone offset + streak bonus. A result's hack_level is after the fight,
// so on a level-up the enemy was made one level lower.
{
  const withZone = fights.filter((f) => zones.has(f.zone) && f.enemy_level > 0);
  const off = withZone.filter((f) => f.hack_level - (f.leveled_up ? 1 : 0) + zones.get(f.zone).level_offset +
    sim.streakLevelBonus(f.victory ? f.current_win_streak : f.streak_ended + 1) !== f.enemy_level);
  report('enemy level', withZone.length - off.length, withZone.length, off.length ? `(misses: ${off.slice(0, 5).map((f) => `#${f.n} Lv${f.enemy_level}`).join(', ')})` : '');
}

// Post-combat heal.
{
  const wins = fights.filter((f) => f.victory && f.post_combat_heal_base > 0);
  report('post-combat heal', wins.filter((f) => sim.postCombatHeal(f.post_combat_heal_base, f.current_win_streak) === f.post_combat_heal_total).length, wins.length);
}

// Per round: attack schedule, hit damage range, thorns, corruption pulses, regeneration.
const fighter = (s, level) => ({ level, def: s.defense, pen: s.armor_penetration, atk: s.attack_damage, cd: s.crit_damage });
const tally = { sched: [0, 0], dmg: [0, 0], thorns: [0, 0], corr: [0, 0], regen: [0, 0] };
const hits = { p: [0, 0, 0], e: [0, 0, 0] }; // attacks, landed, predicted landed
const speed = { p: [0, 0], e: [0, 0] }; // attacks made, attack speed summed (full rounds only)
for (const f of logged) {
  const P = fighter(f.player, f.hack_level), E = fighter(f.enemy_stats, f.enemy_level);
  const thorns = { 1: f.player.thorns, 2: f.enemy_stats.thorns }; // 1 = you
  const stacks = { 1: [], 2: [] }; // corruption ticking on each side
  f.log.forEach((round, ri) => {
    const full = ri < f.log.length - 1; // the last round can stop early
    const phaseIds = [...new Set(round.events.filter((e) => e.k === 1).map((e) => e.p))].sort((a, b) => a - b);
    const count = { p: 0, e: 0 };
    for (const e of round.events) if (e.k === 1) { count.p += e.f & 1 ? 1 : 0; count.e += e.f & 2 ? 1 : 0; }
    if (full) {
      const want = sim.attackPhases(count.p, count.e).map(([a, b]) => `${+a}${+b}`).join();
      const got = phaseIds.map((p) => { const ev = round.events.find((e) => e.k === 1 && e.p === p); return `${ev.f & 1 ? 1 : 0}${ev.f & 2 ? 1 : 0}`; }).join();
      tally.sched[want === got ? 0 : 1]++;
      speed.p[0] += count.p; speed.p[1] += f.player.attack_speed; speed.e[0] += count.e; speed.e[1] += f.enemy_stats.attack_speed;
    }
    const share = 1 / Math.max(1, phaseIds.length);
    const landed = { p: 0, e: 0 };
    // per thorns owner (1 = you, 2 = enemy): index of the latest hit that set them off, and the round's sum of 0.9^index
    const trigger = { 1: 0, 2: 0 }, thornsSum = { 1: 0, 2: 0 };
    for (const p of phaseIds) {
      const evs = round.events.filter((e) => e.p === p);
      for (const e of evs) {
        if (e.k === 1) {
          for (const [side, attFlag, hitFlag, dmg, crits, att, def, acc, eva] of [
            ['p', 1, 4, e.a, e.c, P, E, f.player.accuracy, f.enemy_stats.evasion],
            ['e', 2, 8, e.o, e.ec, E, P, f.enemy_stats.accuracy, f.player.evasion],
          ]) {
            if (!(e.f & attFlag)) continue;
            hits[side][0]++; hits[side][2] += acc / (acc + eva);
            if (!(e.f & hitFlag)) continue;
            hits[side][1]++;
            const n = landed[side]++; // index among this attacker's landed hits this round
            trigger[side === 'p' ? 2 : 1] = n;
            let crit = 1;
            for (let j = 0; j < (crits || 0); j++) crit += (att.cd - 1) * 0.9 ** j;
            const base = att.atk * (1 - sim.damageReduction(att, def)) * 0.9 ** n * crit;
            tally.dmg[dmg >= Math.floor(0.8 * base) - 1 && dmg <= Math.ceil(1.2 * base) + 1 ? 0 : 1]++;
          }
        }
        if (e.k === 9) { // e.s = whose thorns; set off by the other side's latest landed hit
          const before = Math.round(thorns[e.s] * thornsSum[e.s]);
          thornsSum[e.s] += 0.9 ** trigger[e.s];
          if (full) tally.thorns[Math.round(thorns[e.s] * thornsSum[e.s]) - before === (e.a || 0) ? 0 : 1]++; // a 0 reflect is logged without an amount
        }
        if (e.k === 13) stacks[e.s].push({ tick: e.a, used: 0, total: e.o });
      }
      for (const on of [2, 1]) {
        let dmg = 0;
        for (const st of stacks[on]) {
          const used = Math.min(st.total, st.used + share);
          dmg += Math.floor(st.tick * used + 1e-9) - Math.floor(st.tick * st.used + 1e-9);
          st.used = used;
        }
        stacks[on] = stacks[on].filter((st) => st.used < st.total - 1e-9);
        const ev = evs.find((e) => e.k === 16 && e.s === (on === 2 ? 1 : 2));
        if (full) tally.corr[(ev ? ev.a : 0) === dmg ? 0 : 1]++;
      }
    }
    for (const e of round.events) {
      if (e.k !== 15) continue;
      const [stat, max, hp] = e.s === 1 ? [f.player.regeneration, f.max_hp, e.ph] : [f.enemy_stats.regeneration, f.enemy_stats.max_hp, e.eh];
      if (hp >= max) continue; // capped by max HP
      const pending = stacks[e.s].reduce((s, st) => s + st.tick, 0);
      tally.regen[Math.max(0, Math.floor(stat - 1.5 * pending + 1e-9)) === e.a ? 0 : 1]++;
    }
  });
}
const exact = (name, [ok, bad]) => report(name, ok, ok + bad);
exact('attack schedule', tally.sched);
exact('hit damage inside 0.8 - 1.2 x', tally.dmg);
exact('thorns', tally.thorns);
exact('corruption pulses', tally.corr);
exact('regeneration', tally.regen);
for (const side of ['p', 'e']) {
  const [n, landed, predicted] = hits[side];
  console.log(`rate ${side === 'p' ? 'your' : 'enemy'} hit chance: real ${pct(landed, n)}, model ${pct(predicted, n)} (${n} attacks)`);
  console.log(`rate ${side === 'p' ? 'your' : 'enemy'} attacks per round: real ${(speed[side][0] / Math.max(1, tally.sched[0] + tally.sched[1])).toFixed(3)}, model ${(speed[side][1] / Math.max(1, tally.sched[0] + tally.sched[1])).toFixed(3)}`);
}

// Single fights: every recorded fight again with its own enemy and starting HP, so the fight
// engine is checked apart from how enemies are drawn.
const playerFighter = (f) => {
  const stat = (k) => f.player[k] || 0;
  return {
    level: f.hack_level - (f.leveled_up ? 1 : 0), maxHp: f.max_hp, atk: stat('attack_damage'), def: stat('defense'), acc: stat('accuracy'),
    eva: stat('evasion'), cc: stat('crit_chance'), cd: stat('crit_damage'), as: stat('attack_speed'), regen: stat('regeneration'),
    barrier: Math.floor(stat('damage_barrier')), pen: stat('armor_penetration'), thorns: stat('thorns'), corr: stat('corruption'),
    healBase: Math.round(stat('post_combat_heal')),
  };
};
const enemyFighter = (f) => {
  const s = sim.poolEntry(f).stats;
  return {
    level: f.enemy_level, maxHp: Math.round(s.max_hp), atk: s.attack_damage, def: s.defense, acc: s.accuracy, eva: s.evasion, cc: s.crit_chance,
    cd: s.crit_damage, as: s.attack_speed, regen: s.regeneration, barrier: Math.floor(s.damage_barrier), pen: s.armor_penetration, thorns: s.thorns, corr: s.corruption,
  };
};
// HP loss is skewed (rare disaster fights), so the average alone can mislead; the percentile of
// each real loss among its simulated ones should average 0.5, and its z-score 0.
{
  const N = 200;
  let n = 0, lossesReal = 0, lossesSim = 0, roundsReal = 0, roundsSim = 0, lostReal = 0, lostSim = 0, wins = 0, pctSum = 0, zSum = 0;
  for (const f of fights.filter((x) => x.player && x.enemy_stats && x.starting_hp > 0)) {
    const P = playerFighter(f), E = enemyFighter(f);
    const lost = [];
    let simRounds = 0;
    for (let i = 0; i < N; i++) {
      const r = sim.simulateFight(P, E, f.starting_hp);
      simRounds += r.rounds;
      if (r.victory) lost.push(f.starting_hp - r.hp);
    }
    n++; roundsReal += f.rounds; roundsSim += simRounds / N; lossesReal += f.victory ? 0 : 1; lossesSim += 1 - lost.length / N;
    if (!f.victory || !lost.length) continue;
    const real = f.starting_hp - (f.current_hp - (f.post_combat_heal || 0));
    const mean = lost.reduce((s, x) => s + x, 0) / lost.length;
    const sd = Math.sqrt(lost.reduce((s, x) => s + (x - mean) ** 2, 0) / lost.length) || 1;
    wins++; lostReal += real; lostSim += mean; zSum += (real - mean) / sd;
    pctSum += (lost.filter((x) => x < real).length + 0.5 * lost.filter((x) => x === real).length) / lost.length;
  }
  console.log(`\nsingle fights (${n}, each simulated ${N}x):`);
  console.log(`  rounds per fight: real ${(roundsReal / n).toFixed(2)}, simulated ${(roundsSim / n).toFixed(2)}`);
  console.log(`  losses: real ${lossesReal}, simulated ${lossesSim.toFixed(1)} expected`);
  console.log(`  HP lost per won fight: real ${(lostReal / wins).toFixed(1)}, simulated ${(lostSim / wins).toFixed(1)}`);
  const z = zSum / wins, se = 1 / Math.sqrt(wins);
  console.log(`  ${Math.abs(z) <= 2 * se ? 'ok  ' : 'FAIL'} calibration: real loss at simulated percentile ${(pctSum / wins).toFixed(3)} on average (0.5 = unbiased), mean z ${z.toFixed(3)} (±${(2 * se).toFixed(3)})`);
}

// Gear swaps (test items): the breakdown rebuilt from its parts, every equipped item swapped for
// itself, and, when an older snapshot had other items in some slots, the newer items put into the
// older breakdown, which must give the newer breakdown's equipment parts.
{
  console.log('\ngear swaps:');
  const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
  const statsOf = (bd) => Object.keys(bd).filter((k) => bd[k] && 'equipment_pct' in bd[k] && k !== 'post_combat_heal');
  Object.assign(sandbox, { statsBreakdown: data.stats_breakdown, equipmentData: data.equipment, currentPlayer: data.player || {} });
  const stats = statsOf(data.stats_breakdown);
  const now = sim.gearTotals([]);
  report('totals rebuilt from the breakdown', stats.filter((k) => close(now.totals[k], data.stats_breakdown[k].total, 1e-9)).length, stats.length);
  const self = sim.gearTotals(Object.values(data.equipment).filter(Boolean));
  const off = stats.filter((k) => !close(self.totals[k], data.stats_breakdown[k].total, 2e-4));
  report('every equipped item swapped for itself', stats.length - off.length, stats.length, off.length ? `(off: ${off.join(', ')})` : '');
  // The server's Max HP is the total ± 1; no rounding rule found fits every fight (double floor about half).
  // A result's max_hp is from before the fight, so after a level-up the breakdown is a level (10 HP base) ahead.
  const sameMaxHp = fights.filter((f) => f.max_hp).at(-1);
  if (sameMaxHp) {
    const hackNow = Number((data.player || {}).hack_level) || 0;
    const behind = hackNow ? hackNow - (sameMaxHp.hack_level - (sameMaxHp.leveled_up ? 1 : 0)) : 0;
    const perLevel = hackNow ? (Number(data.stats_breakdown.max_hp.level) || 0) / hackNow : 0;
    const then = behind > 0 ? sim.gearTotals([], { max_hp: { flat: -behind * perLevel } }).maxHp : now.maxHp;
    const off = then - sameMaxHp.max_hp;
    const at = behind > 0 ? ` at Lv ${hackNow - behind}` : '';
    console.log(`${Math.abs(off) <= 1 ? 'ok  ' : 'FAIL'} Max HP from the breakdown${at}: ${then}, last fight ${sameMaxHp.max_hp}${off ? ` (${off > 0 ? '+' : ''}${off}; within 1 is the known rounding gap)` : ''}`);
  }
  for (const old of snapshots.slice(0, -1)) {
    if (!old.stats_breakdown || !old.equipment || !data.equipment) continue;
    const swaps = Object.entries(data.equipment).filter(([slot, item]) => item && (old.equipment[slot] || {}).id !== item.id).map(([, item]) => item);
    // Nothing in common is another player's export (from a GitHub issue), not a gear swap.
    if (!swaps.length || swaps.length === Object.values(data.equipment).filter(Boolean).length) continue;
    Object.assign(sandbox, { statsBreakdown: old.stats_breakdown, equipmentData: old.equipment });
    const { equipment } = sim.gearTotals(swaps);
    const bad = statsOf(old.stats_breakdown).filter((k) => {
      const want = data.stats_breakdown[k];
      return want && !(Math.abs(equipment[k].pct - (want.equipment_pct || 0)) <= 2e-4 && Math.abs(equipment[k].flat - (want.equipment_flat || 0)) < 1e-9);
    });
    report(`gear of ${String(old.exported_at).slice(0, 16)} + ${swaps.map((i) => i.name).join(', ')} = the newest gear`, statsOf(old.stats_breakdown).length - bad.length, statsOf(old.stats_breakdown).length, bad.length ? `(off: ${bad.join(', ')})` : '');
  }
  Object.assign(sandbox, { statsBreakdown: undefined, equipmentData: undefined });
}

// The enemy model (src/enemy-model.json, built into the script) against the recorded enemies: each
// enemy's roll t is estimated from all its stats, then every stat should land on the model's
// curve with about the model's noise. A game update that changes enemies shows up here first, and
// enemies recorded past a zone's fitted levels test the extrapolation.
const model = sim.enemyModel;
if (!model.zones) console.log('\nenemy model: none built in (npm run fit-enemies, then npm run build)');
else {
  console.log(`\nenemy model (${model.from}):`);
  const L0 = Math.log(800);
  for (const zone of [...new Set(fights.map((f) => f.zone).filter(Boolean))].sort()) {
    const list = fights.filter((f) => f.zone === zone && f.enemy_stats && f.enemy_level > 0 && model.classes.includes(f.enemy_class));
    const z = model.zones[zone];
    if (!z) {
      console.log(`     ${zone}: ${list.length} recorded enemies, not in the model yet (npm run fit-enemies once a whole streak is recorded)`);
      continue;
    }
    const curve = (k, level) => {
      const { b, q } = z.stats[k];
      const x = Math.log(level) - L0, e = Math.min(Math.log(z.hi) - L0, Math.max(Math.log(z.lo) - L0, x));
      return b * e + q * e * e + (b + 2 * q * e) * (x - e);
    };
    const res = Object.fromEntries(model.stats.map((k) => [k, []]));
    for (const f of list) {
      const c = model.classes.indexOf(f.enemy_class);
      const r = model.stats.map((k) => Math.log(f.enemy_stats[k]) - z.stats[k].a[c] - curve(k, f.enemy_level));
      // the roll that fits this enemy best, weighted by each stat's noise (Regeneration has none by definition)
      let num = 0, den = 0;
      model.stats.forEach((k, j) => {
        const { g, sd } = z.stats[k], w = 1 / Math.max(0.01, sd) ** 2;
        [num, den] = [num + w * g * r[j], den + w * g * g];
      });
      model.stats.forEach((k, j) => res[k].push(r[j] - z.stats[k].g * (num / den)));
    }
    const off = model.stats.map((k) => {
      const v = res[k], mean = v.reduce((a, x) => a + x, 0) / v.length, rms = Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
      return { k, mean, rms, bad: Math.abs(mean) > 0.02 || rms > 1.5 * z.stats[k].sd + 0.02 };
    });
    const bad = off.filter((o) => o.bad), worst = off.reduce((a, o) => (Math.abs(o.mean) > Math.abs(a.mean) ? o : a));
    const lv = list.map((f) => f.enemy_level), outside = list.filter((f) => f.enemy_level < z.lo || f.enemy_level > z.hi).length;
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${zone}: ${list.length} enemies (Lv ${Math.min(...lv)} – ${Math.max(...lv)}, ${outside} outside the fitted Lv ${z.lo} – ${z.hi}), ` +
      `largest average gap ${(worst.mean * 100).toFixed(1)}% (${worst.k})${bad.length ? `; off: ${bad.map((o) => `${o.k} ${(o.mean * 100).toFixed(1)}% avg, ${(o.rms * 100).toFixed(1)}% rms`).join(', ')}` : ''}`);
  }
}

// Whole streaks: one per recorded loss, with the stats in effect at that loss, against enemies
// from the model (the simulator's own).
console.log(`\nstreaks (${runs} simulated per real one, with the stats at the loss):`);
const pcts = [];
for (const f of fights.filter((x) => !x.victory && x.player && zones.has(x.zone))) {
  const P = playerFighter(f);
  const makeEnemy = sim.enemyMaker(f.zone);
  if (!makeEnemy) {
    console.log(`  real ${f.streak_ended} in ${f.zone}: skipped, zone not in the enemy model`);
    continue;
  }
  const ends = Array.from({ length: runs }, () => sim.simulateStreak(P, makeEnemy, zones.get(f.zone).level_offset, { streak: 0, hp: P.maxHp }).streak).sort((a, b) => a - b);
  const q = (p) => ends[Math.min(runs - 1, Math.floor(p * runs))];
  const pct = (ends.filter((x) => x < f.streak_ended).length + 0.5 * ends.filter((x) => x === f.streak_ended).length) / runs;
  pcts.push(pct);
  console.log(`  real ${f.streak_ended} in ${f.zone}: simulated median ${q(0.5)}, 80% within ${q(0.1)} - ${q(0.9)}; real = percentile ${(pct * 100).toFixed(0)}`);
}
// Real streak ends should look like random draws from the simulated ones: percentiles averaging 50.
if (pcts.length) console.log(`  average percentile ${((pcts.reduce((s, x) => s + x, 0) / pcts.length) * 100).toFixed(0)} over ${pcts.length} streaks (50 = unbiased, ±${(100 * 2 * Math.sqrt(1 / 12 / pcts.length)).toFixed(0)} is normal)`);
