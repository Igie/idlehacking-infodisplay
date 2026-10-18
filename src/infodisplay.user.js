// ==UserScript==
// @name         Idle Hacking InfoDisplay
// @namespace    idlehacking-infodisplay
// @version      0.3.0
// @description  Extra info in Idle Hacking's own panels: affix bias tags and bias outcomes, Version Upgrade and Refactor previews when enhancing, and a streak simulator that tests items before you equip them. Nothing leaves your browser unless you export it.
// @author       Igie
// @license      MIT
// @homepageURL  https://github.com/Igie/idlehacking-infodisplay
// @supportURL   https://github.com/Igie/idlehacking-infodisplay/issues
// @updateURL    https://raw.githubusercontent.com/Igie/idlehacking-infodisplay/main/dist/infodisplay.meta.js
// @downloadURL  https://raw.githubusercontent.com/Igie/idlehacking-infodisplay/main/dist/infodisplay.user.js
// @match        https://www.idlehacking.com/play*
// @match        https://idlehacking.com/play*
// @icon         https://www.idlehacking.com/favicon.ico
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* global craftingModeItemId, findCraftingItemById, SLOT_NAMES, ESSENCE_TYPES, formatEssenceTypeLabel,
   formatTooltipStatLabel, equipmentData, inventoryData, getEffectiveCompiledBonusPct, showCraftCostTooltip, ws,
   currentPlayer, hackingState, hackingZones, statsBreakdown, extendedStats, homelabInfo, recentLossStreaks, combatLog,
   lastCombatStatusPayload, activeItemTooltipState, getEquippedPluginTotals, equipmentExtensionsEnabled, showContentView,
   Router, Modal */

