// Builds the userscript from src/infodisplay.user.js.
//
//   node tools/build.mjs             dev build, once
//   node tools/build.mjs --watch     dev build on every save in src/
//   node tools/build.mjs --release   release build into dist/ (the files users install)
//
// Dev outputs (git-ignored):
//   dev/infodisplay.user.js       the script, stamped with the build time
//   dev/infodisplay.dev.user.js   a code-less Tampermonkey loader that @requires the file above
//                                 from disk, so a rebuild + tab reload is all it takes to test.
// Release outputs (committed; @updateURL / @downloadURL point at them on GitHub):
//   dist/infodisplay.user.js      the script, stamped with its @version
//   dist/infodisplay.meta.js      its header only, which is all Tampermonkey fetches to check for updates
//
// Nothing is written unless the source compiles, so a half-typed save never reaches the game.
// A release also refuses to build unless @version is above the last committed release.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  src: path.join(root, 'src', 'infodisplay.user.js'),
  seed: path.join(root, 'src', 'tier-seed.json'),
  enemies: path.join(root, 'src', 'enemy-model.json'),
  dev: path.join(root, 'dev', 'infodisplay.user.js'),
  loader: path.join(root, 'dev', 'infodisplay.dev.user.js'),
  release: path.join(root, 'dist', 'infodisplay.user.js'),
  meta: path.join(root, 'dist', 'infodisplay.meta.js'),
};

// Tampermonkey ignores the header of an @require'd file, so every key that affects
// where or how the script runs has to be copied onto the loader.
const LOADER_KEYS = new Set([
  'namespace', 'match', 'include', 'exclude', 'exclude-match', 'grant', 'run-at', 'noframes',
  'connect', 'require', 'resource', 'sandbox', 'inject-into', 'icon',
]);

const HEADER = /^\/\/ ==UserScript==\r?\n[\s\S]*?^\/\/ ==\/UserScript==/m;

function parseHeader(source) {
  const block = HEADER.exec(source);
  if (!block) throw new Error('missing "// ==UserScript==" header');
  return block[0]
    .split(/\r?\n/)
    .map((line) => /^\/\/\s*@(\S+)(?:\s+(.*))?$/.exec(line.trim()))
    .filter(Boolean)
    .map(([, key, value = '']) => ({ key, value: value.trim() }));
}

const headerValue = (meta, key) => (meta.find((m) => m.key === key) || {}).value;

function renderLoader(meta) {
  const line = (key, value = '') => `// @${key.padEnd(12)} ${value}`.trimEnd();
  return [
    '// ==UserScript==',
    line('name', `${headerValue(meta, 'name')} [dev]`),
    line('version', '0.0.0-dev'),
    line('description', 'Dev loader: runs dev/infodisplay.user.js straight from disk. Rebuild, then reload the game tab.'),
    line('downloadURL', 'none'),
    ...meta.filter((m) => LOADER_KEYS.has(m.key)).map((m) => line(m.key, m.value)),
    line('require', pathToFileURL(paths.dev).href),
    '// ==/UserScript==',
    '',
    '// Intentionally empty: all code comes from the @require above.',
    '',
  ].join('\n');
}

