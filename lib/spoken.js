// The part of a reply worth saying out loud: the text panel carries the detail, so the voice gets the first three plain
// sentences and never a path, an id, code, a table, the Status line or the Next steps block.
const MAX_SENTENCES = 3;
const MAX_CHARS = 400;
const NEXT_STEPS = /^\s*\*\*Next steps\*\*/m;
const FENCE = /```[\s\S]*?(?:```|$)/g; // an unclosed fence runs to the end
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi; // a digit is required, so a word like "defaced" stays
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+/;

// A word with a slash reads as a path when it is rooted (a drive, ~, a dot, a slash), has two slashes (a URL too) or
// ends in a file extension; "and/or" is none of these.
function isPath(w) {
  if (!/[\\/]/.test(w)) return false;
  return /^(?:[A-Za-z]:|~|\.|[\\/])/.test(w) || /[\\/].*[\\/]/.test(w) || /\.[A-Za-z0-9]{1,5}$/.test(w);
}
function dropPaths(line) {
  return line.replace(/\S+/g, (w) => {
    const [, lead, core, tail] = w.match(/^([("']*)(.*?)([.,;:!?)"']*)$/);
    return isPath(core) ? lead + tail : w;
  });
}

function dropOpener(text, openers) {
  const t = text.trimStart();
  for (const o of openers) {
    if (!o || t.slice(0, o.length).toLowerCase() !== o.toLowerCase() || /[A-Za-z0-9]/.test(t.charAt(o.length))) continue;
    return t.slice(o.length).replace(/^[\s,.:;!]+/, "");
  }
  return t;
}

function cleanLine(line) {
  let s = line.replace(HEADING, "").replace(LIST_MARK, "");
  s = s.replace(/`[^`\n]*`/g, "").replace(/`/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = dropPaths(s).replace(HEX_ID, "").replace(/\*/g, "");
  s = s.replace(/\(\s*\)/g, "").replace(/\s+/g, " ").replace(/ ([,.;:!?])/g, "$1").trim();
  return s && !/[.!?:;,]$/.test(s) ? s + "." : s; // a list item or a heading ends its own sentence
}

function spokenOf(text, { openers = [] } = {}) {
  let t = dropOpener(String(text || "").replace(/\r\n?/g, "\n"), openers);
  const cut = t.search(NEXT_STEPS);
  if (cut !== -1) t = t.slice(0, cut);
  t = t.replace(FENCE, "\n");
  const lines = t
    .split("\n")
    .filter((l) => !/^\s*Status:/.test(l) && !/^\s*\|/.test(l))
    .map(cleanLine)
    .filter(Boolean);
  const said = lines.join(" ").split(/(?<=[.!?])\s+/).slice(0, MAX_SENTENCES).join(" ");
  const chars = [...said];
  if (chars.length <= MAX_CHARS) return said;
  const head = chars.slice(0, MAX_CHARS + 1).join("");
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : chars.slice(0, MAX_CHARS).join("")).trimEnd();
}

module.exports = { spokenOf };
