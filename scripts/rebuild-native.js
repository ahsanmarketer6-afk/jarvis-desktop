'use strict';
/**
 * Ensures better-sqlite3 uses the prebuilt binary matching the Electron ABI.
 * Runs on every `npm install` (postinstall) and in CI explicitly.
 * Avoids node-gyp entirely — prebuilds come from better-sqlite3 releases.
 */
const { execSync } = require('child_process');
const path = require('path');

const electronVersion = require('electron/package.json').version;
const modDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');

console.log('[jarvis-rebuild] fetching better-sqlite3 prebuilt for Electron', electronVersion);
try {
  execSync(
    'npx prebuild-install -r electron -t ' + electronVersion + ' --verbose',
    { cwd: modDir, stdio: 'inherit' }
  );
  console.log('[jarvis-rebuild] OK — prebuilt binary installed');
} catch (e) {
  console.warn('[jarvis-rebuild] prebuilt missing, falling back to node-gyp build...');
  execSync('npx node-gyp rebuild', { cwd: modDir, stdio: 'inherit' });
}