// The inlined tables stay readable, since Greasy Fork rejects minified code: a value goes on one
// line when it is short or a plain list, otherwise one entry per line.
function readableJson(value, indent) {
  const flat = JSON.stringify(value);
  const isList = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object');
  if (value === null || typeof value !== 'object' || isList || flat.length <= 100) return flat;
  const inner = `${indent}  `;
  const entries = Array.isArray(value)
    ? value.map((v) => inner + readableJson(v, inner))
    : Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${readableJson(v, inner)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${entries.join(',\n')}\n${indent}${close}`;
}

// Puts a JSON table in place of its `/*NAME*/ {}` marker (the source keeps an empty {} so it still runs).
function inline(source, marker, file) {
  if (!existsSync(file)) return source;
  const table = readableJson(JSON.parse(readFileSync(file, 'utf8')), '  ');
  return source.replace(new RegExp(`/\\*${marker}\\*/\\s*\\{\\}`), () => `/*${marker}*/ ${table}`);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Compiles the source and returns it built: stamped, with the tables inlined.
function compile(stamp) {
  const source = readFileSync(paths.src, 'utf8');
  const meta = parseHeader(source);
  for (const key of ['name', 'version']) if (!headerValue(meta, key)) throw new Error(`header has no @${key}`);
  if (!meta.some((m) => m.key === 'match' || m.key === 'include')) throw new Error('header has no @match');

  try {
    new vm.Script(source, { filename: paths.src }); // compile only, as a classic script
  } catch (err) {
    const where = /:(\d+)\r?\n/.exec(err.stack)?.[1];
    throw new Error(`${err.name}: ${err.message}${where ? ` (line ${where})` : ''}`);
  }

  let built = source.replaceAll('__BUILD__', stamp(meta));
  built = inline(built, 'TIER_SEED', paths.seed); // made by tools/make-seed.mjs
  built = inline(built, 'ENEMY_MODEL', paths.enemies); // made by tools/fit-enemies.mjs
  return { meta, built };
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Dev build. Returns { stamp, loaderChanged } or throws with a readable message. */
export function build() {
  const stamp = timestamp();
  const { meta, built } = compile(() => `dev ${stamp}`);
  write(paths.dev, built);

  const loader = renderLoader(meta);
  const previous = existsSync(paths.loader) ? readFileSync(paths.loader, 'utf8') : null;
  if (previous !== loader) write(paths.loader, loader);
  return { stamp, loaderChanged: previous !== null && previous !== loader };
}

// 1 if version a is higher than b, -1 if lower, 0 if equal (dot-separated numbers).
function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

// The last release that went out: dist/ as last committed, or as on disk outside a git repo.
// A release built but not committed yet can be rebuilt under the same version.
function lastRelease() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git('rev-parse', '--is-inside-work-tree');
  } catch {
    return existsSync(paths.release) ? readFileSync(paths.release, 'utf8') : null; // no git: dist/ on disk
  }
  try {
    return git('show', `HEAD:${path.relative(root, paths.release).replaceAll('\\', '/')}`);
  } catch {
    return null; // no release committed yet
  }
}

/** Release build into dist/. Returns { version, changed } or throws. */
export function release() {
  const { meta, built } = compile((m) => headerValue(m, 'version'));
  const version = headerValue(meta, 'version');
  if (existsSync(paths.release) && readFileSync(paths.release, 'utf8') === built) return { version, changed: false };
  const previous = lastRelease();
  const released = previous && headerValue(parseHeader(previous), 'version');
  if (released && compareVersions(version, released) <= 0) {
    throw new Error(`@version is ${version} but ${released} is already released: raise @version in the src header, ` +
      'or installed copies will not see the update');
  }
  write(paths.release, built);
  write(paths.meta, `${HEADER.exec(built)[0]}\n`);
  return { version, changed: true };
}

function buildAndReport() {
  try {
    const { stamp, loaderChanged } = build();
    console.log(`[${stamp}] built dev/infodisplay.user.js → reload the game tab`);
    if (loaderChanged) {
      console.log('  ! loader metadata changed (@match/@grant/...): run "npm run install-dev" and click Reinstall once');
    }
    return true;
  } catch (err) {
    console.error(`[${timestamp()}] BUILD FAILED, dev/ left unchanged: ${err.message}`);
    return false;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--release')) {
  try {
    const { version, changed } = release();
    if (!changed) {
      console.log(`dist/ already holds ${version}, nothing to release`);
    } else {
      console.log(`built dist/infodisplay.user.js and dist/infodisplay.meta.js (${version})`);
      console.log(`publish it:  git add -A && git commit -m "v${version}" && git tag v${version} && git push --follow-tags`);
    }
  } catch (err) {
    console.error(`RELEASE FAILED, dist/ left unchanged: ${err.message}`);
    process.exitCode = 1;
  }
} else if (isMain) {
  const ok = buildAndReport();
  if (process.argv.includes('--watch')) {
    let timer;
    watch(path.dirname(paths.src), (_event, file) => {
      if (file && !/\.(js|json)$/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(buildAndReport, 150); // editors often fire several events per save
    });
    console.log('watching src/ (Ctrl+C to stop)');
  } else if (!ok) {
    process.exitCode = 1;
  }
}