(() => {
  'use strict';

  const BUILD = '__BUILD__'; // replaced by tools/build.mjs: the @version, or "dev <time>" for a dev build

  // Another copy (e.g. dev loader + release install) is already running.
  if (window.ihInfoDisplay) {
    console.info(`[InfoDisplay] ${BUILD} not started: ${window.ihInfoDisplay.build} is already running (disable one of them in Tampermonkey)`);
    return;
  }

  const STORE_PREFIX = 'ihInfoDisplay.';
  const REPO = 'https://github.com/Igie/idlehacking-infodisplay';

  // ------------------------------------------------------------------ shared helpers
  // The game keeps its state in top-level `let`/`const`/function bindings of its
  // classic scripts (inventory.js, state.js, ...). Code in the page realm, which is
  // where `@grant none` puts us, can read them by bare name. Every read is guarded
  // so a renamed binding degrades to the fallback instead of throwing.
  const read = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
      } catch {
        // storage unavailable; the preference just won't persist
      }
    },
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Exports are meant to be attached to a GitHub issue, so they leave out other players' names (who
  // found or enhanced an item) and are gzipped where the browser can, to stay well under GitHub's 25 MB
  // attachment limit. The file name carries the time so several exports don't overwrite each other.
  const PRIVATE_KEYS = new Set(['found_by', 'enhanced_by']);
  async function downloadJson(prefix, data, space) {
    const json = JSON.stringify(data, (key, value) => (PRIVATE_KEYS.has(key) ? undefined : value), space);
    let blob = new Blob([json], { type: 'application/json' });
    let name = `${prefix}-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}.json`;
    if (typeof CompressionStream === 'function') {
      blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      name += '.gz';
    }
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  function addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }

  let lastError = '';
  function guard(fn) {
    try {
      fn();
    } catch (err) {
      const msg = String((err && err.stack) || err);
      if (msg !== lastError) {
        lastError = msg;
        console.error('[InfoDisplay]', err);
      }
    }
  }

  // ------------------------------------------------------------------ affix reference
  // The same public list the game's Help > Affixes page loads:
  // { id, group, type: 'prefix'|'suffix', bonus_label, bias_essences: [...], slots: [...] }
  // An empty `slots` list means the affix can roll on every slot.
  const affixes = { list: null, loading: false, failedAt: 0, onLoad: [] };

  function loadAffixes(onLoad) {
    if (affixes.list) return;
    affixes.onLoad.push(onLoad);
    if (affixes.loading || Date.now() - affixes.failedAt < 30_000) return;
    affixes.loading = true;
    fetch('/api/help/affixes', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        affixes.list = Array.isArray(data && data.affixes) ? data.affixes : [];
      })
      .catch((err) => {
        affixes.failedAt = Date.now();
        console.warn('[InfoDisplay] affix reference unavailable:', err);
      })
      .finally(() => {
        affixes.loading = false;
        affixes.onLoad.splice(0).forEach((fn) => guard(fn));
      });
  }

  // ------------------------------------------------------------------ affix tier ranges
  // How the game builds the numbers it shows (verified on every affix of 800 exported items, iLvl 1 - 1.19M):
  //   shown = tier value x item-level factor
  //   percentage stats:         factor 0.3 + 0.7 * (iLvl / 1000)^(1/2), rounded to 4 decimals
  //     XP and Credits past iLvl 550k: f0 + 2.1 * ln(1 + (factor - f0) / 2.1), f0 = factor at 550k
  //   Item Rarity / Drop Boost: factor 0.3 + 0.7 * (iLvl / 1000)^(1/4), rounded to 4 decimals
  //   flat stats:               factor 0.2 + 0.8 * iLvl / 1000,         rounded up
  // The roll itself (base_value) also carries Compile: raw roll x (1 + compiled bonus);
  // the shown ranges don't. Tier values are the affix's range at iLvl 1000: 4-decimal numbers for percentages, a
  // 0.05 grid for flat stats. Tiers are contiguous (a tier's minimum is the next-worse
  // tier's maximum), so each affix stat has one list of boundaries B[0..9] where tier T
  // spans B[T]..B[T-1]. The game only sends an affix's current tier, so boundaries are
  // learned from every item the client sees: each shown number pins a boundary to a small
  // interval of possible tier values, and every further sighting narrows it.
  const TIERS_KEY = 'tiers.v3';
  const tierData = store.get(TIERS_KEY, {}); // 'affix|resource' -> { boundary index: [lo, hi] }
  try {
    localStorage.removeItem(`${STORE_PREFIX}tiers.v1`); // superseded estimate-based table
    localStorage.removeItem(`${STORE_PREFIX}tiers.v2`); // learned on a 0.1 flat grid, without the XP/Credits soft cap
  } catch {
    // storage unavailable
  }

  // Boundaries already pinned down by item exports (tools/make-seed.mjs); the build inlines
  // src/tier-seed.json here. A number is exact, [lo, hi] still uncertain. What this browser
  // learns can narrow a seed boundary but never overrule it (see tierBoundary).
  const TIER_SEED = /*TIER_SEED*/ {};

  const UTILITY_PREFIXES = new Set(['prefix_item_rarity', 'prefix_drop_boost']); // fourth-root curve
  const SOFT_CAPPED = new Set(['credits', 'xp_gathering', 'xp_hack', 'xp_global']); // log growth past SOFT_CAP_X
  const SOFT_CAP_X = 550; // iLvl 550,000
  const SOFT_CAP_C = 2.1;

  // Every "<economy> & <combat>" prefix uses one ladder of multiples (T1 high .. T9 low) of a
  // per-stat unit, rounded to 4 decimals. Global XP is Hack XP x 0.75, computed in this
  // order; that reproduces the game's rounding of its table exactly.
  const PREFIX_LADDER = [12, 10, 8, 6.5, 5, 4, 3, 2, 1.5, 1];
  const PREFIX_UNITS = {
    credits: 0.02, xp_gathering: 0.028, xp_hack: 0.019, gathering_resources_multi: 0.033,
    accuracy: 0.005, attack_damage: 0.005, defense: 0.005, evasion: 0.005, max_hp: 0.005,
  };
  const COMBAT_PREFIX = /^prefix_(credits|gatherxp|globalxp|hackxp|resources)_(accuracy|attack|defense|evasion|maxhp)$/;

  const round4 = (x) => Math.round(x * 1e4) / 1e4;
  const isPct = (effect) => effect.type === 'mult_add';
  const itemAffixes = (item) => [...(item.prefixes || []), ...(item.suffixes || [])];

  // The item-level factor that turns this effect's tier values into shown numbers.
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

  // Flat values round up float noise and all, like the game (210 x 835.6 shows 175477).
  const shownFor = (effect, value, factor) => (isPct(effect) ? round4(value * factor) : Math.ceil(value * factor));

  // Tier value grid: 4 decimals for percentages, whole numbers for single-stat flat suffixes,
  // 0.05 for the flat half of two-stat suffixes (0.6, 0.65 or 0.7 x a single-stat table).
  const gridStep = (affix, effect) => (isPct(effect) ? 1e-4 : (affix.effects || []).length === 1 ? 1 : 0.05);

  // Every tier value (on its grid) the game could have turned into `shown`. Grid points are
  // made by dividing (450 / 1e4 = 0.045) because multiplying (450 * 1e-4) leaves float noise
  // that flips half-way roundings the game gets right.
  function tierValueInterval(affix, effect, shown, factor) {
    const perUnit = Math.round(1 / gridStep(affix, effect));
    const [lo, hi] = isPct(effect) ? [(shown - 5e-5) / factor, (shown + 5e-5) / factor] : [(shown - 1) / factor, shown / factor];
    return [Math.ceil(lo * perUnit - 1e-6) / perUnit, Math.floor(hi * perUnit + 1e-6) / perUnit];
  }

  // Compile multiplies the stored roll; the shown ranges leave it out.
  const compileBonus = (item) =>
    Number(read(() => getEffectiveCompiledBonusPct(item), null) ?? item.effective_compiled_bonus_pct ?? item.compiled_bonus_pct) || 0;

  let tiersDirty = false;
  let tiersSaveTimer = 0;

  // Every item seen this session (marketplace pages, drops, ...), for exportAffixes().
  const seenItems = new Map();
  const SEEN_ITEMS_MAX = 20000;

  function learnItem(item) {
    const key = item.id ?? `${item.name}|${item.item_level}|${itemAffixes(item).map((a) => a.base_value ?? JSON.stringify(a.effects)).join()}`;
    if (seenItems.size < SEEN_ITEMS_MAX || seenItems.has(key)) seenItems.set(key, item);
    for (const affix of itemAffixes(item)) {
      if (typeof affix.affix_id !== 'string' || !(affix.tier >= 1 && affix.tier <= 9)) continue;
      for (const effect of affix.effects || []) {
        const factor = scaling(item, affix, effect);
        if (!factor) continue;
        const slots = (tierData[`${affix.affix_id}|${effect.resource}`] ||= {});
        for (const [index, shown] of [[affix.tier, effect.value_min], [affix.tier - 1, effect.value_max]]) {
          if (!(shown > 0)) continue;
          const seen = tierValueInterval(affix, effect, shown, factor);
          const known = slots[index];
          let next = known ? [Math.max(known[0], seen[0]), Math.min(known[1], seen[1])] : seen;
          if (next[0] > next[1] + 1e-9) next = seen; // contradiction: trust the newest sighting
          if (!known || next[0] !== known[0] || next[1] !== known[1]) {
            slots[index] = next;
            tiersDirty = true;
          }
        }
      }
    }
  }

  // Finds items anywhere in a game payload (inventory, equipment, market listings, ...).
  function learnFrom(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((v) => learnFrom(v, depth + 1));
    } else if (Number.isFinite(value.item_level) && (Array.isArray(value.prefixes) || Array.isArray(value.suffixes))) {
      learnItem(value);
    } else {
      Object.values(value).forEach((v) => learnFrom(v, depth + 1));
    }
    if (depth === 0 && tiersDirty && !tiersSaveTimer) {
      tiersSaveTimer = setTimeout(() => {
        tiersSaveTimer = 0;
        tiersDirty = false;
        store.set(TIERS_KEY, tierData);
      }, 2000);
    }
  }

  function learnLoadedItems() {
    learnFrom([read(() => equipmentData, null), read(() => inventoryData, null)]);
  }

  // Passive: our own listener next to the game's. Only messages carrying affixes or combat
  // results are worth a second JSON.parse. The game opens a new socket on reconnect, so re-check.
  let watchedSocket = null;
  function watchSocket() {
    const socket = read(() => ws, null);
    if (!socket || socket === watchedSocket || typeof socket.addEventListener !== 'function') return;
    watchedSocket = socket;
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const hasItems = event.data.includes('"tier_promotion_chance"');
      const isCombat = COMBAT_MESSAGE.test(event.data);
      if (!hasItems && !isCombat) return;
      guard(() => {
        const message = JSON.parse(event.data);
        if (hasItems) learnFrom(message);
        if (isCombat) recordCombatMessage(message);
      });
    });
  }

  // Possible tier values [lo, hi] for boundary `index` of an affix stat, or null if unseen.
  function tierBoundary(affixId, resource, index) {
    if (index < 0 || index > 9) return null;
    const multiple = COMBAT_PREFIX.test(affixId) && PREFIX_LADDER[index];
    if (multiple && resource === 'xp_global') return Array(2).fill(round4(0.019 * multiple * 0.75));
    if (multiple && PREFIX_UNITS[resource]) return Array(2).fill(round4(PREFIX_UNITS[resource] * multiple));
    const key = `${affixId}|${resource}`;
    const seedValue = (TIER_SEED[key] || {})[index];
    const seed = seedValue === undefined ? null : Array.isArray(seedValue) ? seedValue : [seedValue, seedValue];
    const learned = (tierData[key] || {})[index] || null;
    if (!seed || !learned) return seed || learned;
    const both = [Math.max(seed[0], learned[0]), Math.min(seed[1], learned[1])];
    return both[0] <= both[1] + 1e-9 ? both : seed; // one odd item can't overrule the seed
  }

  // How much better tier k is than tier k + 1 for this stat: the ratio of the two ranges'
  // midpoints in tier values (the item-level factor cancels out), or null if a boundary is unseen.
  function tierGain(affix, effect, k) {
    const mid = (tier) => {
      const lo = tierBoundary(affix.affix_id, effect.resource, tier);
      const hi = tierBoundary(affix.affix_id, effect.resource, tier - 1);
      return lo && hi ? (lo[0] + lo[1] + hi[0] + hi[1]) / 4 : null;
    };
    const [now, below] = [mid(k), mid(k + 1)];
    return now && below ? now / below - 1 : null;
  }

  // What `effect` of `affix` would show at tier k: lo/hi are [a, b] (a === b when exact),
  // or null when that boundary hasn't been seen on any item yet; gain is tierGain().
  function predictEffect(item, affix, effect, k) {
    const factor = scaling(item, affix, effect);
    const shownAt = (index) => {
      const b = factor && tierBoundary(affix.affix_id, effect.resource, index);
      return b ? [shownFor(effect, b[0], factor), shownFor(effect, b[1], factor)] : null;
    };
    // The next tier always starts exactly where the current one ends.
    const lo = k === affix.tier - 1 ? [effect.value_max, effect.value_max] : shownAt(k);
    return { effect, lo, hi: shownAt(k - 1), gain: tierGain(affix, effect, k) };
  }

  // Every tier Version Upgrade can still reach, one step at a time up to T1 (T0 isn't reachable:
  // T1's tier_promotion_chance is 0).
  function upgradeTiers(item, affix) {
    const tiers = [];
    for (let k = affix.tier - 1; k >= 1; k--) {
      tiers.push({ tier: k, effects: (affix.effects || []).map((e) => predictEffect(item, affix, e, k)) });
    }
    return tiers;
  }

  // Where the raw roll (Compile taken out) sits inside its tier, 0..1.
  function rollPosition(item, affix, effect) {
    const lo = tierBoundary(affix.affix_id, effect.resource, affix.tier);
    const hi = tierBoundary(affix.affix_id, effect.resource, affix.tier - 1);
    const roll = effect.base_value / (1 + compileBonus(item));
    if (lo && hi && roll > 0) {
      const [a, b] = [(lo[0] + lo[1]) / 2, (hi[0] + hi[1]) / 2];
      if (b > a) return (roll - a) / (b - a);
    }
    const factor = scaling(item, affix, effect); // fall back to the shown range
    const span = effect.value_max - effect.value_min;
    return factor && span > 0 && roll > 0 ? (roll * factor - effect.value_min) / span : null;
  }

  // ------------------------------------------------------------------ Enhancing panel
  // Bias Reroll rebuilds an item's unlocked affixes and guarantees one affix the
  // chosen essence can produce. In the game's Enhancing panel we add:
  //  - next to each affix, the essences whose Bias Reroll can guarantee it;
  //  - under the action buttons, the affixes a chosen essence can guarantee on
  //    this item's slot, split into prefixes and suffixes.
  // Everything we insert carries `data-ihid`, so it's easy to find and replace.
  const BIAS_ID = 'ihid-bias';

  const essenceLabel = (type) =>
    read(() => formatEssenceTypeLabel(type).replace(/\s+Essence$/i, ''), type.charAt(0).toUpperCase() + type.slice(1));

  const fitsSlot = (affix, slot) => !Array.isArray(affix.slots) || affix.slots.length === 0 || affix.slots.includes(slot);

  function biasCandidates(slot, essence) {
    return affixes.list
      .filter((a) => Array.isArray(a.bias_essences) && a.bias_essences.includes(essence) && fitsSlot(a, slot))
      .sort((a, b) => String(a.bonus_label).localeCompare(String(b.bonus_label)));
  }

  function lockedAffix(item) {
    const group = item.locked_affix_group;
    if (!group) return null;
    const list = item.locked_affix_type === 'suffix' ? item.suffixes : item.prefixes;
    return (list || []).find((a) => (a.group || a.affix_group) === group) || { name: group };
  }

  function candidateList(title, list, lockedGroup) {
    const rows = list.map((a) => {
      const blocked = lockedGroup && a.group === lockedGroup;
      const others = a.bias_essences.map(essenceLabel).join(', ');
      const tip = `${blocked ? 'Blocked: same group as your locked affix. ' : ''}Bias: ${others}`;
      return `<li class="${blocked ? 'ihid-blocked' : ''}" title="${esc(tip)}">${esc(a.bonus_label || a.id)}</li>`;
    });
    return `<div>
      <div class="craft-affix-group-label dim">${esc(title)} (${list.length})</div>
      <ul>${rows.join('') || '<li class="dim">none for this slot</li>'}</ul>
    </div>`;
  }

  // `selectable`: the game's bias dropdown is enabled, so chips drive it. Otherwise
  // (sealed, no stability, Basic/Common, ...) chips only preview the outcomes.
  function biasHtml(item, essence, slotLabel, selectable) {
    const types = read(() => ESSENCE_TYPES, null) || [...new Set(affixes.list.flatMap((a) => a.bias_essences || []))];
    const chips = types.map((type) => {
      const list = biasCandidates(item.slot, type);
      const p = list.filter((a) => a.type === 'prefix').length;
      const active = type === essence;
      const tip = `${selectable ? 'Select' : 'Preview'} ${essenceLabel(type)} bias`;
      return `<button type="button" class="ihid-bias-chip${active ? ' ihid-active' : ''}" data-essence="${esc(type)}"
        aria-pressed="${active}" ${list.length ? '' : 'disabled'} title="${esc(tip)}">${esc(essenceLabel(type))} <span class="dim">${p}P · ${list.length - p}S</span></button>`;
    });

    let summary = `Bias outcomes on ${slotLabel}`;
    let body = '<div class="ihid-bias-note dim">Pick an essence to see the affixes a Bias Reroll can guarantee.</div>';
    if (essence) {
      const candidates = biasCandidates(item.slot, essence);
      const prefixes = candidates.filter((a) => a.type === 'prefix');
      const suffixes = candidates.filter((a) => a.type === 'suffix');
      const locked = lockedAffix(item);
      const notes = ['A Bias Reroll guarantees one of these; the other rerolled affixes are random.'];
      if (locked) notes.push(`Locked ${esc(locked.name)} is kept.`);
      if (!selectable) notes.push('Preview only: Bias Reroll is unavailable for this item right now.');
      summary += `: ${essenceLabel(essence)} → ${prefixes.length} prefixes · ${suffixes.length} suffixes`;
      body = `
        <div class="ihid-bias-cols">
          ${candidateList('Prefixes', prefixes, item.locked_affix_group)}
          ${candidateList('Suffixes', suffixes, item.locked_affix_group)}
        </div>
        <div class="ihid-bias-note dim">${notes.join(' ')}</div>`;
    }
    return `
      <summary class="craft-affix-group-label dim">${esc(summary)}</summary>
      <div class="ihid-bias-chips">${chips.join('')}</div>
      ${body}`;
  }

  const normLabel = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Finds the reference entry for an affix on an item. Suffix groups are unique, but
  // the combat prefixes share one group per combat stat ("<X> & Accuracy") and differ
  // by their other stat, so those are told apart by the affix's effect labels.
  function matchAffix(affix, type) {
    const pool = affixes.list.filter((a) => a.type === type);
    const ids = [affix.id, affix.affix_id].filter((x) => typeof x === 'string');
    const byId = pool.find((a) => ids.includes(a.id));
    if (byId) return byId;
    const group = affix.group || affix.affix_group;
    const sameGroup = pool.filter((a) => a.group === group);
    if (sameGroup.length <= 1) return sameGroup[0] || null;

    const labels = (affix.effects || [])
      .map((e) => normLabel(read(() => formatTooltipStatLabel(e.resource), e.resource)))
      .filter(Boolean);
    const score = (a) =>
      String(a.bonus_label).split('&').map(normLabel).filter(Boolean)
        .filter((part) => labels.some((l) => l.includes(part) || part.includes(l))).length;
    const best = Math.max(...sameGroup.map(score));
    const top = sameGroup.filter((a) => score(a) === best);
    if (top.length === 1) return top[0];
    // Still ambiguous: the essences every remaining candidate shares are right either way.
    const shared = top.reduce((acc, a) => acc.filter((e) => (a.bias_essences || []).includes(e)), top[0].bias_essences || []);
    return { bonus_label: `one of ${top.length} ${type}es`, bias_essences: shared };
  }

  // Tags go right after each affix's name and tier, then get pushed out to a shared
  // left edge just past the longest name so they line up as a column.
  const TAG_COLUMN_GAP = 6; // px of extra space after the longest name

  function annotateAffixes(container, item, essence) {
    for (const row of container.querySelectorAll('.craft-affix-row[data-craft-affix-type]')) {
      const type = row.dataset.craftAffixType;
      const list = type === 'prefix' ? item.prefixes : type === 'suffix' ? item.suffixes : null;
      const affix = list && list[Number(row.dataset.craftAffixIndex)];
      const ref = affix ? matchAffix(affix, type) : null;
      const anchor = row.querySelector('.craft-affix-tier') || row.querySelector('.craft-affix-name');
      if (!ref || !ref.bias_essences || !ref.bias_essences.length || !anchor) continue;

      const tag = document.createElement('span');
      tag.dataset.ihid = '';
      tag.className = 'ihid-affix-bias';
      tag.title = `${ref.bonus_label} · Bias: ${ref.bias_essences.map(essenceLabel).join(' or ')}`;
      tag.innerHTML = ref.bias_essences
        .map((e) => `<span${e === essence ? ' class="ihid-active"' : ''}>${esc(essenceLabel(e))}</span>`)
        .join('');
      anchor.after(tag);
    }
    alignTagColumn(container);
  }

  // The game scales its UI with CSS `zoom` on <body>: measured rects are zoomed,
  // but the margins we set are not (the game's getUnzoomedClientRect does the same).
  function bodyZoom() {
    const zoom = Number.parseFloat(getComputedStyle(document.body).zoom);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  // Re-run whenever name widths can change (e.g. the game's web font finishing loading).
  function alignTagColumn(container) {
    const tags = [...container.querySelectorAll('.ihid-affix-bias')];
    if (!tags.length) return;
    tags.forEach((t) => (t.style.marginLeft = ''));
    const lefts = tags.map((t) => t.getBoundingClientRect().left); // all 0 while the panel is hidden
    const column = Math.max(...lefts);
    if (column <= 0) return;
    const zoom = bodyZoom();
    tags.forEach((t, i) => (t.style.marginLeft = `${(column - lefts[i]) / zoom + TAG_COLUMN_GAP}px`));
  }

  function renderBias(container, item, select, essence) {
    const actions = container.querySelector(':scope > .craft-bottom-actions');
    if (!actions || !select) return;

    const block = document.createElement('details');
    block.id = BIAS_ID;
    block.dataset.ihid = '';
    block.open = store.get('biasOpen', true);
    const slotLabel = read(() => SLOT_NAMES[item.slot], null) || item.slot || 'item';

    if (!affixes.list) {
      const failed = affixes.failedAt > 0 && !affixes.loading;
      block.innerHTML = `<summary class="craft-affix-group-label dim">Bias outcomes</summary>
        <div class="ihid-bias-note dim">${failed ? 'Affix data unavailable right now.' : 'Loading affix data…'}</div>`;
    } else {
      block.innerHTML = biasHtml(item, essence, slotLabel, !select.disabled);
    }

    block.addEventListener('toggle', () => store.set('biasOpen', block.open));
    block.addEventListener('click', (e) => {
      const chip = e.target.closest('.ihid-bias-chip');
      if (!chip || chip.disabled) return;
      const picked = chip.getAttribute('aria-pressed') === 'true' ? '' : chip.dataset.essence; // click again to clear
      if (select.disabled) {
        biasPreview.set(item.id, picked);
        renderEnhancing(container);
        return;
      }
      // Same path as picking it by hand: the game's onchange stores the choice and re-renders.
      select.value = picked;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    actions.after(block);
  }

  // Essences picked on our chips while the game's dropdown is disabled, by item id.
  const biasPreview = new Map();

  // ---- Hover previews on an affix's buttons. Rows go into the game's own cost tooltip;
  // when the game shows none (e.g. a disabled button) we show one in the same style.
  //  - VERSION UPGRADE: the affix's ranges at every better tier;
  //  - REFACTOR: where each stat's roll sits inside the current tier's range.
  let hovered = null; // { button, build }
  let ownTooltip = null;
  let pointer = null; // last pointer position in the page, null once it leaves the window

  const currentCraftItem = () => {
    const itemId = read(() => craftingModeItemId, null);
    return itemId ? read(() => findCraftingItemById(itemId), null) : null;
  };

  function affixForButton(button) {
    const row = button.closest('.craft-affix-row');
    const item = currentCraftItem();
    const type = row && row.dataset.craftAffixType;
    const list = item && (type === 'prefix' ? item.prefixes : type === 'suffix' ? item.suffixes : null);
    const affix = list && list[Number(row.dataset.craftAffixIndex)];
    return affix && affix.tier >= 1 ? { item, affix } : null;
  }

  const statLabel = (effect) => read(() => formatTooltipStatLabel(effect.resource), effect.resource);

  // A shown number, or "a~b" when the data so far allows two values.
  function numText(effect, range) {
    if (!range) return '?';
    const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
    if (!isPct(effect)) return a === b ? String(a) : `${a}~${b}`;
    const pct = (v) => (v * 100).toFixed(2);
    return a === b ? `${pct(a)}%` : `${pct(a)}~${pct(b)}%`;
  }

  const rangeText = (effect, lo, hi) =>
    lo ? `+${numText(effect, lo)} – ${numText(effect, hi)} ${statLabel(effect)}` : `? ${statLabel(effect)}`;

  const tooltipRow = (head, text, cls = '', tail = '') =>
    `<div class="ihid-upgrade-row ${cls}"><b>${esc(head)}</b><span>${esc(text)}</span>${tail ? `<i>${esc(tail)}</i>` : ''}</div>`;
  const tooltipNote = (text) => `<div class="ihid-upgrade-note">${esc(text)}</div>`;
  const percentText = (fraction) => `${(fraction * 100).toFixed(1).replace(/\.0$/, '')}%`;

  // "+25%" for a tier step. An affix's stats share one tier ladder, give or take the tables'
  // rounding (61.7% vs 62.5%), so one averaged number per row.
  function gainText(predicted) {
    const gains = predicted.map((p) => p.gain);
    if (!gains.length || gains.some((g) => g === null)) return '';
    return `+${Math.round((gains.reduce((a, b) => a + b, 0) / gains.length) * 100)}%`;
  }

  function upgradePreviewHtml(button) {
    const found = affixForButton(button);
    if (!found) return '';
    const { item, affix } = found;
    const effects = affix.effects || [];
    const now = effects.map((e) => rangeText(e, [e.value_min, e.value_min], [e.value_max, e.value_max])).join(', ');
    const rows = [tooltipRow(`T${affix.tier}`, now, 'ihid-upgrade-now')];
    const flags = new Set();
    for (const { tier, effects: predicted } of upgradeTiers(item, affix)) {
      for (const p of predicted) {
        if (!p.lo || !p.hi) flags.add('?');
        if ([p.lo, p.hi].some((r) => r && r[0] !== r[1])) flags.add('~');
      }
      rows.push(tooltipRow(`T${tier}`, predicted.map((p) => rangeText(p.effect, p.lo, p.hi)).join(', '), '', gainText(predicted)));
    }
    if (affix.tier === 1) rows.push(tooltipNote('Already the best tier.'));
    const compiled = compileBonus(item);
    const notes = [
      affix.tier > 1 && '+%: middle of the range vs the tier below',
      flags.has('~') && 'a~b: one of these, not enough sightings yet',
      flags.has('?') && '?: not seen on any item yet (found one? share it: menu › INFO DISPLAY)',
      compiled > 0 && `Compile adds ${percentText(compiled)} on top of these ranges`,
    ].filter(Boolean);
    if (notes.length) rows.push(tooltipNote(notes.join(' · ')));
    return `<div class="ihid-upgrade"><div class="ihid-upgrade-title">If upgraded</div>${rows.join('')}</div>`;
  }

  function refactorPreviewHtml(button) {
    const found = affixForButton(button);
    if (!found) return '';
    const { item, affix } = found;
    const rows = (affix.effects || []).map((e) => {
      const pos = rollPosition(item, affix, e);
      const where = pos === null ? '' : ` · ${Math.round(Math.min(1, Math.max(0, pos)) * 100)}% into the range`;
      return tooltipRow(numText(e, [e.value, e.value]), `${statLabel(e)} (${numText(e, [e.value_min, e.value_min])} – ${numText(e, [e.value_max, e.value_max])})${where}`);
    });
    const compiled = compileBonus(item);
    if (compiled > 0) rows.push(tooltipNote(`Values include Compile +${percentText(compiled)}; the ranges don't`));
    return `<div class="ihid-upgrade"><div class="ihid-upgrade-title">Refactor rerolls within T${affix.tier}</div>${rows.join('')}</div>`;
  }

  const PREVIEWS = [
    ['[id^="craft-tier-promote-btn-"]', upgradePreviewHtml],
    ['[id^="craft-masterwork-btn-"]', refactorPreviewHtml],
  ];

  function removeOwnTooltip() {
    ownTooltip?.remove();
    ownTooltip = null;
  }

  function showOwnTooltip({ button, build }) {
    removeOwnTooltip();
    const html = build(button);
    if (!html) return;
    ownTooltip = document.createElement('div');
    ownTooltip.className = 'craft-cost-tooltip';
    ownTooltip.innerHTML = html;
    document.body.append(ownTooltip);
    // Positioned like the game's own (fixed, under the button, in unzoomed px).
    const zoom = bodyZoom();
    const r = button.getBoundingClientRect();
    const width = ownTooltip.getBoundingClientRect().width;
    ownTooltip.style.left = `${Math.max(4, Math.min(r.left, innerWidth - width - 8)) / zoom}px`;
    ownTooltip.style.top = `${r.bottom / zoom + 4}px`;
  }

  // The game drops its tooltip on every panel refresh, e.g. each time a hack completes
  // (refreshCraftingPanelsIfVisible) or an item drops (full rebuild), even with the pointer
  // still on the button. Put it back if the pointer is on one of our buttons: through the
  // game's own showCraftCostTooltip, so the costs are fresh and our rows follow as usual.
  function restoreTooltip() {
    if (!pointer || document.querySelector('body > .craft-cost-tooltip')) return;
    const under = document.elementFromPoint(pointer.x, pointer.y);
    for (const [selector, build] of PREVIEWS) {
      const button = under && under.closest(selector);
      if (!button) continue;
      hovered = { button, build };
      read(() => showCraftCostTooltip({ currentTarget: button }), null);
      if (!document.querySelector('body > .craft-cost-tooltip')) showOwnTooltip(hovered); // the game had nothing to show
      return;
    }
  }

  function initHoverPreviews(container) {
    const enter = (e) => {
      for (const [selector, build] of PREVIEWS) {
        const button = e.target.closest && e.target.closest(selector);
        if (!button || (hovered && hovered.button === button)) continue;
        const current = (hovered = { button, build });
        // The game builds its tooltip right after this (mouseenter/focus); if none shows up, use ours.
        setTimeout(() => guard(() => {
          if (hovered === current && !document.querySelector('body > .craft-cost-tooltip .ihid-upgrade')) showOwnTooltip(current);
        }), 0);
        return;
      }
    };
    const leave = (e) => {
      if (hovered && !hovered.button.contains(e.relatedTarget)) {
        hovered = null;
        removeOwnTooltip();
      }
    };
    container.addEventListener('mouseover', enter);
    container.addEventListener('focusin', enter);
    container.addEventListener('mouseout', leave);
    container.addEventListener('focusout', leave);
    document.addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });
    document.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) pointer = null; // left the window
    }, true);
    // Add our rows to the game's tooltip as soon as it's attached, before it positions itself.
    new MutationObserver((records) => {
      let dropped = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (hovered && node !== ownTooltip && node.classList && node.classList.contains('craft-cost-tooltip')) {
            removeOwnTooltip(); // the game's tooltip replaces ours
            const html = hovered.build(hovered.button);
            if (html) node.insertAdjacentHTML('beforeend', html);
          }
        }
        for (const node of record.removedNodes) {
          if (node.classList && node.classList.contains('craft-cost-tooltip') && node.querySelector('.ihid-upgrade')) dropped = true;
        }
      }
      // After the game's refresh and our renderEnhancing have both run.
      if (dropped) setTimeout(() => guard(restoreTooltip), 0);
    }).observe(document.body, { childList: true });
  }

  function renderEnhancing(container) {
    container.querySelectorAll('[data-ihid]').forEach((node) => node.remove());
    hovered = null;
    removeOwnTooltip();
    const item = currentCraftItem();
    if (!item) return;
    learnLoadedItems();
    if (!affixes.list) loadAffixes(() => renderEnhancing(container));

    const select = container.querySelector('#craft-bias-select');
    const essence = !select ? '' : select.disabled ? biasPreview.get(item.id) || '' : select.value;
    if (affixes.list) annotateAffixes(container, item, essence);
    renderBias(container, item, select, essence);
  }

  function initEnhancing() {
    const container = document.getElementById('craft-item-content');
    if (!container) {
      console.warn('[InfoDisplay] #craft-item-content not found; Enhancing additions disabled');
      return;
    }
    // The game rebuilds the whole panel with innerHTML on every change (including
    // picking a bias essence), which drops our additions; put them back each time.
    new MutationObserver(() => {
      if (!container.querySelector('[data-ihid]')) guard(() => renderEnhancing(container));
    }).observe(container, { childList: true });
    if (document.fonts) document.fonts.addEventListener('loadingdone', () => guard(() => alignTagColumn(container)));
    initHoverPreviews(container);
    loadAffixes(() => {}); // warm the cache before the panel is first opened
  }

  function initTierLearning() {
    learnLoadedItems();
    watchSocket();
    setInterval(() => guard(watchSocket), 2000);
  }

  // ------------------------------------------------------------------ combat recorder
  // The server resolves every fight and only sends the outcome, so what the simulator needs and
  // Help doesn't give (hit chance, damage rolls, enemy stats per zone and level) was worked out
  // from recorded fights. Recording is off unless turned on (record fights on the Info Display
  // page); it's only needed to measure a zone the enemy model doesn't cover yet, or to re-check
  // the rules after a game update. Each hacking result is then kept in IndexedDB with the
  // player's stats at the time; exportCombat() downloads it all along with zones, homelab and
  // simulator results.
  const recorder = { on: store.get('recordFights', false), count: null }; // count: fights stored, once looked up
  const COMBAT_DB = 'ihInfoDisplay.combat';
  const COMBAT_LIMITS = { fights: 30000, logs: 3000, events: 500 }; // ~1 KB per fight, a few KB per log
  const COMBAT_TYPES = ['HACKING_RESULT', 'HACKING_STARTED', 'HACKING_SOFTWARE_PROFILER_RESULT', 'HACKING_PIPELINE_SIMULATION_RESULT',
    'RECENT_LOSS_STREAKS', 'RECENT_LOSS_STREAK_REPLAY'];
  const COMBAT_MESSAGE = new RegExp(`"type"\\s*:\\s*"(?:${COMBAT_TYPES.join('|')})"`);
  // Parts of a hacking result that say nothing about the fight itself.
  const FIGHT_SKIP = ['contracts_update', 'holiday_event_update', 'achievement_unlocks', 'essences_gained', 'drop_summary', 'loot_filter_sound_alert'];

  let combatDb = null;
  function openCombatDb() {
    combatDb ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(COMBAT_DB, 1);
      req.onupgradeneeded = () => {
        for (const name of Object.keys(COMBAT_LIMITS)) req.result.createObjectStore(name, { keyPath: 'n', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      combatDb = null;
      throw err;
    });
    return combatDb;
  }

  // Drops the oldest records past the store's limit.
  function pruneStore(store, max) {
    const counted = store.count();
    counted.onsuccess = () => {
      const extra = counted.result - max;
      if (extra <= 0) return;
      const cursor = store.openKeyCursor();
      let skipped = extra === 1;
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (!skipped) {
          skipped = true;
          cursor.result.advance(extra - 1); // lands on the newest record to drop
          return;
        }
        store.delete(IDBKeyRange.upperBound(cursor.result.primaryKey));
      };
    };
  }

  let combatWrites = 0;
  let combatDbFailed = false;
  // `log`, when given, is stored under the fight's key in its own store (logs are kept for fewer fights).
  function storeCombat(storeName, record, log) {
    openCombatDb()
      .then((db) => {
        const names = log ? [storeName, 'logs'] : [storeName];
        const tx = db.transaction(names, 'readwrite');
        const added = tx.objectStore(storeName).add(record);
        if (log) added.onsuccess = () => tx.objectStore('logs').put({ ...log, n: added.result });
        if (++combatWrites % 100 === 1) names.forEach((name) => pruneStore(tx.objectStore(name), COMBAT_LIMITS[name]));
      })
      .catch((err) => {
        if (!combatDbFailed) console.warn('[InfoDisplay] combat recorder unavailable:', err);
        combatDbFailed = true;
      });
  }

  // The player's final stats as Profile > Combat shows them (stats_breakdown totals). The game
  // only has them once something sent a breakdown (opening your profile by clicking your name, changing gear, ...).
  let warnedNoStats = false;
  function playerStats() {
    const breakdown = read(() => statsBreakdown, null);
    if (!breakdown) {
      if (!warnedNoStats) console.info('[InfoDisplay] combat recorder: click your name (USER INFO panel) once so fights are saved with your stats');
      warnedNoStats = true;
      return null;
    }
    const totals = {};
    for (const [key, value] of Object.entries(breakdown)) {
      if (value && Number.isFinite(value.total)) totals[key] = value.total;
    }
    return totals;
  }

  function recordCombatMessage(message) {
    const { type, payload } = message || {};
    if (!COMBAT_TYPES.includes(type) || !payload || typeof payload !== 'object') return;
    if (!recorder.on) {
      if (type === 'HACKING_RESULT') refreshSimAfterFight();
      return;
    }
    const context = {
      at: Date.now(),
      zone: read(() => hackingState.zone_id, null),
      hack_level: read(() => currentPlayer.hack_level, null),
      player: playerStats(),
    };
    if (type !== 'HACKING_RESULT') {
      storeCombat('events', { type, ...context, payload });
      return;
    }
    const { combat_log: rounds, combat_log_compact: compact, recent_loss_streak_entry: lossEntry, drop, ...fight } = payload;
    ['stats_breakdown', ...FIGHT_SKIP].forEach((key) => delete fight[key]); // the breakdown's totals are in `player`
    if (drop) fight.drop = { item_level: drop.item_level, rarity: drop.rarity, slot: drop.slot };
    const log = compact && Number(compact.n) > 0 ? { compact } : Array.isArray(rounds) && rounds.length ? { rounds } : null;
    storeCombat('fights', { ...context, ...fight }, log);
    if (recorder.count != null) recorder.count++;
    if (lossEntry && typeof lossEntry === 'object') storeCombat('events', { type: 'RECENT_LOSS_STREAK_ENTRY', ...context, payload: lossEntry });
    refreshSimAfterFight();
  }

  // Fights stored in this browser, without creating the database just to count them.
  async function recordedFights() {
    if (!recorder.on) {
      if (typeof indexedDB.databases !== 'function') return null; // can't tell without opening (and so creating) it
      if (!(await indexedDB.databases()).some((d) => d.name === COMBAT_DB)) return 0;
    }
    return (await combatCounts()).fights || 0;
  }

  // Deletes everything recorded in this browser.
  async function clearCombat() {
    const db = combatDb && (await combatDb.catch(() => null));
    if (db) db.close();
    combatDb = null;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(COMBAT_DB);
      req.onsuccess = resolve;
      req.onblocked = resolve; // another tab still has it open; it goes once that tab closes or reloads
      req.onerror = () => reject(req.error);
    });
    recorder.count = 0;
    return 'recorded fights deleted';
  }

  function readAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Runs the game's own Homelab simulator saved locally (Simulator > History), if any.
  async function gameSimulatorHistory() {
    const name = 'idlehack.hacking-simulator-history';
    if (typeof indexedDB.databases === 'function' && !(await indexedDB.databases()).some((d) => d.name === name)) return [];
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return db.objectStoreNames.contains('runs') ? await readAll(db, 'runs') : [];
    } finally {
      db.close();
    }
  }

  async function combatCounts() {
    const db = await openCombatDb();
    const counts = {};
    for (const name of Object.keys(COMBAT_LIMITS)) {
      counts[name] = await new Promise((resolve) => {
        const req = db.transaction(name, 'readonly').objectStore(name).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
    }
    return counts;
  }

  // Downloads everything recorded so far plus the game state the simulator will build on.
  async function exportCombat() {
    const db = await openCombatDb();
    const [fights, logs, events] = await Promise.all(Object.keys(COMBAT_LIMITS).map((name) => readAll(db, name)));
    const player = read(() => currentPlayer, null) || {};
    const pick = (keys) => Object.fromEntries(keys.filter((k) => k in player).map((k) => [k, player[k]]));
    const data = {
      schema: 1,
      build: BUILD,
      exported_at: new Date().toISOString(),
      player: pick(['hack_level', 'code_level', 'compute_level', 'mine_level', 'sniff_level', 'current_zone', 'combat_active',
        'current_win_streak', 'highest_recent_loss_enemy_level', 'combat_stats', 'combat_damage_barrier_carryover', 'global_buffs',
        'multipliers', 'plugins', 'homelab', 'gear_sets', 'homelab_quarantine_rules_disabled', 'homelab_session_recorder_disabled']),
      player_keys: Object.keys(player), // which other fields exist, in case one turns out to matter
      hacking_state: read(() => hackingState, null),
      zones: read(() => hackingZones, null),
      stats_breakdown: read(() => statsBreakdown, null),
      extended_stats: read(() => extendedStats, null),
      equipment: read(() => equipmentData, null),
      homelab_info: read(() => homelabInfo, null),
      recent_loss_streaks: read(() => recentLossStreaks, null),
      recent_combat_log: read(() => combatLog, null),
      last_hacking_result: read(() => lastCombatStatusPayload, null),
      game_simulator_history: await gameSimulatorHistory().catch((err) => ({ error: String(err) })),
      recorded: { fights, logs, events },
    };
    const name = await downloadJson('idlehacking-combat', data);
    const missing = ['zones', 'stats_breakdown', 'homelab_info'].filter((k) => !data[k]);
    return `${fmt(fights.length)} fights (${fmt(logs.length)} with round logs), ${fmt(events.length)} other combat messages saved to ${name}` +
      (missing.length ? `; not loaded yet: ${missing.join(', ')} (open Hacking, your profile (click your name) and Homelab once, then export again)` : '');
  }

  // ------------------------------------------------------------------ streak simulator
  // Plays whole hacking streaks locally with the player's current stats and reports how far
  // they get. The rules are Help > Hacking plus what the recorded round logs pinned down; each
  // reproduces every logged event it covers:
  //  - attacks per round: the whole part of Attack Speed, plus one more with the fraction as the
  //    chance; attack i of n happens at time i/n and tied times resolve together (one phase)
  //  - hit chance: accuracy / (accuracy + evasion)
  //  - damage: attack x U(0.8, 1.2) x (1 - defense reduction) x 0.9^(hits landed before it this
  //    round) x crit; defense reduction as in Help (K from the attacker's level, the armor pen
  //    scale from the defender's)
  //  - thorns: flat per landed hit, 0.9^n for later hits, rounded on the round's running total
  //    (so a reflect can be 0 when Thorns is below about 2)
  //  - corruption: each landed hit adds a stack of floor(corruption x 0.9^n) per tick for 5 ticks;
  //    every phase ticks 1/phases, and a stack has dealt floor(value x ticks used) so far
  //  - regeneration after each round: floor(regen - 1.5 x the corruption per tick still on you)
  //  - after a win, HP carries over plus round(heal x 0.99^(streak - 10)), at least 30% of it
  //  - enemy level: hack level + zone offset + floor((k - 2) / 10) for every k = 12..streak
  // tools/check-combat.mjs re-checks all of this against an export.
  // Enemies come from the built-in enemy model (see enemyMaker), so nothing has to be recorded.
  const SIM_STATS = ['max_hp', 'attack_damage', 'defense', 'accuracy', 'evasion', 'crit_chance', 'crit_damage', 'attack_speed',
    'regeneration', 'damage_barrier', 'armor_penetration', 'thorns', 'corruption'];
  const SIM_MAX_ROUNDS = 500; // no fight in the logs came close; past this the fight counts as lost
  const SIM_MAX_STREAK = 2000;

  function damageReduction(att, def) {
    const ignored = att.pen > 0 ? Math.min(0.95, (0.95 * att.pen) / (att.pen + 400 + 0.1 * def.level)) : 0;
    const d = def.def * (1 - ignored);
    return d > 0 ? d / (d + 100 + 0.04 * att.level) : 0;
  }

  function critMultiplier(f, rnd) {
    const layers = Math.floor(f.cc) + (rnd() < f.cc - Math.floor(f.cc) ? 1 : 0);
    let m = 1;
    for (let j = 0; j < layers; j++) m += (f.cd - 1) * 0.9 ** j;
    return m;
  }

  // Attack phases of a round: [player attacks, enemy attacks] per distinct time, in order.
  function attackPhases(nP, nE) {
    const phases = [];
    let i = 1, j = 1;
    while (i <= nP || j <= nE) { // i/nP vs j/nE, compared without floats
      if (j > nE || (i <= nP && i * nE < j * nP)) { phases.push([true, false]); i++; }
      else if (i > nP || j * nP < i * nE) { phases.push([false, true]); j++; }
      else { phases.push([true, true]); i++; j++; }
    }
    return phases;
  }

  function hurt(side, amount) {
    const absorbed = Math.min(side.barrier, amount);
    side.barrier -= absorbed;
    side.hp -= amount - absorbed;
  }

  // One fight. A fighter: { level, maxHp, atk, def, acc, eva, cc, cd, as, regen, barrier, pen, thorns, corr }.
  // `rnd` rolls the dice: attacks per round, hits, damage, crits. A seeded `rnd` seeds a fresh
  // stream per side and round, so a variant with other stats (say one more attack) still rolls
  // the same dice as the others from the next round on, and the enemy's rolls never shift.
  function simulateFight(P, E, startHp, rnd = Math.random) {
    const sides = [{ f: P, hp: startHp, barrier: P.barrier, stacks: [] }, { f: E, hp: E.maxHp, barrier: E.barrier, stacks: [] }];
    const hitChance = [P.acc / (P.acc + E.eva), E.acc / (E.acc + P.eva)];
    const dr = [damageReduction(P, E), damageReduction(E, P)];
    const attacks = (f, roll) => Math.floor(f.as) + (roll() < f.as - Math.floor(f.as) ? 1 : 0);
    const lost = () => sides[0].hp <= 0; // mutual death counts as a loss
    for (let round = 1; round <= SIM_MAX_ROUNDS; round++) {
      const dice = rnd === Math.random ? [rnd, rnd] : [seededRandom((rnd() * 2 ** 32) >>> 0), seededRandom((rnd() * 2 ** 32) >>> 0)];
      const phases = attackPhases(attacks(P, dice[0]), attacks(E, dice[1]));
      const share = 1 / Math.max(1, phases.length);
      const landed = [0, 0];
      const thornsSum = [0, 0]; // sum of 0.9^n over the hits that set off each side's thorns this round
      for (const phase of phases) {
        for (let a = 0; a < 2; a++) {
          if (!phase[a] || dice[a]() >= hitChance[a]) continue;
          const att = sides[a], def = sides[1 - a];
          const factor = 0.9 ** landed[a]++;
          hurt(def, Math.max(1, Math.round(att.f.atk * (0.8 + 0.4 * dice[a]()) * (1 - dr[a]) * factor * critMultiplier(att.f, dice[a]))));
          if (def.f.thorns > 0) {
            const before = Math.round(def.f.thorns * thornsSum[1 - a]);
            thornsSum[1 - a] += factor;
            hurt(att, Math.round(def.f.thorns * thornsSum[1 - a]) - before);
          }
          const tick = Math.floor(att.f.corr * factor);
          if (tick >= 1) def.stacks.push({ tick, used: 0 });
        }
        if (lost() || sides[1].hp <= 0) return { victory: !lost(), hp: sides[0].hp, rounds: round };
        for (const s of [sides[1], sides[0]]) {
          let dmg = 0;
          for (const st of s.stacks) {
            const used = Math.min(5, st.used + share);
            dmg += Math.floor(st.tick * used + 1e-9) - Math.floor(st.tick * st.used + 1e-9);
            st.used = used;
          }
          s.stacks = s.stacks.filter((st) => st.used < 5 - 1e-9);
          if (dmg > 0) hurt(s, dmg);
        }
        if (lost() || sides[1].hp <= 0) return { victory: !lost(), hp: sides[0].hp, rounds: round };
      }
      for (const s of sides) {
        const pending = s.stacks.reduce((sum, st) => sum + st.tick, 0);
        s.hp = Math.min(s.f.maxHp, s.hp + Math.max(0, Math.floor(s.f.regen - 1.5 * pending + 1e-9)));
      }
    }
    return { victory: false, hp: 0, rounds: SIM_MAX_ROUNDS, timeout: true };
  }

  const postCombatHeal = (base, streak) => Math.round(base * (streak <= 10 ? 1 : Math.max(0.3, 0.99 ** (streak - 10))));

  // Level bonus of the fight that would bring the streak to `streak`.
  function streakLevelBonus(streak) {
    let bonus = 0;
    for (let k = 12; k <= streak; k++) bonus += Math.floor((k - 2) / 10);
    return bonus;
  }

  // A recorded fight's enemy as it fought: { zone, cls, level, stats }, effective_* being after the
  // recording player's homelab reductions (tools/check-combat.mjs replays fights with it).
  function poolEntry(fight) {
    const s = fight && fight.enemy_stats;
    if (!s || !fight.zone || !(fight.enemy_level > 0) || !fight.enemy_class) return null;
    const stat = (k) => Number(s[`effective_${k}`] ?? s[k]) || 0;
    return { zone: fight.zone, cls: fight.enemy_class, level: fight.enemy_level, stats: Object.fromEntries(SIM_STATS.map((k) => [k, stat(k)])) };
  }

  function groupBy(list, key) {
    const groups = new Map();
    for (const item of list) {
      const k = key(item);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
    return groups;
  }

  // Small seeded generator (mulberry32), so gear variants can face the same enemies.
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The enemy model, fitted by tools/fit-enemies.mjs on recorded fights (src/enemy-model.json,
  // inlined by the build). Per zone and stat:
  //   ln stat = class constant + b·x + q·x² + g·t + noise,  x = ln(level / 800)
  // with one of the 9 classes at random and ONE random roll t per enemy, which trades defense for
  // offense (Regeneration, Barrier, Thorns, HP, ... up; Attack, Accuracy, Crit, Pen, Corruption
  // down). Past the levels the zone was measured at, the curve goes on straight (in logs) from
  // its last slope. Zones the model doesn't have can't be simulated yet.
  const ENEMY_MODEL = /*ENEMY_MODEL*/ {};
  const modelZone = (zone) => (ENEMY_MODEL.zones || {})[zone] || null;

  // Draws enemies for `zone` at any level, or null when the model doesn't cover the zone.
  function enemyMaker(zone) {
    const z = modelZone(zone);
    if (!z) return null;
    const { roll, classes } = ENEMY_MODEL;
    const [x0, x1] = [Math.log(z.lo / 800), Math.log(z.hi / 800)];
    const rows = SIM_STATS.map((k) => {
      const { a, b, q, g, sd } = z.stats[k];
      return { k, a, g, sd, curve: (x) => { const e = Math.min(x1, Math.max(x0, x)); return b * e + q * e * e + (b + 2 * q * e) * (x - e); } };
    });
    return (level, rnd = Math.random) => {
      const cls = Math.min(classes.length - 1, Math.floor(rnd() * classes.length));
      const u = rnd() * (roll.length - 1), i = Math.floor(u);
      const t = roll[i] + (roll[Math.min(roll.length - 1, i + 1)] - roll[i]) * (u - i);
      const x = Math.log(level / 800);
      const s = {};
      for (const r of rows) {
        const noise = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
        s[r.k] = Math.exp(r.a[cls] + r.curve(x) + r.g * t + r.sd * noise);
      }
      return {
        level, maxHp: Math.round(s.max_hp), atk: s.attack_damage, def: s.defense, acc: s.accuracy, eva: s.evasion, cc: s.crit_chance,
        cd: s.crit_damage, as: s.attack_speed, regen: s.regeneration, barrier: Math.floor(s.damage_barrier), pen: s.armor_penetration,
        thorns: s.thorns, corr: s.corruption,
      };
    };
  }

  // ---- gear: the player's stats with other items in some slots
  // Profile > Combat's totals are (base + level + flat) x (1 + equipment % + hardware + homelab)
  // x (1 + syndicate) x (1 + plugins), except Crit Chance / Crit Damage, where the percentages add
  // to the base instead. Swapping an item replaces that slot's share of the breakdown (exact, from
  // equipment_slots) with the new item's implicits and affixes (shown values, 4 decimals). Checked
  // on a real Kernel swap: the next breakdown came out within that rounding.
  const GEAR_STATS = [...SIM_STATS, 'post_combat_heal'];
  const STAT_FORMS = [
    (c) => (c.base + c.flat) * (1 + c.pct) * c.mult,
    (c) => (c.base + c.flat + c.pct) * c.mult,
  ];

  // An item's equipment bonuses per stat: { pct, flat }.
  function itemBonuses(item) {
    const out = {};
    const add = (stat, type, value) => {
      if (!stat || !Number.isFinite(value)) return;
      const b = (out[stat] ||= { pct: 0, flat: 0 });
      if (type === 'flat_add') b.flat += value;
      else b.pct += value;
    };
    for (const imp of [item.implicit_info, item.extra_implicit_info]) if (imp) add(imp.stat_type, imp.effect_type, imp.value);
    for (const affix of itemAffixes(item)) for (const e of affix.effects || []) add(e.resource, e.type, e.value);
    return out;
  }

  // Plugin bonus per stat for a set of equipped items, by the game's own stacking rule.
  function pluginTotals(equipment) {
    if (read(() => equipmentExtensionsEnabled(), true) === false) return new Map();
    return read(() => getEquippedPluginTotals(equipment), null) || new Map();
  }

  // Stat totals with `swaps` (items, each going into its own slot) instead of what's equipped there,
  // plus `extra` equipment bonuses ({ stat: { pct, flat } }) as if one more item carried them.
  function gearTotals(swaps, extra = {}) {
    const b = read(() => statsBreakdown, null);
    if (!b || !b.max_hp) return null;
    const equipped = read(() => equipmentData, null) || {};
    const slots = new Set(swaps.map((item) => item.slot));
    const gear = { ...equipped };
    swaps.forEach((item) => (gear[item.slot] = item));
    const [pluginNow, pluginNew] = [pluginTotals(equipped), pluginTotals(gear)];
    const added = {};
    for (const bonuses of [...swaps.map(itemBonuses), extra]) {
      for (const [stat, v] of Object.entries(bonuses)) {
        const a = (added[stat] ||= { pct: 0, flat: 0 });
        [a.pct, a.flat] = [a.pct + (v.pct || 0), a.flat + (v.flat || 0)];
      }
    }
    const totals = {};
    const equipment = {}; // the equipment % and flat parts after the swap
    let maxHp = null;
    for (const k of GEAR_STATS) {
      const s = b[k];
      if (!s) continue;
      const n = (key) => Number(s[key]) || 0;
      const removed = { pct: 0, flat: 0 };
      for (const e of s.equipment_slots || []) {
        if (slots.has(e.slot)) [removed.pct, removed.flat] = [removed.pct + (Number(e.additive) || 0), removed.flat + (Number(e.flat) || 0)];
      }
      const parts = (dPct, dFlat, plugin) => ({
        base: n('base') + n('level'),
        flat: n('equipment_flat') + n('homelab_flat') + dFlat,
        pct: n('equipment_pct') + n('hardware') + n('homelab') + dPct,
        mult: (1 + n('syndicate')) * (1 + plugin),
      });
      const now = parts(0, 0, n('plugin'));
      const form = STAT_FORMS.find((f) => Math.abs(f(now) - s.total) <= 1e-6 * Math.max(1, Math.abs(s.total)));
      const a = added[k] || { pct: 0, flat: 0 };
      const next = parts(a.pct - removed.pct, a.flat - removed.flat, n('plugin') + (pluginNew.get(k) || 0) - (pluginNow.get(k) || 0));
      equipment[k] = { pct: n('equipment_pct') + a.pct - removed.pct, flat: n('equipment_flat') + a.flat - removed.flat };
      // A total no form reproduces is scaled by the multiplicative form's change instead.
      totals[k] = form ? form(next) : s.total * (STAT_FORMS[0](next) / STAT_FORMS[0](now) || 1);
      // The server rounds Max HP down twice: after the additive part and at the end.
      if (k === 'max_hp' && form === STAT_FORMS[0]) maxHp = Math.floor(Math.floor((next.base + next.flat) * (1 + next.pct)) * next.mult);
    }
    return { totals, equipment, maxHp: maxHp ?? Math.floor(totals.max_hp || 0) };
  }

  // The player as Profile > Combat shows them, with the equipped gear or with `swaps` put in
  // (and `extra` bonuses, see gearTotals).
  function simPlayer(swaps = [], extra = null) {
    const b = read(() => statsBreakdown, null);
    if (!b || !b.max_hp) return null;
    let t = (k) => Number(b[k] && b[k].total) || 0;
    // The last fight's Max HP is the server's own number, exact as long as the gear hasn't changed since.
    const lastMax = Number(read(() => hackingState.max_hp, 0)) || 0;
    let maxHp = lastMax > 0 && Math.abs(lastMax - t('max_hp')) <= 0.002 * t('max_hp') + 2 ? lastMax : Math.floor(t('max_hp'));
    if (swaps.length || extra) {
      const g = gearTotals(swaps, extra || {});
      t = (k) => Number(g.totals[k]) || 0;
      maxHp = g.maxHp;
    }
    return {
      level: Number(read(() => currentPlayer.hack_level, 1)) || 1, maxHp, atk: t('attack_damage'), def: t('defense'), acc: t('accuracy'),
      eva: t('evasion'), cc: t('crit_chance'), cd: t('crit_damage'), as: t('attack_speed'), regen: t('regeneration'),
      barrier: Math.floor(t('damage_barrier')), pen: t('armor_penetration'), thorns: t('thorns'), corr: t('corruption'),
      healBase: Math.round(t('post_combat_heal')),
    };
  }

  // Fights until the first loss. Returns the streak reached and the level of the enemy it lost to.
  // `rnd` picks the enemies and seeds each fight's dice, so variants given the same seed meet the
  // same enemies and roll the same dice until their stats make a fight go differently.
  function simulateStreak(P, makeEnemy, offset, start, rnd = Math.random) {
    let { streak, hp } = start;
    let firstWin = null;
    let timeout = false;
    while (streak < SIM_MAX_STREAK) {
      const level = P.level + offset + streakLevelBonus(streak + 1);
      const enemy = makeEnemy(level, rnd);
      const dice = rnd === Math.random ? rnd : seededRandom((rnd() * 2 ** 32) >>> 0);
      const result = simulateFight(P, enemy, hp, dice);
      firstWin ??= result.victory;
      if (!result.victory) {
        timeout = !!result.timeout;
        return { streak, level, firstWin, timeout };
      }
      streak++;
      hp = Math.min(P.maxHp, result.hp + postCombatHeal(P.healBase, streak));
    }
    return { streak, level: P.level + offset + streakLevelBonus(streak + 1), firstWin, capped: true };
  }

  // ---- the panel, under COMBAT STATUS on the Hacking page
  const SIM_ID = 'ihid-sim';
  const simUi = { zone: '', mode: 'new', runs: store.get('simRuns', 300), pairs: store.get('simPairs', false), job: null, last: null };
  const NOT_SIMULATED = 'signatures, lifesteal, Quarantine lockups, Snapshot Rollback, homelab enemy reductions, gear automation, level-ups during the streak';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const SLOT_ORDER = ['main_hand', 'off_hand', 'head', 'chest', 'gloves', 'boots', 'acc1', 'acc2'];
  const slotName = (slot) => read(() => SLOT_NAMES[slot], null) || slot;

  const zoneList = () => [...(read(() => hackingZones, null) || [])].sort((a, b) => a.min_level - b.min_level);

  function simZoneOptions() {
    const zones = zoneList();
    const current = read(() => hackingState.zone_id, null) || read(() => currentPlayer.current_zone, null);
    if (!zones.some((z) => z.id === simUi.zone && modelZone(z.id))) {
      simUi.zone = modelZone(current) ? current : (zones.filter((z) => modelZone(z.id)).at(-1) || {}).id || '';
    }
    return zones.map((z) => {
      const known = !!modelZone(z.id);
      const label = known ? z.name : `${z.name} (enemies not measured yet)`;
      return `<option value="${esc(z.id)}"${z.id === simUi.zone ? ' selected' : ''}${known ? '' : ' disabled'}>${esc(label)}</option>`;
    }).join('');
  }

  // "Continue" starts from the current streak and HP, which only makes sense in the zone being hacked.
  function currentStreakStart() {
    const s = read(() => hackingState, null);
    if (!s || !s.active || s.zone_id !== simUi.zone) return { why: 'not hacking in this zone' };
    if (!(s.winStreak > 0) || !(s.combat_hp > 0)) return { why: 'no wins yet' };
    return { streak: s.winStreak, hp: s.combat_hp };
  }

  // ---- test items: simulated as if equipped, each in its own slot. Kept across reloads as the
  // game sent them; an inventory item is refreshed from the inventory, so enhancing it counts.
  const SIM_TESTS_MAX = 8;
  const simTests = (store.get('simTests', []) || []).filter((item) => item && SLOT_ORDER.includes(item.slot));
  const itemKey = (item) => String(item.id ?? `${item.name}|${item.item_level}|${itemAffixes(item).map((a) => a.base_value ?? JSON.stringify(a.effects)).join()}`);
  const isTestItem = (item) => simTests.some((t) => itemKey(t) === itemKey(item));
  const equippedIds = () => new Set(Object.values(read(() => equipmentData, null) || {}).filter(Boolean).map((e) => e.id));
  const inventoryItems = () => (read(() => inventoryData.items, null) || []).filter((item) => item && SLOT_ORDER.includes(item.slot));

  function liveTests() {
    const inventory = new Map(inventoryItems().map((item) => [itemKey(item), item]));
    const worn = equippedIds();
    return simTests.map((item) => {
      const live = inventory.get(itemKey(item)) || item;
      return { item: live, key: itemKey(live), equipped: live.id != null && worn.has(live.id) };
    });
  }

  function toggleSimTest(item) {
    const i = simTests.findIndex((t) => itemKey(t) === itemKey(item));
    if (i >= 0) simTests.splice(i, 1);
    else {
      simTests.push(JSON.parse(JSON.stringify(item)));
      if (simTests.length > SIM_TESTS_MAX) simTests.shift();
    }
    store.set('simTests', simTests);
    const panel = document.getElementById(SIM_ID);
    if (panel && panel.open && !simUi.job) renderSim(panel);
  }

  const playerTopLevel = () => Math.max(...['hack_level', 'code_level', 'compute_level', 'mine_level', 'sniff_level'].map((k) => Number(read(() => currentPlayer[k], 0)) || 0), 1);
  const HARMLESS_SIGNATURES = /^(stable construction|optimization pass|market arbitrage)$/i; // no effect on fights

  // Why a variant may not match the real thing.
  function itemCaveats(item) {
    const notes = [];
    const need = Number(item.required_hack_level) || 0;
    if (need > playerTopLevel()) notes.push(`needs Lv ${fmt(need)} to equip`);
    if (item.signature_name && !HARMLESS_SIGNATURES.test(item.signature_name)) notes.push(`its ${item.signature_name} signature isn't simulated`);
    return notes;
  }

  const itemLabel = (item) => `${item.name || 'Item'} · iLvl ${fmt(item.item_level || 0)}`;

  function testItemsHtml(running) {
    const tests = liveTests();
    const chips = tests.map((t) => `
      <span class="ihid-sim-chip${t.equipped ? ' dim' : ''}" title="${esc([itemLabel(t.item), t.item.rarity, ...itemCaveats(t.item)].filter(Boolean).join(' · '))}">
        <span class="dim">${esc(slotName(t.item.slot))}</span> ${esc(itemLabel(t.item))}${t.equipped ? ' (equipped now)' : ''}
        <button type="button" data-sim-remove="${esc(t.key)}" aria-label="Remove ${esc(t.item.name || 'item')}"${running ? ' disabled' : ''}>×</button>
      </span>`);
    const worn = equippedIds();
    const candidates = inventoryItems().filter((item) => !worn.has(item.id) && !isTestItem(item));
    const groups = SLOT_ORDER.map((slot) => {
      const list = candidates.filter((item) => item.slot === slot).sort((a, b) => (b.item_level || 0) - (a.item_level || 0));
      return list.length ? `<optgroup label="${esc(slotName(slot))}">${list.map((item) => `<option value="${esc(itemKey(item))}">${esc(`${itemLabel(item)} · ${item.rarity || ''}`)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const empty = read(() => inventoryData.items, null) ? 'no other items in your inventory' : 'open your inventory once to list it here';
    return `
      <div class="ihid-sim-row ihid-sim-tests">
        <span class="dim">TEST ITEMS</span>
        ${chips.join('') || '<span class="dim">none: simulating your equipped gear</span>'}
      </div>
      <div class="ihid-sim-row">
        <select data-sim="add"${running || !groups ? ' disabled' : ''}><option value="">${groups ? 'Add from inventory…' : esc(empty)}</option>${groups}</select>
        <span class="ihid-sim-note">or "+ TEST IN STREAK SIMULATOR" in any item's tooltip (inventory, marketplace, chat)</span>
      </div>`;
  }

  function simControlsHtml() {
    const running = !!simUi.job;
    const current = currentStreakStart();
    const cont = current.why ? null : current;
    if (!cont) simUi.mode = 'new';
    const radio = (mode, label, disabled) =>
      `<label class="ihid-sim-radio${disabled ? ' dim' : ''}"><input type="radio" name="ihid-sim-mode" value="${mode}"${simUi.mode === mode ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${esc(label)}</label>`;
    return `
      <div class="ihid-sim-row">
        <label>ZONE <select data-sim="zone"${running ? ' disabled' : ''}>${simZoneOptions()}</select></label>
        <label>RUNS <select data-sim="runs"${running ? ' disabled' : ''}>${[100, 300, 1000].map((n) => `<option${n === simUi.runs ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <button type="button" class="btn" data-sim="run">${running ? 'STOP' : 'SIMULATE'}</button>
      </div>
      <div class="ihid-sim-row">
        ${radio('new', 'New streak (full HP)', running)}
        ${radio('continue', `Continue current streak (${cont ? `${fmt(cont.streak)} wins, ${fmt(cont.hp)} HP` : current.why})`, running || !cont)}
      </div>
      ${testItemsHtml(running)}
      <div class="ihid-sim-row">
        <button type="button" class="btn" data-sim="priority"${running ? ' disabled' : ''}>STAT PRIORITY</button>
        <label class="ihid-sim-radio${running ? ' dim' : ''}"><input type="checkbox" data-sim="pairs"${simUi.pairs ? ' checked' : ''}${running ? ' disabled' : ''}> two-stat suffixes too</label>
        <span class="ihid-sim-note">which suffix adds the most wins to your equipped gear</span>
      </div>`;
  }

  // Gear to compare: what's equipped, each test item in its slot, and all of them together when they
  // fit different slots.
  function simVariants() {
    const base = simPlayer();
    if (!base) return null;
    const variants = [{ label: 'Equipped', P: base, notes: [] }];
    const tests = liveTests().filter((t) => !t.equipped);
    for (const t of tests) {
      variants.push({ label: `${slotName(t.item.slot)}: ${itemLabel(t.item)}`, P: simPlayer([t.item]), notes: itemCaveats(t.item) });
    }
    if (tests.length >= 2 && new Set(tests.map((t) => t.item.slot)).size === tests.length) {
      variants.push({ label: 'All test items together', P: simPlayer(tests.map((t) => t.item)), notes: tests.flatMap((t) => itemCaveats(t.item)) });
    }
    return variants;
  }

  // ---- stat priority: the equipped gear plus one more suffix of each kind (the middle of tier
  // PRIORITY_TIER at the gear's average item level), to rank what to look for on the next item.
  const PRIORITY_TIER = 5;
  const FLAT_STATS = new Set(['regeneration', 'damage_barrier', 'armor_penetration', 'thorns', 'corruption']);
  const STAT_LABELS = {
    max_hp: 'Max HP', attack_damage: 'Attack', defense: 'Defense', accuracy: 'Accuracy', evasion: 'Evasion', crit_chance: 'Crit Chance',
    crit_damage: 'Crit Damage', attack_speed: 'Attack Speed', regeneration: 'Regeneration', damage_barrier: 'Barrier',
    armor_penetration: 'Armor Pen', thorns: 'Thorns', corruption: 'Corruption',
  };

  function gearItemLevel() {
    const levels = Object.values(read(() => equipmentData, null) || {}).map((item) => Number(item && item.item_level) || 0).filter((x) => x > 0);
    return levels.length ? Math.round(levels.reduce((s, x) => s + x, 0) / levels.length) : 1000;
  }

  // Combat suffixes with a known tier range: [{ id, effects: [{ resource, type, value }] }].
  function prioritySuffixes(withPairs, itemLevel) {
    const keys = [...new Set([...Object.keys(TIER_SEED), ...Object.keys(tierData)])].filter((k) => k.startsWith('suffix_'));
    const out = [];
    for (const [id, list] of groupBy(keys, (k) => k.split('|')[0])) {
      const stats = list.map((k) => k.split('|')[1]);
      if (!stats.every((s) => STAT_LABELS[s]) || (!withPairs && stats.length > 1)) continue;
      const effects = stats.sort().map((resource) => {
        const effect = { resource, type: FLAT_STATS.has(resource) ? 'flat_add' : 'mult_add' };
        const [lo, hi] = [tierBoundary(id, resource, PRIORITY_TIER), tierBoundary(id, resource, PRIORITY_TIER - 1)];
        const factor = scaling({ item_level: itemLevel }, { affix_id: id }, effect);
        return lo && hi && factor ? { ...effect, value: shownFor(effect, (lo[0] + lo[1] + hi[0] + hi[1]) / 4, factor) } : null;
      });
      if (effects.every(Boolean)) out.push({ id, effects });
    }
    return out;
  }

  const effectText = (e) => `+${FLAT_STATS.has(e.resource) ? fmt(e.value) : `${(e.value * 100).toFixed(2)}%`} ${STAT_LABELS[e.resource]}`;

  function priorityVariants() {
    const base = simPlayer();
    if (!base) return null;
    const itemLevel = gearItemLevel();
    const variants = [{ label: 'Equipped', P: base, notes: [] }];
    for (const s of prioritySuffixes(simUi.pairs, itemLevel)) {
      const extra = {};
      for (const e of s.effects) extra[e.resource] = e.type === 'flat_add' ? { flat: e.value } : { pct: e.value };
      variants.push({ label: s.effects.map((e) => STAT_LABELS[e.resource]).join(' & '), added: s.effects.map(effectText).join(' & '), P: simPlayer([], extra), notes: [] });
    }
    return variants.length > 1 ? Object.assign(variants, { itemLevel }) : null;
  }

  // What a variant changes compared to the equipped gear, e.g. "HP +114 · ATK −16 · crit +1.2%".
  function statChanges(P, base) {
    const parts = [];
    const add = (label, d, text) => { if (Math.abs(d) >= 1e-9) parts.push(`${label} ${d > 0 ? '+' : '−'}${text(Math.abs(d))}`); };
    const whole = (v) => (v >= 0.5 ? fmt(v) : v.toFixed(2));
    for (const [label, k] of [['HP', 'maxHp'], ['ATK', 'atk'], ['DEF', 'def'], ['ACC', 'acc'], ['EVA', 'eva'], ['regen', 'regen'], ['barrier', 'barrier'],
      ['pen', 'pen'], ['thorns', 'thorns'], ['corruption', 'corr'], ['heal', 'healBase']]) add(label, P[k] - base[k], whole);
    add('crit', P.cc - base.cc, (v) => `${(v * 100).toFixed(2)}%`);
    add('crit dmg', P.cd - base.cd, (v) => `${(v * 100).toFixed(1)}%`);
    add('SPD', P.as - base.as, (v) => `${(v * 100).toFixed(1)}%`);
    return parts.join(' · ') || 'no stat change';
  }

  const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

  function histogramHtml(values, lo = values[0], hi = values.at(-1), small = false) {
    const width = Math.max(1, Math.ceil((hi - lo + 1) / 24));
    const bins = [];
    for (const v of values) bins[Math.floor((v - lo) / width)] = (bins[Math.floor((v - lo) / width)] || 0) + 1;
    const top = Math.max(...bins.filter(Boolean));
    const bars = Array.from({ length: Math.floor((hi - lo) / width) + 1 }, (_, i) => {
      const n = bins[i] || 0;
      const from = lo + i * width, to = from + width - 1;
      const range = width === 1 ? fmt(from) : `${fmt(from)}–${fmt(to)}`;
      return `<i style="height:${Math.max(n ? 6 : 0, Math.round((n / top) * 100))}%" title="${range} wins: ${n} run${n === 1 ? '' : 's'}"></i>`;
    });
    if (small) return `<div class="ihid-sim-hist ihid-sim-hist-small" aria-hidden="true">${bars.join('')}</div>`;
    return `<div class="ihid-sim-hist" aria-hidden="true">${bars.join('')}</div>
      <div class="ihid-sim-hist-axis dim"><span>${fmt(lo)}</span><span>${fmt(hi)}</span></div>`;
  }

  function jobNotes(job, levels) {
    const all = job.variants.flatMap((v) => v.results);
    const capped = all.filter((r) => r.capped).length;
    const timeouts = all.filter((r) => r.timeout).length;
    const notes = [];
    if (job.done < job.runs) notes.push(`${fmt(job.done)} / ${fmt(job.runs)} runs…`);
    if (capped) notes.push(`${fmt(capped)} run${capped === 1 ? '' : 's'} stopped at ${fmt(SIM_MAX_STREAK)} wins`);
    if (timeouts) notes.push(`${fmt(timeouts)} run${timeouts === 1 ? '' : 's'} ended on a ${SIM_MAX_ROUNDS}-round stalemate, counted as a loss`);
    const { lo, hi } = job.model;
    if (levels.at(-1) > hi * 1.2 || job.firstLevel < lo / 1.2) notes.push(`this zone's enemies were measured at Lv ${fmt(lo)} – ${fmt(hi)}; outside that they're extrapolated`);
    return notes.length ? `<div class="ihid-sim-note">${notes.map(esc).join(' · ')}</div>` : '';
  }

  const plusCap = (v) => `${fmt(v)}${v >= SIM_MAX_STREAK ? '+' : ''}`;
  const winChance = (results) => `${((results.filter((r) => r.firstWin).length / results.length) * 100).toFixed(1)}%`;

  function singleResultHtml(job) {
    const { results } = job.variants[0];
    const streaks = results.map((r) => r.streak).sort((a, b) => a - b);
    const levels = results.map((r) => r.level).sort((a, b) => a - b);
    const rows = [
      ['FINAL STREAK', `<b>${plusCap(quantile(streaks, 0.5))}</b> median · 80% of runs end between ${plusCap(quantile(streaks, 0.1))} and ${plusCap(quantile(streaks, 0.9))} · best ${plusCap(streaks.at(-1))} · worst ${fmt(streaks[0])}`],
      ['LOSES TO', `enemy Lv ${fmt(quantile(levels, 0.5))} (median) · Lv ${fmt(levels[0])} – ${fmt(levels.at(-1))}`],
    ];
    if (job.start.streak > 0) rows.push(['NEXT FIGHT', `${winChance(results)} win chance`]);
    return `
      ${rows.map(([head, text]) => `<div class="ihid-sim-stat"><span class="dim">${head}</span><span>${text}</span></div>`).join('')}
      ${histogramHtml(streaks)}
      ${jobNotes(job, levels)}`;
  }

  // Average extra wins per streak over the first n runs, each against the same enemies and dice as
  // the baseline's run (paired), with a 95% margin.
  function pairedGain(results, baseline, n) {
    const d = results.slice(0, n).map((r, k) => r.streak - baseline[k].streak);
    const mean = d.reduce((s, x) => s + x, 0) / n;
    return { mean, margin: 2 * Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) / n) };
  }

  function gainHtml({ mean, margin }) {
    const cls = mean - margin > 0 ? 'ihid-sim-up' : mean + margin < 0 ? 'ihid-sim-down' : 'dim';
    return `<span class="${cls}">${mean >= 0 ? '+' : '−'}${Math.abs(mean).toFixed(1)}</span> <span class="dim">±${margin.toFixed(1)}</span>`;
  }

  // Several gear variants: one row each, "vs equipped" from pairedGain.
  function compareResultHtml(job) {
    const [eq] = job.variants;
    const n = Math.min(...job.variants.map((v) => v.results.length));
    const all = job.variants.flatMap((v) => v.results.slice(0, n).map((r) => r.streak));
    const lo = Math.min(...all), hi = Math.max(...all);
    const levels = job.variants.flatMap((v) => v.results.map((r) => r.level)).sort((a, b) => a - b);
    const rows = job.variants.map((v, i) => {
      const res = v.results.slice(0, n);
      const streaks = res.map((r) => r.streak).sort((a, b) => a - b);
      const lv = res.map((r) => r.level).sort((a, b) => a - b);
      const vs = i > 0 && n > 1 ? gainHtml(pairedGain(v.results, eq.results, n)) : '<span class="dim">—</span>';
      const sub = i === 0 ? '' : `<div class="ihid-sim-note">${esc([statChanges(v.P, eq.P), ...v.notes].join(' · '))}</div>`;
      return `<tr>
        <td>${esc(v.label)}${sub}</td>
        <td><b>${plusCap(quantile(streaks, 0.5))}</b></td>
        <td>${plusCap(quantile(streaks, 0.1))}–${plusCap(quantile(streaks, 0.9))}</td>
        <td>${vs}</td>
        <td>Lv ${fmt(quantile(lv, 0.5))}</td>
        ${job.start.streak > 0 ? `<td>${winChance(res)}</td>` : ''}
        <td class="ihid-sim-spread">${n ? histogramHtml(streaks, lo, hi, true) : ''}</td>
      </tr>`;
    });
    return `
      <table class="ihid-sim-table">
        <thead><tr><th>GEAR</th><th>MEDIAN</th><th>80% OF RUNS</th><th title="Average extra wins per streak against the same enemies, ±95% margin">VS EQUIPPED</th><th>LOSES TO</th>${job.start.streak > 0 ? '<th>NEXT FIGHT</th>' : ''}<th>SPREAD <span class="dim">${fmt(lo)}–${fmt(hi)}</span></th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <div class="ihid-sim-note">Final streak per gear. VS EQUIPPED: average extra wins per streak against the same enemies (± is the 95% margin; green / red when it's clear).</div>
      ${jobNotes(job, levels)}`;
  }

  // Stat priority: the suffixes ranked by extra wins, best first.
  function priorityResultHtml(job) {
    const [eq, ...rest] = job.variants;
    const n = Math.min(...job.variants.map((v) => v.results.length));
    if (n < 2) return '<div class="ihid-sim-note">Simulating…</div>';
    const streaks = eq.results.slice(0, n).map((r) => r.streak).sort((a, b) => a - b);
    const rows = rest.map((v) => ({ v, gain: pairedGain(v.results, eq.results, n) })).sort((a, b) => b.gain.mean - a.gain.mean);
    const top = Math.max(1e-9, ...rows.map((r) => r.gain.mean));
    const body = rows.map(({ v, gain }, i) => `<tr>
        <td class="dim">${i + 1}</td>
        <td>${esc(v.label)}<div class="ihid-sim-note">${esc(`${v.added} → ${statChanges(v.P, eq.P)}`)}</div></td>
        <td>${gainHtml(gain)}</td>
        <td class="ihid-sim-bar"><i style="width:${Math.max(0, Math.round((gain.mean / top) * 100))}%"></i></td>
      </tr>`);
    const levels = job.variants.flatMap((v) => v.results.map((r) => r.level)).sort((a, b) => a - b);
    return `
      <div class="ihid-sim-stat"><span class="dim">EQUIPPED</span><span><b>${plusCap(quantile(streaks, 0.5))}</b> median final streak · 80% of runs end between ${plusCap(quantile(streaks, 0.1))} and ${plusCap(quantile(streaks, 0.9))}</span></div>
      <table class="ihid-sim-table">
        <thead><tr><th>#</th><th>ONE MORE SUFFIX OF</th><th title="Average extra wins per streak against the same enemies and dice, ±95% margin">EXTRA WINS</th><th></th></tr></thead>
        <tbody>${body.join('')}</tbody>
      </table>
      <div class="ihid-sim-note">Each row adds one T${PRIORITY_TIER} suffix (the middle of its range) at iLvl ${fmt(job.itemLevel)}, your gear's average, on top of the equipped gear.
        EXTRA WINS: average per streak against the same enemies and dice (± is the 95% margin; green when it's clearly above zero). Test items aren't included.</div>
      ${jobNotes(job, levels)}`;
  }

  const simResultHtml = (job) => (!job.variants[0].results.length ? '' : job.kind === 'priority' ? priorityResultHtml(job)
    : job.variants.length === 1 ? singleResultHtml(job) : compareResultHtml(job));

  function simFooterHtml(P, model) {
    if (!P) return '<div class="ihid-sim-note">Click your name (USER INFO panel) once so the game loads your combat stats.</div>';
    const parts = [`${fmt(P.maxHp)} HP`, `${fmt(P.atk)} ATK`, `${fmt(P.def)} DEF`, `${fmt(P.acc)} ACC`, `${fmt(P.eva)} EVA`,
      `${(P.cc * 100).toFixed(1)}% crit ×${P.cd.toFixed(2)}`, `×${P.as.toFixed(2)} SPD`, `${fmt(P.regen)} regen`, `${fmt(P.barrier)} barrier`,
      P.pen > 0 && `${fmt(P.pen)} pen`, P.thorns > 0 && `${fmt(P.thorns)} thorns`, P.corr > 0 && `${fmt(P.corr)} corruption`, `${fmt(P.healBase)} heal`].filter(Boolean);
    const enemies = model ? `Enemies: built-in model of this zone, measured on ${fmt(model.n)} fights at Lv ${fmt(model.lo)} – ${fmt(model.hi)}. ` : '';
    return `<div class="ihid-sim-note">Equipped, hack Lv ${fmt(P.level)}: ${parts.join(' · ')}</div>
      <div class="ihid-sim-note">${enemies}Not simulated yet: ${NOT_SIMULATED}.</div>`;
  }

  function renderSim(panel, part = 'all') {
    const body = panel.querySelector('.ihid-sim-body');
    if (!body) return;
    if (part === 'all' || !body.querySelector('.ihid-sim-controls')) {
      body.innerHTML = `<div class="ihid-sim-controls"></div><div class="ihid-sim-result"></div><div class="ihid-sim-footer"></div>`;
    }
    if (part === 'all' || part === 'controls') body.querySelector('.ihid-sim-controls').innerHTML = simControlsHtml();
    const job = simUi.job || simUi.last;
    body.querySelector('.ihid-sim-result').innerHTML = job && job.zone === simUi.zone ? simResultHtml(job) : '';
    body.querySelector('.ihid-sim-footer').innerHTML = simFooterHtml(simPlayer(), modelZone(simUi.zone));
  }

  // kind: 'gear' (equipped vs test items) or 'priority' (equipped vs one more suffix of each kind).
  function startSimulation(panel, kind = 'gear') {
    const variants = kind === 'priority' ? priorityVariants() : simVariants();
    const makeEnemy = enemyMaker(simUi.zone);
    const zone = zoneList().find((z) => z.id === simUi.zone);
    if (!variants || !makeEnemy || !zone) return renderSim(panel);
    const current = currentStreakStart();
    const start = simUi.mode === 'continue' && !current.why ? current : { streak: 0, hp: null };
    const offset = Number(zone.level_offset) || 0;
    const job = {
      kind, itemLevel: variants.itemLevel,
      zone: simUi.zone, runs: simUi.runs, done: 0, start, seed: (Math.random() * 2 ** 32) >>> 0,
      model: modelZone(simUi.zone), firstLevel: variants[0].P.level + offset + streakLevelBonus(start.streak + 1),
      variants: variants.map((v) => ({ ...v, results: [], start: { streak: start.streak, hp: start.hp == null ? v.P.maxHp : Math.min(v.P.maxHp, start.hp) } })),
    };
    simUi.job = job;
    renderSim(panel);
    const step = () => guard(() => {
      if (simUi.job !== job) return; // stopped
      const until = performance.now() + 25;
      while (job.done < job.runs && performance.now() < until) {
        const seed = (job.seed + Math.imul(job.done + 1, 0x9e3779b1)) >>> 0;
        for (const v of job.variants) v.results.push(simulateStreak(v.P, makeEnemy, offset, v.start, seededRandom(seed)));
        job.done++;
      }
      if (job.done >= job.runs) {
        simUi.job = null;
        simUi.last = job;
        renderSim(panel);
        return;
      }
      if (job.done % 20 < 5) renderSim(panel, 'result');
      setTimeout(step, 0);
    });
    setTimeout(step, 0);
  }

  function ensureSimPanel() {
    const status = document.getElementById('combat-status');
    if (!status || document.getElementById(SIM_ID)) return;
    const panel = document.createElement('details');
    panel.id = SIM_ID;
    panel.dataset.ihid = '';
    panel.open = store.get('simOpen', false);
    panel.innerHTML = '<summary class="section-header">STREAK SIMULATOR</summary><div class="ihid-sim-body"></div>';
    status.after(panel);
    panel.addEventListener('toggle', () => {
      store.set('simOpen', panel.open);
      if (panel.open) guard(() => renderSim(panel));
    });
    panel.addEventListener('change', (e) => guard(() => {
      const t = e.target;
      if (t.dataset.sim === 'zone') simUi.zone = t.value;
      else if (t.dataset.sim === 'runs') store.set('simRuns', (simUi.runs = Number(t.value) || 300));
      else if (t.dataset.sim === 'pairs') store.set('simPairs', (simUi.pairs = t.checked));
      else if (t.name === 'ihid-sim-mode') simUi.mode = t.value;
      else if (t.dataset.sim === 'add') {
        const item = inventoryItems().find((it) => itemKey(it) === t.value);
        if (item) return toggleSimTest(item); // re-renders
      }
      renderSim(panel);
    }));
    panel.addEventListener('click', (e) => guard(() => {
      const remove = e.target.closest('[data-sim-remove]');
      if (remove) {
        const item = simTests.find((it) => itemKey(it) === remove.dataset.simRemove);
        if (item) toggleSimTest(item);
        return;
      }
      if (e.target.closest('[data-sim="priority"]')) {
        if (!simUi.job) startSimulation(panel, 'priority');
        return;
      }
      if (!e.target.closest('[data-sim="run"]')) return;
      if (simUi.job) {
        simUi.last = simUi.job; // keep what it got so far
        simUi.job = null;
        renderSim(panel);
      } else {
        startSimulation(panel);
      }
    }));
    if (panel.open) renderSim(panel);
  }

  // After each fight the "continue" option shows the new streak (and the Info Display page's
  // recorded count grows).
  function refreshSimAfterFight() {
    const panel = document.getElementById(SIM_ID);
    // Not while a dropdown in it is in use: rebuilding the controls would close it.
    if (panel && panel.open && !simUi.job && !panel.contains(document.activeElement)) renderSim(panel, 'controls');
    if (infoShown()) updateInfoCounts();
  }

  // ---- "+ TEST IN STREAK SIMULATOR" in the game's item tooltip (inventory, marketplace, chat links, ...).
  // The game keeps the item it's showing in activeItemTooltipState; our button sits above its actions.
  const TOOLTIP_BTN_ID = 'ihid-tooltip-sim';

  function syncTooltipButton() {
    const tip = document.getElementById('item-tooltip');
    if (!tip) return;
    const state = read(() => activeItemTooltipState, null);
    const item = state && state.item;
    const testable = item && !tip.classList.contains('hidden') && SLOT_ORDER.includes(item.slot) && !state.isEquipped && !equippedIds().has(item.id);
    let btn = document.getElementById(TOOLTIP_BTN_ID);
    if (!testable) {
      if (btn && !btn.hidden) btn.hidden = true;
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = TOOLTIP_BTN_ID;
      btn.className = 'btn btn-sm';
      btn.dataset.ihid = '';
      btn.addEventListener('click', (e) => guard(() => {
        e.stopPropagation(); // keep the game's own tooltip click handling out of it
        const shown = read(() => activeItemTooltipState.item, null);
        if (shown) toggleSimTest(shown);
        syncTooltipButton();
      }));
    }
    const anchor = document.getElementById('tooltip-actions-divider') || document.getElementById('tooltip-actions');
    if (anchor && anchor.parentNode && btn.nextElementSibling !== anchor) anchor.before(btn);
    else if (!anchor && btn.parentNode !== tip) tip.append(btn);
    if (btn.hidden) btn.hidden = false;
    const label = isTestItem(item) ? '✓ IN STREAK SIMULATOR (click to remove)' : '+ TEST IN STREAK SIMULATOR';
    if (btn.textContent !== label) btn.textContent = label;
  }

  function initTooltipButton() {
    const tip = document.getElementById('item-tooltip');
    if (!tip) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { // after the game has also set activeItemTooltipState
        queued = false;
        guard(syncTooltipButton);
      });
    }).observe(tip, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  }

  function initSimulator() {
    ensureSimPanel();
    setInterval(() => guard(ensureSimPanel), 2000); // the Hacking page's markup can arrive late
    initTooltipButton();
  }

  // ------------------------------------------------------------------ Info Display page
  // Our own page in the game's content panel, opened from an INFO DISPLAY entry at the end of the
  // left menu (and of the modern layout's rail, the mobile menu and the mobile dropdown): what the
  // script adds, what it knows so far, and how players can share items and fights to fill the gaps.
  // The game's Router only accepts its own views, so the page goes through showContentView instead:
  // for a name it doesn't know, that still hides every game view, runs their leave hooks and moves
  // the menu highlight to data-view="infodisplay". Any view the game shows afterwards puts its own
  // "<view>-active" class on the panel body, which closes the page again.
  const INFO_VIEW = 'infodisplay';
  const INFO_ID = 'ihid-info-view';
  const INFO_ACTIVE = 'ihid-info-active';
  const share = { status: '' }; // what the last export saved, or why it failed
  const issueUrl = (template) => `${REPO}/issues/new?template=${template}.yml`;
  const extLink = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const infoView = () => document.getElementById(INFO_ID);
  const infoShown = () => infoView()?.style.display === 'block';

  // Each entry is put back if the game rebuilds its container (the mobile menu is rebuilt on every open).
  const watchedMenus = new WeakSet();
  function keepEntry(container, html, beforeSelector) {
    if (!container) return;
    let recent = [];
    const put = () => {
      if (container.querySelector('[data-ihid="menu"]')) return; // the dropdown's <option> has no data-view
      const now = Date.now();
      recent = recent.filter((t) => now - t < 2000);
      if (recent.push(now) > 10) return; // the game keeps removing it: don't fight it in a loop
      const before = beforeSelector && container.querySelector(beforeSelector);
      if (before) before.insertAdjacentHTML('beforebegin', html);
      else container.insertAdjacentHTML('beforeend', html);
    };
    put();
    if (watchedMenus.has(container)) return;
    watchedMenus.add(container);
    new MutationObserver(() => guard(put)).observe(container, { childList: true });
  }

  function ensureMenuEntries() {
    const glyph = (cls) => `<span class="${cls} ihid-glyph" aria-hidden="true">&#9432;</span>`;
    keepEntry(document.querySelector('[data-panel-id="menu"] .menu-content'),
      `<button type="button" class="menu-link" data-view="${INFO_VIEW}" data-ihid="menu" aria-label="Info Display">&gt; INFO DISPLAY</button>`);
    keepEntry(document.getElementById('desktop-nav-bottom'), // modern layout: the rail's pinned group, after Settings
      `<button type="button" class="mobile-tab desktop-nav-only" data-view="${INFO_VIEW}" data-ihid="menu" aria-label="Info Display">
        ${glyph('mobile-tab-icon mobile-tab-icon-glyph')}<span class="mobile-tab-label">Info Display</span></button>`);
    keepEntry(document.getElementById('mobile-more-grid'),
      `<button type="button" class="mobile-more-item" data-view="${INFO_VIEW}" data-ihid="menu">
        ${glyph('mobile-more-item-icon')}<span class="mobile-more-item-label">Info Display</span></button>`);
    keepEntry(document.getElementById('mobile-nav'), `<option value="${INFO_VIEW}" data-ihid="menu">INFO DISPLAY</option>`, 'option[value="logout"]');
  }

  function ensureInfoPage() {
    const body = document.querySelector('#content-panel .content-panel-body');
    if (body && !infoView()) {
      const view = document.createElement('div');
      view.id = INFO_ID;
      view.dataset.ihid = '';
      view.style.display = 'none';
      body.append(view);
      view.addEventListener('click', (e) => guard(() => infoClick(e)));
      view.addEventListener('change', (e) => guard(() => infoChange(e)));
      new MutationObserver(() => {
        if (infoShown() && [...body.classList].some((c) => c.endsWith('-active') && c !== INFO_ACTIVE)) closeInfoPage();
      }).observe(body, { attributes: true, attributeFilter: ['class'] });
    }
    ensureMenuEntries();
    if (infoShown()) updateInfoCounts(); // items seen while it's open
  }

  function openInfoPage(push = true) {
    ensureInfoPage();
    const view = infoView();
    if (!view) return;
    const body = view.parentNode;
    if (!read(() => (showContentView(INFO_VIEW), true), false)) {
      [...body.children].forEach((el) => el !== view && (el.style.display = 'none')); // the game renamed it
    }
    const placeholder = document.getElementById('content-placeholder'); // what showContentView shows for unknown names
    if (placeholder) placeholder.style.display = 'none';
    const header = document.querySelector('#content-panel .panel-header');
    if (header) header.textContent = 'INFO DISPLAY';
    body.classList.add(INFO_ACTIVE);
    view.innerHTML = infoPageHtml();
    view.style.display = 'block';
    refreshFightCount();
    // The Router ignores this entry when going back to it, so our popstate listener opens the page.
    if (push && history.state?.view !== INFO_VIEW) history.pushState({ view: INFO_VIEW }, '', `#${INFO_VIEW}`);
  }

  function closeInfoPage() {
    const view = infoView();
    if (!view) return;
    view.style.display = 'none';
    view.parentNode.classList.remove(INFO_ACTIVE);
  }

  function zoneCoverageHtml() {
    const zones = zoneList();
    const titled = (id) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const known = zones.length ? zones : Object.keys(ENEMY_MODEL.zones || {}).map((id) => ({ id, name: titled(id) }));
    const measured = known.filter((z) => modelZone(z.id)).map((z) => {
      const m = modelZone(z.id);
      return `${esc(z.name)} <span class="dim">(${fmt(m.n)} fights, Lv ${fmt(m.lo)}–${fmt(m.hi)})</span>`;
    });
    const missing = zones.filter((z) => !modelZone(z.id)).map((z) => esc(z.name));
    return `<li><b>Zones the simulator can use</b>: ${measured.join(', ') || 'none yet'}.</li>
      <li><b>Zones not measured yet</b>: ${missing.length ? `${missing.join(', ')}.` : zones.length ? 'none.' : 'every other zone (open Hacking once to list them).'}</li>`;
  }

  function infoPageHtml() {
    const seedStats = Object.keys(TIER_SEED).length;
    const seedBounds = Object.values(TIER_SEED).reduce((n, tiers) => n + Object.keys(tiers).length, 0);
    const go = (view, label) => `<button type="button" class="btn btn-sm" data-info-go="${view}">${label}</button>`;
    return `
      <div class="ihid-info-head">
        <span class="ihid-info-title">INFO DISPLAY</span>
        <span class="dim">version ${esc(BUILD)}</span>
        <span>${extLink(REPO, 'GitHub')} · ${extLink(issueUrl('bug'), 'report a problem')}</span>
      </div>
      <p>A userscript that adds extra info to the game's own panels. It only reads what the game already sends to your
        browser, automates nothing, and nothing leaves your browser unless you export it below. Made by a player, not
        part of Idle Hacking.</p>

      <h3>WHAT IT ADDS</h3>
      <div class="ihid-info-cards">
        <div class="ihid-info-card">
          <h4>INVENTORY › ENHANCING ${go('inventory', 'OPEN')}</h4>
          <ul>
            <li><b>Affix bias tags</b>: every prefix and suffix shows which essences' Bias Reroll can roll it; tags of the
              selected bias light up.</li>
            <li><b>Version Upgrade preview</b>: hover VERSION UPGRADE to see the affix's range at every better tier and
              what each step gains.</li>
            <li><b>Refactor preview</b>: hover REFACTOR to see each stat's tier range and where your roll sits in it.</li>
            <li><b>Bias outcomes</b>: under BIAS REROLL / AUGMENT / PRUNE, how many prefixes and suffixes each essence can
              guarantee on the item's slot, and which ones.</li>
          </ul>
        </div>
        <div class="ihid-info-card">
          <h4>HACKING › STREAK SIMULATOR ${go('hacking', 'OPEN')}</h4>
          <ul>
            <li><b>Streak simulator</b>: plays hundreds of streaks in a zone with your current stats and shows where they
              end: median, spread, and the enemy level you lose at. It can also continue your live streak.</li>
            <li><b>Test items</b>: "+ TEST IN STREAK SIMULATOR" in any item tooltip compares the item with your equipped
              gear, in extra wins per streak, without equipping it.</li>
            <li><b>Stat priority</b>: ranks which suffix would add the most wins to your gear.</li>
          </ul>
        </div>
      </div>

      <h3>WHAT IT KNOWS SO FAR</h3>
      <ul>
        <li><b>Affix tiers</b>: built in for ${fmt(seedStats)} affix stats (${fmt(seedBounds)} tier boundaries), plus what this
          browser learns from every item it sees (${fmt(Object.keys(tierData).length)} affix stats so far). A tier nobody has
          shared yet shows as <code>?</code> in the Version Upgrade preview.</li>
        ${zoneCoverageHtml()}
        <li><b>Not simulated yet</b>: ${NOT_SIMULATED}.</li>
      </ul>

      <h3>HELP IMPROVE THE DATA</h3>
      <p>All of the above comes from items and fights that players exported, and one account only sees part of the game.
        If you have items, zones or mechanics the lists above are missing, export them here and attach the file to a new
        issue on GitHub (a free account is enough). Shared files go into the next version, for everyone.</p>
      <div class="ihid-info-cards">
        <div class="ihid-info-card">
          <h4>SHARE ITEMS</h4>
          <ol>
            <li>Open your Inventory once, so the game loads it.</li>
            <li>Browse the Marketplace: page size 100, different slots and sort orders. Every item you see is collected,
              including chat links and drops.</li>
            <li>Without reloading the page, click EXPORT ITEMS.</li>
            <li>Attach the file to a ${extLink(issueUrl('item-data'), 'new item data issue')}.</li>
          </ol>
          <div class="ihid-info-row">
            <button type="button" class="btn" data-info="export-items">EXPORT ITEMS</button>
            <span class="dim"><span data-info-count="items">${fmt(seenItems.size)}</span> items seen since the page loaded</span>
          </div>
        </div>
        <div class="ihid-info-card">
          <h4>SHARE FIGHTS</h4>
          <ol>
            <li>Tick <b>record fights</b> below, and Detailed Logs in Hacking › COMBAT LOG.</li>
            <li>Click your name in USER INFO once, and open Homelab once, so the export has your stats and homelab.</li>
            <li>Hack at least one whole streak in a zone that isn't measured yet, or on an account with something that
              isn't simulated yet. A zone needs about 1,000 fights, and recordings from several players add up.</li>
            <li>Click EXPORT FIGHTS and attach the file to a ${extLink(issueUrl('combat-data'), 'new fights issue')}.</li>
          </ol>
          <div class="ihid-info-row">
            <label class="ihid-info-check"><input type="checkbox" data-info="record"${recorder.on ? ' checked' : ''}> record fights</label>
            <span class="dim">kept in this browser only, up to 30,000 fights (~30 MB)</span>
          </div>
          <div class="ihid-info-row">
            <button type="button" class="btn" data-info="export-fights">EXPORT FIGHTS</button>
            <span class="dim"><span data-info-count="fights">…</span> fights stored</span>
            <button type="button" class="btn btn-sm" data-info="clear-rec" hidden>DELETE THEM</button>
          </div>
        </div>
      </div>
      <div class="ihid-info-status" data-info-status>${esc(share.status)}</div>
      <p class="dim">What's in the files: the items and fights as the game sent them. Other players' names on items ("found
        by", "enhanced by") are left out. A fight export also holds your combat stats, equipped gear and homelab, which
        anyone reading the issue can see, but not your username.</p>

      <h3>SOMETHING WRONG?</h3>
      <p>${extLink(issueUrl('bug'), 'Open a bug report')} with what you saw, the version (${esc(BUILD)}) and any console lines
        that start with [InfoDisplay] (F12 › Console). The source, the install link and how the numbers are worked out are
        on ${extLink(REPO, 'GitHub')} (MIT license); Tampermonkey installs new versions on its own.</p>
      ${lastError ? `<p class="dim">Last error caught since the page loaded:</p><pre>${esc(lastError)}</pre>` : ''}`;
  }

  function updateInfoCounts() {
    const view = infoView();
    if (!view) return;
    const set = (key, text) => view.querySelectorAll(`[data-info-count="${key}"]`).forEach((el) => {
      if (el.textContent !== text) el.textContent = text;
    });
    const n = recorder.count;
    set('items', fmt(seenItems.size));
    set('fights', n == null ? '…' : fmt(n));
    const exporter = view.querySelector('[data-info="export-fights"]');
    if (exporter) exporter.disabled = n === 0;
    const remove = view.querySelector('[data-info="clear-rec"]');
    if (remove) remove.hidden = !n;
  }

  function refreshFightCount() {
    recordedFights().then((n) => {
      recorder.count = n;
      updateInfoCounts();
    }, () => {});
  }

  function setShareStatus(text) {
    share.status = text;
    const el = infoView()?.querySelector('[data-info-status]');
    if (el) el.textContent = text;
  }

  function infoClick(e) {
    const goTo = e.target.closest('[data-info-go]');
    if (goTo) return read(() => Router.navigate(goTo.dataset.infoGo), null);
    const action = e.target.closest('[data-info]')?.dataset.info;
    if (action === 'export-items' || action === 'export-fights') {
      setShareStatus('exporting…');
      (action === 'export-items' ? exportAffixes() : exportCombat()).then(
        (done) => setShareStatus(`${done}. Attach it to a new issue (links above).`),
        (err) => setShareStatus(`export failed: ${err?.message || err}`));
    } else if (action === 'clear-rec') {
      const n = recorder.count || 0;
      if (!confirm(`Delete the ${fmt(n)} fight${n === 1 ? '' : 's'} recorded in this browser? EXPORT FIGHTS first to keep them.`)) return;
      clearCombat().then(refreshFightCount, (err) => console.warn('[InfoDisplay] could not delete recorded fights:', err));
    }
  }

  function infoChange(e) {
    if (e.target.dataset.info !== 'record') return;
    store.set('recordFights', (recorder.on = e.target.checked));
    refreshFightCount();
  }

  function initInfoPage() {
    ensureInfoPage();
    setInterval(() => guard(ensureInfoPage), 2000); // the menus and content panel can arrive late
    document.addEventListener('click', (e) => guard(() => {
      const entry = e.target instanceof Element && e.target.closest(`[data-view="${INFO_VIEW}"]`);
      if (!entry) return;
      e.preventDefault();
      if (entry.closest('#mobile-more-sheet')) read(() => Modal.hide('mobile-more-sheet'), null);
      openInfoPage();
    }));
    document.addEventListener('change', (e) => guard(() => {
      if (e.target.id === 'mobile-nav' && e.target.value === INFO_VIEW) openInfoPage();
    }));
    window.addEventListener('popstate', (e) => guard(() => {
      if (e.state?.view === INFO_VIEW) openInfoPage(false);
    }));
  }

  addStyle(`
#${BIAS_ID}{margin-top:6px}
#${BIAS_ID}>summary{cursor:pointer;width:fit-content}
#${BIAS_ID} .ihid-bias-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px 12px}
#${BIAS_ID} ul{list-style:none;margin:0;padding:0 0 0 6px;border-left:2px solid var(--border-color,#244)}
#${BIAS_ID} li{font-size:.78rem;padding:1px 0}
#${BIAS_ID} li.ihid-blocked{text-decoration:line-through;opacity:.45}
#${BIAS_ID} .ihid-bias-note{font-size:.72rem;margin-top:4px}
#${BIAS_ID} .ihid-bias-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
#${BIAS_ID} .ihid-bias-chip{font:inherit;font-size:.75rem;padding:2px 6px;cursor:pointer;
  background:rgba(0,0,0,.3);border:1px solid var(--dim-color,#567);color:var(--text-color,#cde)}
#${BIAS_ID} .ihid-bias-chip:hover:not(:disabled),#${BIAS_ID} .ihid-bias-chip.ihid-active{border-color:var(--accent-color,#3f9);color:var(--accent-color,#3f9)}
#${BIAS_ID} .ihid-bias-chips+.ihid-bias-cols{margin-top:6px}
#${BIAS_ID} .ihid-bias-chip:disabled{opacity:.45;cursor:not-allowed}
#craft-item-content .craft-affix-info:has(>.ihid-affix-bias){flex-wrap:wrap}
#craft-item-content .ihid-affix-bias{display:inline-flex;gap:3px;flex-shrink:0}
#craft-item-content .ihid-affix-bias>span{font-size:.65rem;padding:0 4px;border-radius:2px;text-transform:uppercase;
  letter-spacing:.03em;border:1px solid var(--dim-color,#567);color:var(--text-color,#cde);opacity:.8}
#craft-item-content .ihid-affix-bias>span.ihid-active{border-color:var(--accent-color,#3f9);color:var(--accent-color,#3f9);opacity:1}
.craft-cost-tooltip .ihid-upgrade{font-size:.75rem}
.craft-cost-tooltip>div:not(.ihid-upgrade)+.ihid-upgrade{margin-top:4px;padding-top:4px;border-top:1px solid var(--border-color,#244)}
.craft-cost-tooltip .ihid-upgrade-title{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin-bottom:2px}
.craft-cost-tooltip .ihid-upgrade-row{display:flex;gap:8px}
.craft-cost-tooltip .ihid-upgrade-row>b{min-width:2.2em;font-weight:600;color:var(--accent-color,#3f9)}
.craft-cost-tooltip .ihid-upgrade-row>i{margin-left:auto;font-style:normal;white-space:nowrap;opacity:.75}
.craft-cost-tooltip .ihid-upgrade-now{opacity:.6}
.craft-cost-tooltip .ihid-upgrade-now>b{color:inherit}
.craft-cost-tooltip .ihid-upgrade-note{font-size:.68rem;opacity:.6;margin-top:2px}
#${SIM_ID}{margin:8px 0;border:1px solid var(--border-color,#244);padding:4px 8px;flex-shrink:0}
#${SIM_ID}>summary{cursor:pointer;list-style:none;width:fit-content}
#${SIM_ID}>summary::-webkit-details-marker{display:none}
#${SIM_ID}>summary::before{content:'[+] ';opacity:.7}
#${SIM_ID}[open]>summary::before{content:'[-] '}
#${SIM_ID} .ihid-sim-body{font-size:.78rem;margin-top:4px}
#${SIM_ID} .ihid-sim-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-bottom:4px}
#${SIM_ID} .ihid-sim-row select{font:inherit;font-size:.75rem;max-width:100%}
#${SIM_ID} .ihid-sim-radio{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
#${SIM_ID} .ihid-sim-result:not(:empty){margin:6px 0;padding-top:6px;border-top:1px solid var(--border-color,#244)}
#${SIM_ID} .ihid-sim-stat{display:flex;gap:8px;padding:1px 0}
#${SIM_ID} .ihid-sim-stat>span:first-child{min-width:7.5em;flex-shrink:0}
#${SIM_ID} .ihid-sim-stat b{color:var(--accent-color,#3f9);font-size:.95rem}
#${SIM_ID} .ihid-sim-hist{display:flex;align-items:flex-end;gap:1px;height:36px;margin-top:6px}
#${SIM_ID} .ihid-sim-hist>i{flex:1;background:var(--accent-color,#3f9);opacity:.7;min-width:2px}
#${SIM_ID} .ihid-sim-hist-axis{display:flex;justify-content:space-between;font-size:.65rem}
#${SIM_ID} .ihid-sim-note{font-size:.7rem;opacity:.65;margin-top:3px}
#${SIM_ID} .ihid-sim-row>.ihid-sim-note{margin-top:0}
#${SIM_ID} .ihid-sim-note a{color:var(--accent-color,#3f9)}
#${SIM_ID} .ihid-sim-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 2px 1px 6px;border:1px solid var(--dim-color,#567);font-size:.72rem}
#${SIM_ID} .ihid-sim-chip>button{font:inherit;background:none;border:0;color:inherit;cursor:pointer;padding:0 4px;opacity:.7}
#${SIM_ID} .ihid-sim-chip>button:hover:not(:disabled){opacity:1;color:var(--accent-color,#3f9)}
#${SIM_ID} .ihid-sim-table{width:100%;border-collapse:collapse;font-size:.74rem}
#${SIM_ID} .ihid-sim-table th{text-align:left;font-weight:normal;opacity:.65;font-size:.66rem;padding:2px 6px 2px 0;white-space:nowrap}
#${SIM_ID} .ihid-sim-table td{padding:3px 6px 3px 0;vertical-align:top;border-top:1px solid var(--border-color,#244);white-space:nowrap}
#${SIM_ID} .ihid-sim-table td:first-child{white-space:normal}
#${SIM_ID} .ihid-sim-table b{color:var(--accent-color,#3f9)}
#${SIM_ID} .ihid-sim-table .ihid-sim-spread{width:25%;min-width:70px}
#${SIM_ID} .ihid-sim-hist-small{height:18px;margin-top:0}
#${SIM_ID} .ihid-sim-table .ihid-sim-bar{width:30%;min-width:60px;vertical-align:middle}
#${SIM_ID} .ihid-sim-bar>i{display:block;height:8px;background:var(--accent-color,#3f9);opacity:.7}
#${SIM_ID} .ihid-sim-up{color:var(--accent-color,#3f9)}
#${SIM_ID} .ihid-sim-down{color:var(--error-color,#f66)}
#ihid-tooltip-sim{display:block;width:100%;margin:6px 0 2px;font-size:.72rem}
.ihid-glyph{display:inline-flex;align-items:center;justify-content:center;font-style:normal;line-height:1;font-size:1.15em}
#${INFO_ID}{width:100%;box-sizing:border-box;padding:2px 2px 12px;font-size:.84rem;line-height:1.45}
#${INFO_ID} p{max-width:120ch}
#${INFO_ID} .ihid-info-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin-bottom:4px}
#${INFO_ID} .ihid-info-title{font-size:1.05rem;letter-spacing:.08em;color:var(--accent-color,#3f9)}
#${INFO_ID} h3{font-size:.78rem;font-weight:600;letter-spacing:.08em;margin:16px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--border-color,#244);color:var(--accent-color,#3f9)}
#${INFO_ID} h4{display:flex;align-items:center;gap:8px;font-size:.74rem;font-weight:600;letter-spacing:.05em;margin:0 0 4px}
#${INFO_ID} p{margin:4px 0}
#${INFO_ID} ul,#${INFO_ID} ol{margin:4px 0;padding-left:20px}
#${INFO_ID} li{margin:3px 0}
#${INFO_ID} a{color:var(--accent-color,#3f9)}
#${INFO_ID} code{font-size:.95em}
#${INFO_ID} .ihid-info-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
#${INFO_ID} .ihid-info-card{border:1px solid var(--border-color,#244);padding:8px 10px}
#${INFO_ID} .ihid-info-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:8px}
#${INFO_ID} .ihid-info-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
#${INFO_ID} .ihid-info-status:not(:empty){margin:8px 0 4px;color:var(--accent-color,#3f9)}
#${INFO_ID} pre{white-space:pre-wrap;font-size:.7rem;max-height:9em;overflow:auto;border:1px solid var(--border-color,#244);padding:4px 6px;margin:4px 0}
`);

  guard(initEnhancing);
  guard(initTierLearning);
  guard(initSimulator);
  guard(initInfoPage);

  // ------------------------------------------------------------------ dev helpers
  // Downloads, as the game sent them (minus other players' names): every equipped and inventory
  // item plus every other item seen this session (e.g. marketplace pages browsed since the last
  // reload). Open the Inventory once first so it's loaded.
  async function exportAffixes() {
    const equipped = Object.values(read(() => equipmentData, null) || {}).filter(Boolean);
    const stored = (read(() => inventoryData.items, null) || []).filter(Boolean);
    learnFrom([equipped, stored]); // makes sure both are in seenItems too
    const items = [...seenItems.values()];
    const name = await downloadJson('idlehacking-affixes', items, 1);
    const others = Math.max(0, items.length - equipped.length - stored.length);
    return `${fmt(items.length)} items (${fmt(equipped.length)} equipped, ${fmt(stored.length)} in inventory, ${fmt(others)} seen elsewhere, e.g. marketplace) saved to ${name}`;
  }

  // Console handle for poking at the script while developing.
  window.ihInfoDisplay = {
    build: BUILD, affixes, exportAffixes, tierData, learnFrom, predictEffect, upgradeTiers, rollPosition, exportCombat, combatCounts, clearCombat,
    // the simulator's parts, for the console and tools/check-combat.mjs
    sim: {
      simulateFight, simulateStreak, enemyMaker, enemyModel: ENEMY_MODEL, poolEntry, simPlayer, gearTotals, itemBonuses, streakLevelBonus,
      postCombatHeal, damageReduction, attackPhases, seededRandom, simTests, prioritySuffixes, priorityVariants, pairedGain,
    },
  };
})();
