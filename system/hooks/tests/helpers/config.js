// A private vibequarters.config.json for the hook tests, so a test never reads the settings of the machine it runs on.
// Requiring this file sets VIBEQUARTERS_CONFIG for this process and every hook it starts; VIBEQUARTERS_TEST_PLATFORM makes the
// Windows-only checks run on every system. write(over) lays more settings over the base ones and returns a config path.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibequarters-test-config-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* left for the system to clean */ } });

const BASE = {
  coordination: { fixerPrefix: 'fixer' },
  mergeGate: {
    requiredChecks: { 'acme/app': ['ci'] },
    batchRepos: ['acme/app'],
    requirePrDeclaration: true,
  },
  loop: { autoEvolve: true },
};

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isPlain(v) && isPlain(a[k]) ? merge(a[k], v) : v;
  return out;
};

let n = 0;
function write(over) {
  const f = path.join(DIR, `vibequarters.config.${n++}.json`);
  fs.writeFileSync(f, JSON.stringify(merge(BASE, over)));
  return f;
}

process.env.VIBEQUARTERS_CONFIG = write({});
if (!process.env.VIBEQUARTERS_TEST_PLATFORM) process.env.VIBEQUARTERS_TEST_PLATFORM = 'win32';

module.exports = { write, BASE };
