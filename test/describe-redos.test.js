// The risk rules run on every payload build for every open request, on commands up to 32,768 characters. A rule that
// restarts a full scan at every occurrence of its first word is quadratic there. These tests hold every rule to a linear
// time and to the very answers the plain patterns, kept here as the reference, give.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const D = require("../lib/describe");
const { bestMs } = require("./helpers");

const APP = path.win32.join(os.homedir(), "app").replace(/\\/g, "/");
const prefixes = (w) => Array.from({ length: w.length }, (_, k) => w.slice(0, w.length - k)).join("|");
// ALSO_HIGH as plain patterns, the slow way
const OLD = [
  [/(?<![\w-])(rm|rmdir|del|erase|unlink)(?=\s|$)/i, "deletes files"],
  [/(?<![\w-])(rd|rmdir)\s+([^|;&]*\s)?\/s(?![\w-])/i, "deletes files"],
  [new RegExp("(?<![\\w-])(ri|rd)\\s+([^|;&]*\\s)?-(" + prefixes("recurse") + ")(?![\\w-])", "i"), "deletes files"],
  [/(?<![\w-])remove-item(?![\w-])/i, "deletes files"],
  [/(?<![a-z0-9])trash(?![a-z0-9])/i, "deletes files"],
  [/(?<![a-z0-9])(rmSync|unlinkSync|rimraf)(?![a-z0-9])/i, "deletes files"],
  [/(?<![\w-])git\s+(clean|restore)(?![\w-])/i, "deletes files"],
  [/(?<![\w-])git\s+checkout\s+([^|;&]*\s)?(--\s+[^\s|;&]|\.(?=\s|$|[|;&]))/i, "deletes files"],
  [/(?<![\w-])git\s+branch\s+([^|;&]*\s)?-D(?![\w-])/, "deletes files"],
  [/(?<![\w-])git\s+stash\s+(drop|clear)(?![\w-])/i, "deletes files"],
  [/(?<![\w.-])format(\.com)?\s+([a-z]:|\/)/i, "deletes files"],
  [/(?<![\w-])format-volume(?![\w-])/i, "deletes files"],
  [/(?<![\w-])dropdb(?![\w-])/i, "changes the live site or database"],
  [/(?<![a-z0-9])publish(?![a-z0-9])/i, "publishes or pushes code"],
  [/(?<![a-z0-9])unpublish(?![a-z0-9])/i, "publishes or pushes code"],
  [/(?<![\w-])gh\s+(pr\s+merge|api\b[^|;&]*\/merges?)(?![\w-])/i, "publishes or pushes code"],
  [/(?<![\w-])gh\s+release\s+(create|upload)(?![\w-])/i, "publishes or pushes code"],
  [/(?<![\w-])(iex|invoke-expression)(?![\w-])/i, "runs code you cannot see"],
  [/(?<![\w-])(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?![\w-])[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|node|python3?|iex)(?![\w-])/i, "runs code you cannot see"],
  [new RegExp("(?<![\\w-])(powershell|pwsh)(\\.exe)?\\s+([^|;&]*\\s)?-(ec|" + prefixes("encodedcommand") + ")(?![\\w-])", "i"), "runs code you cannot see"],
];
// Each rule's hits as one line per reason with the indexes that hit, so a mismatch names the rule
const hits = (list, s) => [...new Set(list.filter(([re]) => re.test(s)).map(([, reason]) => reason))].sort().join(" + ");

