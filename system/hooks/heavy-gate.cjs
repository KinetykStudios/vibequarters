#!/usr/bin/env node
// The heavy-job gate's command line. The gate itself is guard-shell-hygiene.js beside this file:
// a heavy job claims the gate when it starts, and the claim ends when the job's process does.
//   node heavy-gate.cjs status    exit 0 when a heavy job could start now, 1 when not; says why
//   node heavy-gate.cjs release   removes every claim (for the user, when one is stuck)
// To wait for it, loop on `status` in a background call until it exits 0.
'use strict';
const lib = require('./shell-hygiene-lib.js');

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const cpu = await lib.cpuPercent();
    const [holder] = lib.holders();
    if (holder) {
      console.log(`busy: ${lib.describe(holder)} holds the gate; total CPU ${Math.round(cpu)}%`);
      process.exitCode = 1;
    } else if (cpu >= lib.START_MAX_CPU) {
      console.log(`busy: total CPU ${Math.round(cpu)}% (a heavy job starts only under ${lib.START_MAX_CPU}%)`);
      process.exitCode = 1;
    } else {
      console.log(`free: total CPU ${Math.round(cpu)}%, no heavy job holds the gate`);
    }
  } else if (cmd === 'release') {
    const gone = lib.forceRelease();
    for (const c of gone) lib.log(`release cli ${String(c.command || '').split('\n')[0].slice(0, 120)}`);
    console.log(gone.length ? `released: ${gone.map((c) => lib.describe(c)).join('; ')}` : 'nothing to release: the gate is free');
  } else {
    console.log('usage: node heavy-gate.cjs status | release');
    process.exitCode = 2;
  }
})();
