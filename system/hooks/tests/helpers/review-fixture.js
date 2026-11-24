// Fixture helpers shared by review-proof.test.js and guard-deny-catastrophic.test.js: a fake home holding reviewer
// subagent transcripts under .claude/projects/<key>/<sid>/subagents and verdict files under .claude/coordination/reviews.
'use strict';
const fs = require('fs');
const path = require('path');
const { reviewPrompt, reviewFile } = require('../../review-proof.js');

const REPO = 'app';
const PR = 42;
const SID = '33333333-4444-4555-8666-777777777777';
const AGENT = 'a1111111111111111';
const CLEAN = 'VERDICT: CLEAN - 0 Critical, 0 Important, 3 Minor';
// The reviewer's whole last message, which writeVerdict writes below line 1 of the verdict file.
const REPORT = `Findings: 3 Minor (naming, a comment, a test name).\n${CLEAN}`;

const TASK_NOTE = {
  type: 'user', isSidechain: true, isMeta: true, origin: { kind: 'task-notification', producer: 'session-task' },
  message: { role: 'user', content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>completed</task-notification>' },
};

const reviewsOf = (home) => path.join(home, '.claude', 'coordination', 'reviews');

// One reviewer subagent: meta and transcript under projects/<key>/<sid>/subagents. picked null drops pickedEffortModel;
// ranOn is the model on its assistant lines; handback ends it on a SubagentHandback call holding lastText; steer is a
// user line injected after its first tool result.
function writeReviewer(home, {
  key = 'C--Users-dev-wt-x', sid = SID, agent = AGENT, prompt, lastText = REPORT, agentType = 'general-purpose',
  model = 'opus', picked = 'claude-opus-5-5', finished = true, ranOn = 'claude-opus-5-5', handback = false, steer,
}) {
  const sub = path.join(home, '.claude', 'projects', key, sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const meta = {
    agentType, isBuiltIn: true, description: 'review', toolUseId: 'toolu_1', spawnDepth: 1,
    requestShape: 'background', requestNonInteractive: true, model, pickedEffortModel: picked, finished,
  };
  if (picked === null) delete meta.pickedEffortModel;
  fs.writeFileSync(path.join(sub, `agent-${agent}.meta.json`), JSON.stringify(meta));
  const final = lastText;
  const lines = [
    { type: 'user', isSidechain: true, message: { role: 'user', content: prompt } },
    { type: 'attachment', attachment: { type: 'x' } },
    { type: 'user', isSidechain: true, isMeta: true, message: { role: 'user', content: '<system-reminder>PR #999 head e0c1a2b3c</system-reminder>' } },
    { type: 'assistant', message: { model: ranOn, content: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'VERDICT: NOT CLEAN PR #999' }] } },
    TASK_NOTE,
    ...(steer ? [steer] : []),
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: overloaded' }] } },
  ];
  if (handback) {
    // Such a reviewer ends on a SubagentHandback call; the text before it is a progress note.
    lines.push({ type: 'assistant', message: { model: ranOn, content: [{ type: 'text', text: 'Now the tests.' }] } });
    lines.push({ type: 'assistant', message: { model: ranOn, content: [{ type: 'tool_use', id: 't3', name: 'SubagentHandback', input: { message: final } }] } });
    lines.push({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'delivered' }] } });
  } else {
    lines.push({ type: 'assistant', message: { model: ranOn, content: [{ type: 'text', text: final }] } });
    // A trailing assistant line with no text block: the last TEXT is still the one above.
    lines.push({ type: 'assistant', message: { model: ranOn, content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } });
  }
  fs.writeFileSync(path.join(sub, `agent-${agent}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// One verdict file, as the tab writes it: line 1, then the reviewer's last message (verdict) below it.
function writeReview(home, { repo = REPO, pr = PR, head, agent, sid, deltaOver, verdict = REPORT, line1, eol = '\n' }) {
  fs.mkdirSync(reviewsOf(home), { recursive: true });
  const first = line1 || `PR #${pr} head ${head}, agent ${agent}, session ${sid}${deltaOver ? `, delta over ${deltaOver}` : ''}, opus subagent`;
  fs.writeFileSync(path.join(reviewsOf(home), `${repo}-${pr}-${head}.txt`), `${first}\n${verdict}\n`.replace(/\n/g, eol));
}

// A clean full review of repo PR #pr at head against base, proven by a reviewer subagent of session sid.
function writeCleanReview(home, { repo = REPO, pr = PR, head, sid = SID, agent = AGENT, base = 'origin/main' }) {
  writeReview(home, { repo, pr, head, agent, sid });
  writeReviewer(home, { sid, agent, prompt: reviewPrompt({ repo, pr, head, base }) });
  return reviewFile(home, repo, pr, head);
}

module.exports = { REPO, PR, SID, AGENT, CLEAN, REPORT, TASK_NOTE, reviewsOf, writeReviewer, writeReview, writeCleanReview };