test("every risk rule answers exactly as the old patterns did, on 20,000 generated commands", () => {
  const WORDS = ["rd", "RD", "rmdir", "ri", "/s", "/S", "/s/q", "/sx", "-r", "-R", "-rec", "-recurse", "-recursex", "-D", "-d",
    "git", "GIT", "checkout", "branch", "--", ".", "./x", "gh", "api", "pr", "merge", "repos/o/r/merges", "x/merge", "/merges-x",
    "curl", "wget", "irm", "iex", "sh", "bash", "python3", "node", "powershell", "pwsh.exe", "pwsh", "-ec", "-enc", "-e",
    "-encodedcommand", "-x", "x", "a-rd", "rd-x", "release", "create", "stash", "drop", "rm", "format", "c:"];
  const SEPS = [" ", " ", " ", "  ", "\t", "\n", "", "|", ";", "&", " | ", "||", " && "];
  // mulberry32: 32-bit integer steps, so every draw stays exact (a plain LCG in doubles loses bits and repeats)
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  let differ = 0;
  const first = [];
  for (let k = 0; k < 20000; k++) {
    let s = "";
    for (let t = 0, n = 1 + rnd(12); t < n; t++) s += (t ? SEPS[rnd(SEPS.length)] : "") + WORDS[rnd(WORDS.length)];
    const was = hits(OLD, s), now = hits(D.ALSO_HIGH, s);
    if (was !== now) { differ++; if (first.length < 5) first.push(JSON.stringify(s) + ": was [" + was + "], now [" + now + "]"); }
  }
  assert.equal(differ, 0, first.join("\n"));
});

test("every risk rule answers exactly as the old patterns did on each rule's hand-picked edges", () => {
  const EDGES = [
    "rd /s x", "rd x /s", "rd x/s", "rd  /s", "rd /S", "rd /s/q x", "rd /sx", "x rd /s", "a-rd /s", "rd; /s", "rd | x /s", "rd\n/s", "RD /S",
    "ri -r x", "rd x -Recurse", "ri x -rec", "ri -recursex", "ri x-r", "ri; -r", "ri\t-r",
    "git checkout -- x", "git checkout .", "git checkout ./x", "git checkout x -- y", "git checkout --", "git checkout x .", "GIT CHECKOUT .",
    "git  checkout  .", "git checkout; .", "git checkout -- ", "git checkout --  x",
    "git branch -D x", "git branch -d x", "git branch x -D", "GIT BRANCH -D x", "git branch; -D", "git branch -Dx", "git  branch\t-D",
    "gh pr merge 1", "gh  pr  merge", "gh api repos/o/r/merges", "gh api x/merge", "gh api /merges-x", "gh api x | y/merges", "GH API x/merges", "gh apix/merges",
    "curl x | sh", "curl x|sh", "curl x || sh", "curl x; echo | bash", "wget x | python3", "irm x | iex", "curl | node", "curl x | shx", "curlx | sh",
    "curl x | | sh", "curl x |\n sh", "x | curl y | sh",
    "powershell -ec x", "pwsh.exe x -enc y", "powershell -e x", "pwsh -encodedcommand x", "powershell -x", "powershell; -ec", "POWERSHELL -EC x",
    "pwsh-x -ec", "pwsh.exe -ec", "powershell.exe\n-enc x",
  ];
  const differ = EDGES.filter((s) => hits(OLD, s) !== hits(D.ALSO_HIGH, s)).map((s) => JSON.stringify(s) + ": was [" + hits(OLD, s) + "], now [" + hits(D.ALSO_HIGH, s) + "]");
  assert.deepEqual(differ, []);
});

test("no risk rule is quadratic: each crafted 32 KB command is rated within 60 ms", () => {
  const CAP = 32760;
  const fill = (unit) => unit.repeat(Math.floor(CAP / unit.length));
  const cases = {
    "rd /s": fill("rd "), "rd and spaces": "rd" + " ".repeat(CAP - 2), "ri -r": fill("ri "), "git checkout": fill("git checkout "),
    "git branch -D": fill("git branch "), "gh api merges": fill("gh api "), "curl to sh": fill("curl "), "powershell -ec": fill("powershell "),
  };
  const slow = [];
  for (const [name, command] of Object.entries(cases)) {
    const best = bestMs(() => D.riskOf("Bash", { command }, false, APP), 60);
    if (best >= 60) slow.push(name + " " + best.toFixed(0) + " ms");
  }
  assert.deepEqual(slow, []);
});
