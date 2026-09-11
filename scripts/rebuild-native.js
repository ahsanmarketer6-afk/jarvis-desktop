'use strict';
/**
 * Ensures better-sqlite3 uses the prebuilt binary matching the Electron ABI.
 * Runs on `npm install` (postinstall) and explicitly in CI workflows.
 * Defensive against missing electron, handles dev dependencies, and catches all errors cleanly.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const nodeModulesDir = path.join(rootDir, 'node_modules');
const electronDir = path.join(nodeModulesDir, 'electron');
const electronPkgPath = path.join(electronDir, 'package.json');
const betterSqliteDir = path.join(nodeModulesDir, 'better-sqlite3');

function run() {
  console.log('[jarvis-rebuild] Checking environment and native dependencies...');

  // 1. Check if node_modules/electron exists — if not, run npm install (with dev dependencies)
  if (!fs.existsSync(electronPkgPath)) {
    console.warn('[jarvis-rebuild] Electron package not found at:', electronPkgPath);

    // If running inside npm postinstall hook, don't spawn a recursive npm install
    if (process.env.npm_lifecycle_event === 'postinstall') {
      console.log('[jarvis-rebuild] npm postinstall hook detected; skipping rebuild until full install step runs.');
      return;
    }

    console.log('[jarvis-rebuild] Running npm install (with dev dependencies) before proceeding...');
    try {
      execSync('npm install --include=dev', { cwd: rootDir, stdio: 'inherit' });
    } catch (err) {
      console.error('[jarvis-rebuild] ========================================================');
      console.error('[jarvis-rebuild] ERROR: Failed to run npm install to fetch dev dependencies.');
      console.error('[jarvis-rebuild] Reason:', err.message || err);
      console.error('[jarvis-rebuild] ========================================================');
      process.exit(1);
    }
  }

  // 2. Read the electron version from node_modules/electron/package.json safely
  let electronVersion = null;
  if (fs.existsSync(electronPkgPath)) {
    try {
      const pkgContent = fs.readFileSync(electronPkgPath, 'utf8');
      const pkgJson = JSON.parse(pkgContent);
      electronVersion = pkgJson.version;
    } catch (err) {
      console.error('[jarvis-rebuild] ========================================================');
      console.error('[jarvis-rebuild] ERROR: Could not parse node_modules/electron/package.json.');
      console.error('[jarvis-rebuild] Reason:', err.message || err);
      console.error('[jarvis-rebuild] ========================================================');
      process.exit(1);
    }
  }

  if (!electronVersion) {
    console.error('[jarvis-rebuild] ========================================================');
    console.error('[jarvis-rebuild] ERROR: Electron is not installed or version could not be determined.');
    console.error('[jarvis-rebuild] Path checked:', electronPkgPath);
    console.error('[jarvis-rebuild] Ensure "electron" is listed in devDependencies and npm install was run.');
    console.error('[jarvis-rebuild] ========================================================');
    process.exit(1);
  }

  console.log(`[jarvis-rebuild] Detected Electron version: ${electronVersion}`);

  // 3. Check if better-sqlite3 exists in node_modules
  if (!fs.existsSync(betterSqliteDir)) {
    console.log('[jarvis-rebuild] better-sqlite3 not present in node_modules; skipping native rebuild.');
    return;
  }

  // 4. Rebuild better-sqlite3 against that Electron version with fallback and clear error reporting
  console.log(`[jarvis-rebuild] Rebuilding better-sqlite3 for Electron v${electronVersion}...`);

  let rebuildSuccess = false;

  // Approach A: prebuild-install (fast, downloads official prebuilt without requiring local C++ build toolchain)
  try {
    console.log('[jarvis-rebuild] Attempting prebuild-install...');
    execSync(
      `npx --no-install prebuild-install -r electron -t ${electronVersion} --verbose`,
      { cwd: betterSqliteDir, stdio: 'inherit' }
    );
    rebuildSuccess = true;
    console.log('[jarvis-rebuild] OK — prebuilt binary installed successfully.');
  } catch (err) {
    console.warn('[jarvis-rebuild] prebuild-install fallback triggered:', err.message || err);
  }

  // Approach B: electron-builder install-app-deps
  if (!rebuildSuccess) {
    try {
      console.log('[jarvis-rebuild] Attempting electron-builder install-app-deps...');
      execSync('npx electron-builder install-app-deps', { cwd: rootDir, stdio: 'inherit' });
      rebuildSuccess = true;
      console.log('[jarvis-rebuild] OK — electron-builder install-app-deps succeeded.');
    } catch (err) {
      console.warn('[jarvis-rebuild] electron-builder install-app-deps failed:', err.message || err);
    }
  }

  // Approach C: node-gyp rebuild fallback
  if (!rebuildSuccess) {
    try {
      console.log('[jarvis-rebuild] Attempting node-gyp rebuild fallback...');
      execSync('npx node-gyp rebuild', { cwd: betterSqliteDir, stdio: 'inherit' });
      rebuildSuccess = true;
      console.log('[jarvis-rebuild] OK — node-gyp rebuild succeeded.');
    } catch (err) {
      console.warn('[jarvis-rebuild] node-gyp rebuild failed:', err.message || err);
    }
  }

  if (!rebuildSuccess) {
    console.error('[jarvis-rebuild] ========================================================');
    console.error(`[jarvis-rebuild] ERROR: Could not rebuild better-sqlite3 for Electron v${electronVersion}.`);
    console.error('[jarvis-rebuild] Native rebuild mechanisms (prebuild-install, install-app-deps, node-gyp) could not complete.');
    console.error('[jarvis-rebuild] ========================================================');
    process.exit(1);
  }

  console.log('[jarvis-rebuild] Native modules setup completed successfully.');
}

try {
  run();
} catch (fatalErr) {
  console.error('[jarvis-rebuild] ========================================================');
  console.error('[jarvis-rebuild] FATAL ERROR during native rebuild:');
  console.error('[jarvis-rebuild]', fatalErr.message || fatalErr);
  console.error('[jarvis-rebuild] ========================================================');
  process.exit(1);
}
