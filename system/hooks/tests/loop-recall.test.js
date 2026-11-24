// Tests for loop-recall.js.
// Run: node --test system/hooks/tests/loop-recall.test.js
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const R = require('../loop-recall.js');

const entry = (name, description, type, body) =>
  R.parseEntry(name + '.md',
    '---\nname: ' + name + '\ndescription: "' + description + '"\nmetadata: \n  node_type: memory\n  type: ' + type + '\n---\n' + body,
    999);

test('tokenize', async (t) => {
  await t.test('drops stopwords and short tokens', () => {
    assert.deepStrictEqual(R.tokenize('why is the release note order wrong'),
      ['release', 'note', 'order', 'wrong']);
  });
  await t.test('empty prompt yields no tokens', () => {
    assert.deepStrictEqual(R.tokenize(''), []);
  });
});

test('parseEntry', async (t) => {
  await t.test('reads name, description and nested metadata.type', () => {
    const e = entry('note-order', 'Release note order differs', 'feedback', 'body text');
    assert.strictEqual(e.name, 'note-order');
    assert.strictEqual(e.description, 'Release note order differs');
    assert.strictEqual(e.type, 'feedback');
    assert.strictEqual(e.body, 'body text');
  });
  await t.test('node_type does not leak into type', () => {
    assert.strictEqual(entry('x', 'y', 'project', 'b').type, 'project');
  });
  await t.test('a file with no frontmatter still scores on its filename', () => {
    const e = R.parseEntry('home-page.md', 'no frontmatter here', 999);
    assert.strictEqual(e.name, 'home-page');
    assert.strictEqual(e.description, '');
  });
});

test('scoreEntry', async (t) => {
  const score = (prompt, e) => {
    const tk = R.tokenize(prompt);
    return R.scoreEntry(tk, R.pairsOf(tk), e);
  };

  await t.test('a name-slug match outweighs a body-only match', () => {
    const named = entry('database-restore-steps', 'How to restore a database', 'feedback', 'x');
    const bodyOnly = entry('unrelated-page', 'Something else', 'project', 'database restore steps');
    assert.ok(score('database restore steps', named) >
              score('database restore steps', bodyOnly));
  });

  await t.test('the name slug alone decides when everything else is identical', () => {
    const hit = entry('image-resize-queue', 'shared text alpha beta', 'project', 'shared body');
    const miss = entry('unrelated-thing-here', 'shared text alpha beta', 'project', 'shared body');
    const h = score('image resize queue', hit);
    const m = score('image resize queue', miss);
    assert.ok(h > m, 'slug match must score higher, got ' + h + ' vs ' + m);
    assert.ok(h - m >= 9, 'slug weight must be worth 3 per token, got delta ' + (h - m));
  });

  await t.test('the same phrase outranks a shared word', () => {
    const right = entry('note-order', 'Release note order differs between two files', 'feedback', 'x');
    const wrong = entry('branch-names', 'Release branches need a green build', 'project', 'x');
    assert.ok(score('why is the release note order wrong', right) >
              score('why is the release note order wrong', wrong));
  });

  await t.test('word order alone decides when the token sets are identical', () => {
    const inOrder = entry('page-a', 'release note order handling', 'project', 'x');
    const scrambled = entry('page-b', 'order release note handling', 'project', 'x');
    const a = score('release note order', inOrder);
    const b = score('release note order', scrambled);
    assert.ok(a > b, 'phrase order must matter, got ' + a + ' vs ' + b);
  });

  await t.test('the description alone decides when name and body are equally blank', () => {
    // Pins the description weight. The prompt tokens are deliberately not adjacent in the
    // description, so the phrase bonus cannot cover for a missing weight.
    const hit = entry('page-a', 'image and the queue', 'project', 'x');
    const miss = entry('page-b', 'nothing relevant at all', 'project', 'x');
    const h = score('image queue', hit);
    const m = score('image queue', miss);
    assert.ok(h > m, 'description match must score, got ' + h + ' vs ' + m);
  });

  await t.test('the body breaks a tie when name and description are both blank', () => {
    // Pins the body weight. Capped at 5 and worth 1 per token, a body match
    // alone never clears SCORE_FLOOR, so its only real job is breaking ties
    // between pages that already matched on name or description. This test
    // isolates it: identical blank descriptions, non-matching names.
    const hit = entry('page-a', '', 'project', 'image resize queue notes');
    const miss = entry('page-b', '', 'project', 'nothing at all in here');
    const h = score('image resize queue', hit);
    const m = score('image resize queue', miss);
    assert.ok(h > m, 'body match must score, got ' + h + ' vs ' + m);
  });

  await t.test('feedback outranks project when base scores tie', () => {
    const fb = entry('same-words-here', 'alpha beta gamma', 'feedback', 'x');
    const pj = entry('same-words-here', 'alpha beta gamma', 'project', 'x');
    assert.ok(score('alpha beta gamma', fb) > score('alpha beta gamma', pj));
  });

  await t.test('an unrelated prompt scores below the floor', () => {
    const e = entry('database-restore-steps', 'How to restore a database', 'feedback', 'x');
    assert.ok(score('what is the weather in paris', e) < R.SCORE_FLOOR);
  });
});

