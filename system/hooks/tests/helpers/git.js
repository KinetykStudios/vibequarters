// execFileSync('git', ...) for test setup. A local push, fetch or clone starts a shell, and on a busy Windows machine Git's
// bash sometimes fails to fork ("Could not read from remote repository"); those are tried again, every other failure throws.
'use strict';
const { execFileSync } = require('child_process');

const REMOTE = /^(push|fetch|clone|pull|ls-remote)$/;
const FORK_FAILED = /Could not read from remote|cygheap|Resource temporarily unavailable|hung up unexpectedly|early EOF/;

function execGit(args, opts) {
  const verb = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-C' && args[i - 1] !== '-c');
  for (let tries = 5; ; tries--) {
    try {
      return execFileSync('git', args, opts);
    } catch (e) {
      if (tries <= 1 || !REMOTE.test(verb) || !FORK_FAILED.test(`${e.stderr || ''}${e.message}`)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}
module.exports = { execGit };
