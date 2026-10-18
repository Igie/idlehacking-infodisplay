# Idle Hacking InfoDisplay

A userscript for [Idle Hacking](https://www.idlehacking.com/play) that adds extra info to the game's own
panels (no windows of its own). It reads what the game already sends to your browser, automates nothing, and
nothing leaves your browser unless you export it.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/). In Chrome, Brave or Edge, open the extension's
   **Details** and turn on **Allow User Scripts** as well.
2. Open **[infodisplay.user.js](https://raw.githubusercontent.com/Igie/idlehacking-infodisplay/main/dist/infodisplay.user.js)**
   and click **Install**.
3. Reload the game.

Tampermonkey checks for new versions on its own (about once a day), so updates install themselves.

## Features

- **Enhancing → affix bias tags**: each prefix/suffix row gets tags for the essences whose Bias Reroll can
  produce it (e.g. `of Immortality T2 SURVIVAL`); tags matching the selected bias are highlighted.
- **Enhancing → Version Upgrade preview**: hovering VERSION UPGRADE adds "If upgraded" rows to the game's
  cost tooltip: the affix's range at every better tier up to T1, computed with the game's own formulas
  (below), each with its gain over the tier below (`+25%`: middle of the range vs middle of the range).
  `a~b` = one of these two (not enough sightings yet), `?` = that tier not seen on any item yet.
- **Enhancing → Refactor preview**: hovering REFACTOR shows each stat's value, its tier range and where the
  raw roll sits in that range (e.g. `21% into the range`, Compile taken out); Refactor rerolls anywhere in it.
- **Enhancing → Bias outcomes**: under the BIAS REROLL / AUGMENT / PRUNE buttons, essence chips show how
  many prefixes/suffixes each bias can guarantee on the item's slot; picking one (chip or the game's
  dropdown) lists them. Affixes sharing a group with the locked affix are struck through. Data comes from
  `/api/help/affixes`, the same list as Help › Affixes.
- **Hacking → Streak simulator**: a collapsible panel under COMBAT STATUS that plays a few hundred streaks in
  a zone with your current stats and shows where they end: the median final streak, the range 80% of runs
  fall in, best/worst, the enemy level you lose at, and a histogram. "Continue current streak" starts from
  your live streak and HP and adds the next fight's win chance. It runs in the browser only, with no
  server calls or run limits, and stores nothing. Enemies come from a built-in model of each zone (see How
  combat works), measured so far for Local Network, Coffee Shop WiFi, Small Business Server and Corporate
  Network; the other zones are listed as not measured yet.
- **Test items without equipping them**: every item tooltip (inventory, marketplace, chat links, drops) gets
  **+ TEST IN STREAK SIMULATOR**; the panel can also add items from the inventory. SIMULATE then compares your
  equipped gear with each test item in its slot, plus all of them together when they fit different slots:
  median streak, the stat changes, and **VS EQUIPPED**, the average extra wins per streak. Every variant meets
  the same enemies and dice run by run, so that difference is accurate to about ±0.2–0.4 wins at 300 runs. Test
  items are kept across reloads (up to 8); items you can't equip yet are marked.
- **Stat priority**: **STAT PRIORITY** in the same panel adds one more suffix of each kind to your equipped gear
  (the middle of T5 at your gear's average item level) and ranks them by extra wins per streak, so you can see
  which stat to look for on the next item. "Two-stat suffixes too" adds the hybrids (Defense & Regeneration,
  ...). It uses the zone, RUNS and new/continue settings above; 300 runs take a few seconds.
- **Info Display page**: **INFO DISPLAY** at the bottom of the game's left menu (in the modern layout, at the bottom
  of the left rail; on mobile, in the menu) opens the script's own page: what it adds and where, what it knows so far
  (built-in tier table, which zones the simulator can use), recording and exporting data to share, and where to
  report problems.

## Help improve the data

Everything the script knows about tier ranges and enemies comes from items and fights that players exported.
One account only sees part of the game, so there are gaps:

- **Affix tiers**: the Version Upgrade preview shows `?` for a tier nobody has seen on an item yet, and `a~b`
  where the sightings don't settle it yet. High item levels, T1/T0 affixes, signatures, extensions and special
  implicits are the thinnest.
- **Zones**: the streak simulator can only use zones with a measured enemy model. For now that leaves out Data
  Center and every zone after it ("not measured yet" in the ZONE list).
