#!/usr/bin/env node
// Vercel "Ignored Build Step" for repos that land PRs in tested batches (mergeGate.batchRepos, merge-batch.js).
// Copy this file into your repo (for example scripts/vercel-ignore-build.mjs) and point vercel.json at it:
//
//   { "ignoreCommand": "node scripts/vercel-ignore-build.mjs" }
//
// Every member of a batch but the last carries [batch-part] on line 3 of its commit message (the first body line), so
// only the last one builds production. Exit 0 skips the build, exit 1 runs it. Anything unexpected runs the build.
// The rule is the same as isBatchPart in merge-batch.js; keep the two equal.
import { execFileSync } from 'node:child_process';

function commitMessage() {
  if (process.env.VERCEL_GIT_COMMIT_MESSAGE) return process.env.VERCEL_GIT_COMMIT_MESSAGE;
  try { return execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }); } catch { return ''; }
}

const third = String(commitMessage()).split('\n')[2];
const isBatchPart = third !== undefined && third.replace(/\r$/, '') === '[batch-part]';
const production = !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'production';
process.exit(isBatchPart && production ? 0 : 1);
