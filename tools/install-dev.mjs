// One-time setup: installs the dev loader into Tampermonkey in Brave.
//
// Builds, serves dev/infodisplay.dev.user.js on 127.0.0.1 and opens it in Brave;
// Tampermonkey intercepts *.user.js URLs and shows its install page, where one click
// on "Install" finishes the job. Re-run only when the build says the loader changed.
//
//   node tools/install-dev.mjs [--force]
//
// --force skips the "Allow access to file URLs" check (e.g. when using a non-default profile).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { build, paths } from './build.mjs';

const TAMPERMONKEY_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'; // Chrome Web Store build
const LOADER_PATH = '/infodisplay.dev.user.js';
const IDLE_EXIT_MS = 3 * 60_000;
const AFTER_SERVE_EXIT_MS = 30_000;

const local = process.env.LOCALAPPDATA || '';
const braveData = path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data');

function findBrave() {
  return [
    process.env.BRAVE_PATH,
    path.join(process.env.ProgramFiles || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ].find((p) => p && existsSync(p));
}

// Reads Brave's own record of the Tampermonkey toggles. Returns null when it can't tell.
function tampermonkeyFileAccess(profile = process.env.BRAVE_PROFILE || 'Default') {
  try {
    const prefs = JSON.parse(readFileSync(path.join(braveData, profile, 'Secure Preferences'), 'utf8'));
    const ext = prefs?.extensions?.settings?.[TAMPERMONKEY_ID];
    if (!ext) return { installed: false };
    return { installed: true, fileAccess: ext.newAllowFileAccess === true };
  } catch {
    return null;
  }
}

const force = process.argv.includes('--force');
const access = tampermonkeyFileAccess();
if (!force && access && !access.installed) {
  console.error('Tampermonkey is not installed in Brave\'s Default profile. Install it from the Chrome Web Store first');
  console.error('(or pass --force if you use a different profile / Tampermonkey build).');
  process.exit(1);
}
if (!force && access && !access.fileAccess) {
  console.error('Tampermonkey cannot read local files yet, so the dev loader would not find the script.');
  console.error('In Brave open  brave://extensions/?id=' + TAMPERMONKEY_ID + '  and turn on:');
  console.error('  - "Allow User Scripts"');
  console.error('  - "Allow access to file URLs"');
  console.error('then run this again (Brave saves the setting within a few seconds; --force skips this check).');
  process.exit(1);
}

let stamp;
try {
  ({ stamp } = build());
} catch (err) {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
}
console.log(`[${stamp}] built dev/`);

const loader = readFileSync(paths.loader);
let exitTimer;
const exitIn = (ms) => {
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    console.log('Install server stopped.');
    process.exit(0);
  }, ms);
};

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] !== LOADER_PATH) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(loader);
  console.log('Loader fetched by the browser. Click "Install" (or "Reinstall") in the Tampermonkey tab.');
  exitIn(AFTER_SERVE_EXIT_MS);
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}${LOADER_PATH}`;
  const brave = findBrave();
  if (brave) {
    spawn(brave, [url], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Opened ${url} in Brave.`);
  } else {
    console.log(`Brave not found (set BRAVE_PATH). Open this URL in the browser: ${url}`);
  }
  exitIn(IDLE_EXIT_MS);
});
