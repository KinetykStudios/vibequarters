// Read-only: measures closing replies in main-session transcripts from the last 7 days.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const root = path.join(os.homedir(), '.claude', 'projects');
const cutoff = Date.now() - 7 * 24 * 3600 * 1000;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}

function isRealUser(obj) {
  if (obj.type !== 'user' || obj.isSidechain || obj.isMeta) return false;
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') return !c.startsWith('<');
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  return t.length > 0 && !t.startsWith('<');
}

async function scan(file, replies) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let last = null;
  for await (const line of rl) {
    if (!line.includes('"type"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (isRealUser(obj)) {
      if (last) replies.push(last);
      last = null;
    } else if (obj.type === 'assistant' && !obj.isSidechain) {
      const t = textOf(obj.message && obj.message.content).trim();
      if (t) last = t;
    }
  }
  if (last) replies.push(last);
}

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

(async () => {
  const replies = [];
  let files = 0;
  let bytes = 0;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory() ) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) continue;
      files++;
      bytes += st.size;
      await scan(fp, replies);
    }
  }
  const words = replies.map((r) => r.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const steps = replies.filter((r) => /\*\*Next steps\*\*/.test(r));
  const stepWords = steps.map((r) => r.split(/\*\*Next steps\*\*/)[0].split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const doneWithSteps = steps.filter((r) => /nothing left|all done|you're done|done, nothing/i.test(r)).length;
  console.log(JSON.stringify({
    scope: 'main-session closing replies, every project folder, files modified in last 7 days',
    files,
    gb: +(bytes / 1e9).toFixed(2),
    replies: replies.length,
    words: { median: pct(words, 0.5), p90: pct(words, 0.9), max: words[words.length - 1] },
    over150words: words.filter((w) => w > 150).length,
    over300words: words.filter((w) => w > 300).length,
    withNextSteps: steps.length,
    bodyWordsBeforeNextSteps: { median: pct(stepWords, 0.5), p90: pct(stepWords, 0.9) },
    saysFinishedYetHasNextSteps: doneWithSteps,
  }, null, 1));
})();
