// Copies the app's assets from mobile/ into web-app/assets.
//
// mobile/assets stays the one source: logos, icons, sounds, the Numans font
// and the checksum-verified Circle PIN document. Run before every web build
// (tool/build.mjs does). web-app/assets is generated and git-ignored.
//
// Also writes web/circle/challenge.html: the Circle PIN document the phones
// build in their WebView (challenge.html + the bundled Circle SDK, checked
// against its sha256), served from the web-app's own origin. It has to be a
// real page there: Circle's PIN iframe replies to its parent's origin, which
// an inline (srcdoc) frame does not have.
//
// Fails if web-app/pubspec.yaml no longer lists the same assets and fonts as
// mobile/pubspec.yaml, so an asset added to the phones is never silently
// missing from the browser.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webApp = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(webApp, '..', 'mobile');

/** Asset and font paths from a pubspec's `flutter:` section. */
function declaredPaths(pubspecPath) {
  const text = readFileSync(pubspecPath, 'utf8').replace(/\r\n/g, '\n');
  const start = text.search(/^flutter:\s*$/m);
  if (start < 0) throw new Error(`No flutter: section in ${pubspecPath}`);
  const section = text.slice(start);
  const paths = [];
  for (const line of section.split('\n')) {
    const clean = line.replace(/#.*$/, '');
    const asset = clean.match(/^\s+-\s+(assets\/\S+)\s*$/);
    const font = clean.match(/^\s+-?\s*asset:\s+(assets\/\S+)\s*$/);
    const hit = asset?.[1] ?? font?.[1];
    if (hit) paths.push(hit);
  }
  return paths;
}

const mobilePaths = declaredPaths(join(mobile, 'pubspec.yaml'));
const webPaths = declaredPaths(join(webApp, 'pubspec.yaml'));
const missing = mobilePaths.filter((p) => !webPaths.includes(p));
const extra = webPaths.filter((p) => !mobilePaths.includes(p));
if (missing.length || extra.length) {
  console.error('web-app/pubspec.yaml assets differ from mobile/pubspec.yaml.');
  if (missing.length) console.error('  Add to web-app:', missing.join(', '));
  if (extra.length) console.error('  Remove from web-app:', extra.join(', '));
  process.exit(1);
}

const target = join(webApp, 'assets');
rmSync(target, { recursive: true, force: true });
for (const rel of mobilePaths) {
  const from = join(mobile, rel);
  if (!existsSync(from)) {
    console.error(`Missing in mobile: ${rel}`);
    process.exit(1);
  }
  const to = join(webApp, rel);
  cpSync(from, to, { recursive: statSync(from).isDirectory() });
}
console.log(`Synced ${mobilePaths.length} asset entries from mobile/assets.`);

// ── Circle PIN document ──────────────────────────────────────────────────
const html = readFileSync(join(mobile, 'assets', 'challenge.html'), 'utf8');
const sdk = readFileSync(join(mobile, 'assets', 'circle_w3s_sdk.js'), 'utf8');
const expected = readFileSync(
  join(mobile, 'assets', 'circle_w3s_sdk.js.sha256'),
  'utf8',
)
  .trim()
  .split(/\s+/)[0];
const actual = createHash('sha256').update(sdk, 'utf8').digest('hex');
const marker = '/*__CIRCLE_SDK_BUNDLE__*/';
if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
  console.error('Bundled Circle SDK integrity check failed');
  process.exit(1);
}
if (!html.includes(marker) || sdk.includes('</script')) {
  console.error('Bundled Circle SDK document is invalid');
  process.exit(1);
}
// Stands in for the WebView's EvabobBridge channel: messages go to the app
// page (same origin), which also starts the challenge through __evabobStart.
// Carries the document's CSP nonce.
const shim =
  '<script nonce="evabob-circle-v1">' +
  'window.EvabobBridge={postMessage:function(m){try{' +
  'window.parent.evabobChallengeBridge(String(m));}catch(_){}}};' +
  'window.__evabobStart=function(j){' +
  'window.startEvabobChallenge(JSON.parse(j));};' +
  '</script>';
const page = html
  .replace(marker, () => sdk)
  .replace('</head>', () => `${shim}</head>`);
mkdirSync(join(webApp, 'web', 'circle'), { recursive: true });
writeFileSync(join(webApp, 'web', 'circle', 'challenge.html'), page);
console.log('Wrote web/circle/challenge.html (Circle SDK checksum verified).');
