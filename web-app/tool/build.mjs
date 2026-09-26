// Builds the web-app into web-app/build/web.
//
//   node tool/build.mjs                       # uses mobile/dart_defines.json
//   node tool/build.mjs --defines ../mobile/dart_defines.testnet.json
//
// Steps: copy assets from mobile/, bundle the Dynamic sign-in bridge, then
// `flutter build web` with the SAME dart-defines file the phone builds use —
// so the web-app talks to the same API, Dynamic, Circle and Pusher.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webApp = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const defines = resolve(
  webApp,
  flag('--defines') ?? join('..', 'mobile', 'dart_defines.json'),
);
// Override with EVABOB_FLUTTER=/path/to/flutter when it is not on PATH.
const flutter = process.env.EVABOB_FLUTTER ?? 'flutter';

function run(cmd, cmdArgs, cwd = webApp) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`);
  // flutter and npm are .bat/.cmd shims on Windows, which only run through
  // a shell; node itself is not one (and its path may contain spaces).
  const shell = process.platform === 'win32' && cmd !== process.execPath;
  const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const res = shell
    ? spawnSync([cmd, ...cmdArgs].map(quote).join(' '), {
        cwd,
        stdio: 'inherit',
        shell: true,
      })
    : spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (!existsSync(defines)) {
  console.error(`No dart-defines file at ${defines}`);
  process.exit(1);
}

run(process.execPath, [join('tool', 'sync_assets.mjs')]);

const bridge = join(webApp, 'bridge');
run('npm', ['ci', '--no-audit', '--no-fund'], bridge);
run('npm', ['run', 'build'], bridge);

// Start from the phones' lockfile, so the browser runs the exact package
// versions Android and iOS do.
copyFileSync(
  join(webApp, '..', 'mobile', 'pubspec.lock'),
  join(webApp, 'pubspec.lock'),
);
run(flutter, ['pub', 'get']);
run(flutter, [
  'build',
  'web',
  '--release',
  `--dart-define-from-file=${defines}`,
  '--no-wasm-dry-run',
]);
console.log('\nBuilt web-app/build/web');
