#!/usr/bin/env node
/*
 * node-pty ships N-API prebuilt binaries that are ABI-compatible with both Node and
 * Electron, so no native rebuild is required. However, the prebuild's `spawn-helper`
 * (used on POSIX) can lose its execute bit during npm extraction, which makes pty
 * spawning fail with "posix_spawnp failed". This script restores +x after install.
 */
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0); // no spawn-helper on Windows

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log('[postinstall] chmod +x ' + path.relative(process.cwd(), helper));
    }
  }
} catch (e) {
  // Non-fatal: dev install layouts vary; don't break `npm install`.
  console.warn('[postinstall] spawn-helper chmod skipped: ' + e.message);
}