test('density gate', async (t) => {
  await t.test('a short sharp query clears the gate', () => {
    assert.ok(R.density(22, 4) >= R.DENSITY_FLOOR);
  });
  await t.test('a long prompt does not dilute a real query below the gate', () => {
    assert.ok(R.density(16, 20) >= R.DENSITY_FLOOR,
      'the denominator must stop growing at DENSITY_SPAN or long queries get silenced');
  });
  await t.test('a rambling prompt with a mediocre top score falls below the gate', () => {
    assert.ok(R.density(11, 11) < R.DENSITY_FLOOR);
  });
});

const fs = require('fs');
const os = require('os');
const pathm = require('path');
const { spawnSync } = require('child_process');
const HOOK = pathm.join(__dirname, '..', 'loop-recall.js');

const ranked = (n, bodyLen) => Array.from({ length: n }, (_, i) => ({
  name: 'page-' + i,
  description: 'description for page ' + i,
  type: 'project',
  body: 'x'.repeat(bodyLen),
  ageDays: 999,
  score: 100 - i,
}));

test('render', async (t) => {
  await t.test('stays within budget', () => {
    assert.ok(R.render(ranked(40, 5000)).length <= R.BUDGET);
  });
  await t.test('places at most MAX_BODIES bodies', () => {
    const out = R.render(ranked(40, 200));
    assert.strictEqual((out.match(/^### page-/gm) || []).length, R.MAX_BODIES);
  });
  await t.test('names what it omitted instead of dropping it silently', () => {
    const out = R.render(ranked(40, 5000));
    assert.match(out, /Omitted by budget|further matches omitted/);
  });
  await t.test('truncates an oversized body visibly', () => {
    assert.match(R.render(ranked(1, 99999)), /truncated by recall budget/);
  });
  await t.test('escapes a comment opener so a page cannot close the fence', () => {
    const r = ranked(1, 10);
    r[0].body = 'before <!-- after';
    assert.ok(!R.render(r).includes('<!--'));
  });
});

// A private memory folder under its own home, so no test reads the memory of the machine it runs on.
function corpus() {
  const home = fs.mkdtempSync(pathm.join(os.tmpdir(), 'recall-corpus-'));
  const dir = pathm.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const page = (name, description, type, body) => fs.writeFileSync(pathm.join(dir, name + '.md'),
    '---\nname: ' + name + '\ndescription: "' + description + '"\nmetadata:\n  type: ' + type + '\n---\n' + body + '\n');
  page('database-restore-steps', 'How to restore a database snapshot to staging when the schema has changed', 'feedback', 'Restore steps: one snapshot file, then the checks. The schema changed, so never load it whole.');
  page('release-note-order', 'Release note order is read from two files, and one of them is wrong', 'project', 'The release note order on the page comes from the first file; the feed reads the other one.');
  page('branch-names', 'Branches need a green build', 'project', 'A branch is deleted after its merge.');
  page('icon-sizes', 'How the toolbar picks its icon sizes', 'project', 'Icons come in two sizes.');
  return home;
}
const CORPUS = corpus();
test.after(() => fs.rmSync(CORPUS, { recursive: true, force: true }));
const CENV = Object.assign({}, process.env, { USERPROFILE: CORPUS, HOME: CORPUS });

test('a background task notice recalls nothing', async (t) => {
  const run = (prompt) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt, cwd: CORPUS }), encoding: 'utf8', env: CENV,
  });
  await t.test('a task notice carrying matching words injects zero bytes', () => {
    const r = run('<task-notification>\n<task-id>b1</task-id>\n<summary>restore a database snapshot to staging</summary>\n</task-notification>');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });
  await t.test('positive control: the same words as a real prompt still recall', () => {
    assert.notStrictEqual(run('restore a database snapshot to staging').stdout.trim(), '');
  });
});