- **Mechanics**: signatures, lifesteal, Quarantine Rules, Snapshot Rollback, homelab enemy reductions and gear
  automation aren't simulated, because the recording account didn't have them.

Recording and both exports are on the **INFO DISPLAY** page (bottom of the game's left menu). Each export saves a
`.json.gz` file that you attach to a new issue. The page and the issue forms repeat these steps.

**Items** ([share item data](https://github.com/Igie/idlehacking-infodisplay/issues/new?template=item-data.yml))

1. Open your Inventory once, then browse the Marketplace (page size 100, different slots and sort orders). The
   script collects every item you see, including chat links and drops.
2. Without reloading the page, click **EXPORT ITEMS**. Collected items are only kept until the page reloads.
3. Attach `idlehacking-affixes-<time>.json.gz` to the issue.

**Fights** ([share recorded fights](https://github.com/Igie/idlehacking-infodisplay/issues/new?template=combat-data.yml))

1. Tick **record fights** on the Info Display page and **Detailed Logs** in Hacking › COMBAT LOG.
2. Click your name in USER INFO once and open Homelab once, so the export has your stats and homelab.
3. Hack in the zone for at least one whole streak. A zone needs about 1,000 fights in total (100+ of each enemy
   type), and recordings from several players add up.
4. Click **EXPORT FIGHTS** and attach `idlehacking-combat-<time>.json.gz` to the issue.

**What's in the files**: the items and fights as the game sent them. Other players' names on items ("found
by", "enhanced by") are left out. A fight export contains your combat stats, equipped gear and homelab, which
anyone reading the issue can see, but not your username. Recording is off unless you tick it, and recorded
fights stay in your browser (IndexedDB) until you export or delete them.

Something broken or a number that looks wrong? [Open a bug report](https://github.com/Igie/idlehacking-infodisplay/issues/new?template=bug.yml).

## Development

Needs [Node.js](https://nodejs.org/) (no `npm install`; the tools have no dependencies).

### One-time setup (Brave)

1. Open `brave://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo` (Tampermonkey → Details) and turn on
   **Allow User Scripts** and **Allow access to file URLs**.
2. `npm run install-dev`: Brave opens Tampermonkey's install page; click **Install**.

This installs "Idle Hacking InfoDisplay [dev]", a loader with no code of its own. It `@require`s
`dev/infodisplay.user.js` straight from disk. If the released script is installed too, disable it while
testing: only the copy that starts first runs, and the console says which one stayed off.

### Dev loop

```
npm run watch      # rebuilds dev/ on every save (or: npm run build)
```

Then reload the game tab. The Info Display page shows the build (`dev <time>`), so you can tell which
build is running. The build only writes `dev/` when the source compiles, so a half-finished save never reaches
the game. `dev/` is git-ignored; only releases go into `dist/`.

If you change header keys that affect injection (`@match`, `@grant`, `@require`, ...), the build says so;
run `npm run install-dev` again and click **Reinstall**.

### Releasing

1. Raise `@version` in the header of `src/infodisplay.user.js`. Installed copies only update when it goes up.
2. `npm run release` writes `dist/infodisplay.user.js` (stamped with the version) and `dist/infodisplay.meta.js`
   (the header alone). It refuses to overwrite `dist/` unless `@version` went up.
3. Commit, tag and push; the release prints the command.

Tampermonkey reads `@updateURL` (the meta file on GitHub) to look for a new version and fetches `@downloadURL`
(the script) when there is one. If the script is also on Greasy Fork, set it to sync from the raw
`dist/infodisplay.user.js` URL, so one push updates both. Greasy Fork points `@updateURL`/`@downloadURL` at
itself for installs made from there.

### Using shared data

Save the files attached to issues in the project root. Their names start with `idlehacking-affixes` or
`idlehacking-combat`, and both `.json` and `.json.gz` work. Then:

- items: `npm run merge` (adds them to `data/items.json`, deletes the exports and rewrites the seed), then
  `npm run build`.
- fights: `npm run compact-combat`, `npm run fit-enemies`, `npm run build`, then `npm run check-combat`.

`check-combat`'s gear checks use the newest export's gear and stats, and skip older exports that share no
equipped item with it (another player's). After merging someone else's fights, export your own again so the
newest one is yours.

To grow the tier table yourself, do the same as under Help improve the data: browse marketplace pages, export
without reloading, save the file here, then `npm run merge` and `npm run build`.

## Files

| Path | What |
| --- | --- |
| `src/infodisplay.user.js` | the userscript (source of truth) |
| `tools/build.mjs` | compile check, build stamp; writes `dev/` (dev build + loader) or, with `--release`, `dist/` |
| `tools/install-dev.mjs` | serves the loader on 127.0.0.1 and opens it in Brave |
| `dev/` | dev build and loader (git-ignored) |
| `dist/infodisplay.user.js`, `dist/infodisplay.meta.js` | the released script and its header; what users install and update from |
| `tools/make-seed.mjs` | `npm run seed`: item exports → `src/tier-seed.json` (inlined by the build); `npm run merge` also folds new exports into `data/items.json` |
| `src/tier-seed.json` | tier boundaries pinned down by the exports so far |
| `data/items.json` | every item state exported so far (EXPORT ITEMS), the seed's input (git-ignored) |
| `idlehacking-affixes*.json(.gz)` | new item exports not merged yet (also read by the seed) |
| `idlehacking-combat*.json(.gz)` | new combat exports (EXPORT FIGHTS) not compacted yet |
| `data/combat.json.gz` | every fight recorded so far, plus each export's game state (`npm run compact-combat`; git-ignored) |
| `src/enemy-model.json` | the enemy model per zone (`npm run fit-enemies`, inlined by the build) |
| `tools/compact-combat.mjs`, `tools/combat-data.mjs` | fold exports into the archive; read archive + exports |
| `tools/fit-enemies.mjs` | `npm run fit-enemies`: archive → `src/enemy-model.json` |
| `tools/check-combat.mjs` | `npm run check-combat`: checks the simulator's rules and enemy model against the recordings |
| `.github/ISSUE_TEMPLATE/` | the issue forms for sharing items, fights and bug reports |

## How it reads the game

The game client is plain, unbundled scripts that keep state in top-level `let`/`const` bindings
(`currentPlayer`, `hackingState`, `ws`, ...). Those aren't `window` properties, but code in the page
realm can read them by name, and `@grant none` keeps the script in the page realm. Every access goes
through a guarded `read()`, so a binding the game renames shows a fallback instead of throwing.

Panels are rebuilt with `innerHTML` on every change, so additions are re-attached by a
`MutationObserver` on the panel container instead of patching game functions.

Console helpers (`ihInfoDisplay.*`): `await exportAffixes()` (the EXPORT ITEMS button) downloads, as the game
sent them minus other players' names, all equipped and inventory items plus every item seen since the page loaded
(e.g. marketplace pages) as `idlehacking-affixes-<time>.json.gz`; `tierData` is what this
browser has learned on top of the built-in seed; `upgradeTiers(item, affix)` and `predictEffect(...)` predict;
`rollPosition(item, affix, effect)` gives a roll's place in its tier.

## Combat recorder

The server resolves every fight and only sends the outcome. Help › Hacking documents the round order and most
formulas, but not hit chance, damage rolls, or how enemy levels and stats follow zone and win streak. Those were
worked out from recorded fights (below). Recording is **off** by default, since the simulator has the enemy
model built in; tick **record fights** on the Info Display page to measure a zone it doesn't cover yet or to
re-check the rules after a game update. While on, every `HACKING_RESULT` goes to IndexedDB (`ihInfoDisplay.combat`):
the enemy's level, class and stats, the streak, the zone, your Profile › Combat totals at the time, and the
round-by-round log. It also keeps Software Profiler / CI/CD Pipeline results and loss-streak replays. Limits:
30,000 fights, round logs for the last 3,000, 500 other messages. The Info Display page shows how many fights are stored and
can delete them.

To add a zone: record one whole streak there (Detailed Logs on), export, then `npm run compact-combat`,
`npm run fit-enemies`, `npm run build`, and `npm run check-combat`. A zone needs 100+ fights of every enemy type
over at least a 1.5× level span.

- `await ihInfoDisplay.combatCounts()`: how much is recorded; `await ihInfoDisplay.clearCombat()` deletes it.
- `await ihInfoDisplay.exportCombat()` (the EXPORT FIGHTS button): downloads `idlehacking-combat-<time>.json.gz`
  with the recordings plus zones, stats breakdown, equipment (minus other players' names), homelab, loss streaks
  and the game's own simulator history. Exports are gzipped where the browser has `CompressionStream` (plain
  `.json` otherwise) and named by the time, so several don't overwrite each other. Open Hacking, your profile
  (click your name in the USER INFO panel; its COMBAT tab has the stats) and Homelab once first so the game has loaded them.
- Round logs only arrive while **Detailed Logs** (Hacking › COMBAT LOG) is ticked. **View Last 10 Losses** plus opening
  each one loads those losses' logs too.
- `npm run compact-combat`: folds the `idlehacking-combat*.json(.gz)` exports in the project root into `data/combat.json.gz`
  (each fight, round log and message once, plus every export's game state), checks that nothing is missing, and
  deletes the exports (`--keep` leaves them).
- `npm run check-combat [runs]`: replays `data/combat.json.gz` plus any exports still in the root (game state from the
  newest) against the simulator in the dev build (`dev/`, so `npm run build` first): exact rules must match every logged event, random ones are compared as
  rates, each recorded fight and streak is compared with simulated ones, and the gear math must rebuild the stats
  breakdown (and any gear change since an older export).

## How combat works

Help › Hacking gives the round order. The rest was worked out from 322 fights / 269 round logs (Small Business
Server, hack level 292–296); `check-combat` matched every logged event of the exact rules:

```
attacks per round   floor(Attack Speed), plus one more with chance = the fraction
                    attack i of n at time i/n; equal times resolve together (one phase)
hit chance          accuracy / (accuracy + evasion)                    (rate within ~1% of the logs)
hit damage          round(attack × U(0.8, 1.2) × (1 − DR) × 0.9^n × crit), at least 1
                    n = hits this attacker already landed this round
                    DR = D / (D + 100 + 0.04 × attacker level),  D = defense × (1 − ignored)
                    ignored = min(95%, 0.95 × pen / (pen + 400 + 0.1 × defender level))
                    crit = 1 + (crit damage − 1) × (1 + 0.9 + 0.81 …), one term per crit layer
thorns              thorns × 0.9^n per landed hit taken, rounded on the round's running total (so a reflect
                    can be 0 when thorns is below about 2)
corruption          each landed hit adds a stack: floor(corruption × 0.9^n) per tick, 5 ticks
                    every phase ticks 1/phases; a stack has dealt floor(value × ticks used) so far
regeneration        after each round: floor(regen − 1.5 × corruption per tick still on you)
barrier             takes hits, thorns and corruption before HP; full at the start of each fight
post-combat heal    round(heal × max(0.3, 0.99^(streak − 10))) after a win; HP carries into the next fight
enemy level         hack level (before the fight) + zone level_offset + Σ floor((k − 2) / 10), k = 12..streak
enemies             one of 9 types = 3 offensive × 3 defensive archetypes, about equally often; the name is the
                    type's prefix + one of the zone's 5 nouns, which has no effect on stats
enemy stats         type constant × level^b × e^(g × t), ~1% left over, with ONE roll t per enemy (about ±0.5)
                    b ≈ 1.0 for HP, attack, defense, accuracy, evasion; 0.64–0.83 for regen, barrier, pen, thorns,
                    corruption; g ≈ +1 regen, barrier, thorns, −1 pen, corruption, +0.08–0.13 HP, defense,
                    evasion, −0.09 attack, accuracy, attack speed, −0.57 crit chance (holds over Lv 343–1625)
zones               one number s per zone: Local Network 0.375, Coffee Shop 0.625, Small Business 1, Corporate
                    Network 1.375 (3/8, 5/8, 8/8, 11/8; each ±0.5%; not the softcaps, rarity or credits). Against
                    Small Business at the same level, type and roll,
                    stat × (1 − e × (1 − s)), where e is the stat's zone share, the same in every zone: 1 for regen,
                    barrier, pen, thorns, corruption; ~0.6 crit chance; 0.04–0.10 for the other main stats, more
                    for a type's boosted stat (HP 0.15 average). 20 fights pin s to ±0.5%. The zone part also
                    grows a bit faster with level (each zone's exponents differ by up to 0.03), which this
                    constant factor misses: Local Network streak median 184 with it vs 190 with its own fit.
                    Corporate Network's secondaries break the one-number rule: per type they drift ±10–20% from
                    Small Business with level, smoothly and with the sign flipping around Lv 1300 (thorns/regen of
                    the defensive types −10% at Lv 750, +14% at Lv 1800), which Local Network and Coffee Shop don't
                    do at the same levels; its s averages 11/8 but reads 1.36 at Lv 750 and 1.40 at Lv 1800.
                    The simulator fits every zone on its own, so this doesn't affect it
your stats          (base + level + flat) × (1 + equipment % + hardware + homelab) × (1 + syndicate) × (1 + plugins)
                    Crit Chance / Crit Damage: base + equipment % + hardware + homelab, then the same multipliers
                    Max HP is the total ± 1; the exact rounding is unknown (no simple rule fits every fight;
                    rounding down after the first bracket and again at the end fits about half)
                    equipment % / flat = the sum of the items' implicits and affix effects (shown values)
```

Variants are compared with common random numbers: each run's seed picks the enemies and seeds every fight, and
every round gives each side its own fresh dice stream. Two variants therefore roll the same dice until their stats
make a round go differently, and that difference doesn't carry into the next round's rolls. That keeps the streak
distribution unchanged (checked on 6,000 runs) and cuts the noise of a comparison by roughly half.

Swapping a test item into a slot takes that slot's exact share out of Profile › Combat's breakdown and adds
the new item's effects; plugins use the game's own `getEquippedPluginTotals`. `check-combat` checks this against
a real Kernel swap between two exports (every stat within the 4-decimal display rounding).

The simulator's enemies come from `src/enemy-model.json` (`npm run fit-enemies`): per zone and stat,
ln stat = type constant + b·x + q·x² + g·t + noise with x = ln(level / 800), a random type, and the roll t drawn
from its measured spread. The small x² term keeps the curve within ±1% over the recorded levels; past them it
goes on straight from its last slope (the panel says when a run gets there). A zone without enough recorded
fights isn't in the model and can't be simulated.

Not in the simulator yet (none of it was on the recording account): signatures, lifesteal, Quarantine Rules
lockups, Snapshot Rollback, homelab enemy reductions (the model has the enemies' base stats), gear automation,
level-ups during a streak.

## How affix values are built

Worked out from 807 exported items (iLvl 1 – 1,190,629, incl. marketplace); every shown value and range
boundary matches. The factors keep growing past iLvl 1000; only XP and Credits slow down, past iLvl 550,000.

```
shown value = raw roll × (1 + Compile bonus) × item-level factor
shown range = tier values × item-level factor              (no Compile)
  percentage stats:         factor = 0.3 + 0.7 × (iLvl / 1000)^½, rounded to 4 decimals (2 decimals of %)
    XP, Credits past 550k:  factor = f₀ + 2.1 × ln(1 + (factor − f₀) / 2.1),  f₀ = the factor at iLvl 550,000
  Item Rarity / Drop Boost: factor = 0.3 + 0.7 × (iLvl / 1000)^¼, rounded to 4 decimals
  flat stats:               factor = 0.2 + 0.8 × iLvl / 1000,     rounded up (float noise included)
```

- A **tier value** is the affix's number at iLvl 1000 (all factors are 1.0 there). Tier tables are
  4-decimal numbers for percentages and whole numbers for single-stat flat suffixes; the flat half of a
  two-stat suffix is 0.6, 0.65 or 0.7 × the single-stat table (a 0.05 grid). Tiers are contiguous: a tier's
  minimum is the next-worse tier's maximum. T1 is best, T9 worst. T0 (`tier_zero`) is rare and spans
  T1's range × 1.1, so it overlaps T1; the script doesn't predict it.
- The **raw roll** is a random value inside the tier; Refactor rerolls it within the tier, each stat
  independently. The game stores it as `base_value` = raw roll × (1 + `effective_compiled_bonus_pct`), which
  is why compiled items can show values above the displayed range.
- **Combat prefixes** (`<Credits|XP|Resources> & <combat stat>`) all use the multiples 1, 1.5, 2, 3, 4, 5,
  6.5, 8, 10, 12 (T9 min … T1 max) of a per-stat unit: Credits 2%, Gathering XP 2.8%, Hack XP 1.9%,
  Gathering Resources 3.3%, combat stats 0.5%, Global XP = Hack XP × 0.75 (each rounded to 4 decimals).
- Other affixes have their own tables (e.g. single-stat % suffixes 2, 4, 6, 8, 10, 13, 16, 19, 22, 25%;
  Item Rarity 2, 3, 4, 6, 8, 11, 14, 18, 22, 28%; Regeneration 2, 4, 6, 9, 13, 18, 25, 35, 50, 70). The ones pinned
  down by the exports ship in `src/tier-seed.json`; the script narrows the rest from every item it sees
  (equipment, inventory, marketplace pages, drops) and keeps that in localStorage (`ihInfoDisplay.tiers.v3`).
  Learned data can narrow a seed boundary but never overrule it.