test('hook end to end', async (t) => {
  const run = (payload) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', env: CENV,
  });

  await t.test('always exits 0', () => {
    assert.strictEqual(run({ prompt: 'anything', cwd: CORPUS }).status, 0);
  });

  await t.test('negative control: an unrelated prompt injects zero bytes', () => {
    const r = run({ prompt: 'zzzq xqjv wkbq nonsense token', cwd: CORPUS });
    assert.strictEqual(r.stdout.trim(), '');
  });

  await t.test('an empty prompt injects zero bytes', () => {
    assert.strictEqual(run({ prompt: '', cwd: CORPUS }).stdout.trim(), '');
  });

  await t.test('malformed stdin still exits 0 with no output', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: CENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  await t.test('VIBEQUARTERS_GUARD=off silences it', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ prompt: 'database restore steps', cwd: CORPUS }),
      encoding: 'utf8',
      env: Object.assign({}, CENV, { VIBEQUARTERS_GUARD: 'off' }),
    });
    assert.strictEqual(r.stdout.trim(), '');
  });

  await t.test('real prompts surface the correct memory in the top 3', () => {
    const cases = [
      ['restore a database snapshot to staging', 'database-restore-steps'],
      ['why is the release note order wrong', 'release-note-order'],
    ];
    for (const [prompt, expected] of cases) {
      const r = run({ prompt, cwd: CORPUS });
      assert.notStrictEqual(r.stdout.trim(), '', 'expected a hit for: ' + prompt);
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      const names = (ctx.match(/^### ([a-z0-9-]+)$/gm) || []).map((s) => s.replace('### ', ''));
      const tier1 = (ctx.match(/^- `([a-z0-9-]+)`:/gm) || []).map((s) => s.replace(/^- `|`:$/g, ''));
      const top3 = names.concat(tier1).slice(0, 3);
      assert.ok(top3.includes(expected),
        'expected ' + expected + ' in top 3 for "' + prompt + '", got ' + JSON.stringify(top3));
    }
  });

  await t.test('a conversational prompt about the work itself injects nothing', () => {
    const r = run({
      prompt: 'is all of that finished? check the tests once more, read the notes, and tidy the draft before the review',
      cwd: CORPUS,
    });
    assert.strictEqual(r.stdout.trim(), '', 'a meta question must recall nothing');
  });

  await t.test('a long legitimate query still injects the right memory', () => {
    // The gate must not buy its precision by silencing real questions that run long.
    const r = run({
      prompt: 'i need to restore a database snapshot to staging but the schema has ' +
        'changed so what are the right restore steps here',
      cwd: CORPUS,
    });
    assert.notStrictEqual(r.stdout.trim(), '', 'a long real query must still recall');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /database-restore-steps/);
  });

  await t.test('emits a valid UserPromptSubmit envelope when it hits', () => {
    const r = run({ prompt: 'database restore steps staging', cwd: CORPUS });
    if (!r.stdout.trim()) return;
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(j.hookSpecificOutput.additionalContext.length > 0);
  });
});

test('the density gate reads the match, not the ranking bonus', () => {
  const home = fs.mkdtempSync(pathm.join(os.tmpdir(), 'recall-home-'));
  try {
    const dir = pathm.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pathm.join(dir, 'old-status-notes.md'),
      '---\nname: old-status-notes\n' +
      'description: A status copied once from an earlier check\n' +
      'metadata:\n  type: feedback\n---\n' +
      'Check every number again before the final review; an old count read from notes came out wrong.\n');
    const recall = (prompt) => spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ prompt, cwd: home }),
      encoding: 'utf8',
      env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }),
    }).stdout.trim();
    // Positive control: the corpus is live, so the silence below is the gate, not a dead fixture.
    assert.notStrictEqual(recall('old status notes copied from an earlier check'), '');
    assert.strictEqual(recall('is all of that finished? check the tests once more, read the notes, and tidy the draft before the review'), '',
      'a raw match of 12 over 8 tokens is conversation, whatever bonus the page carries');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
