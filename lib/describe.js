// Plain words for HQ's Needs you items, from a fixed function, never a model: one line of at most 80
// characters that starts with the asker's name, a risk chip (Safe, Check first, Risky) with a plain reason for the last
// two, the detail the owner opens on purpose, and the choices. The chip reads the command or the tool input itself,
// never the description the agent wrote, so an agent's own words cannot make a risky call look safe.
const os = require("os");
const path = require("path");

const MAX_LINE = 80;
const NAME_MAX = 32;
const DETAIL_LINES = 60;
const DETAIL_WIDTH = 300;

// The keyword lists, money and merges among them. A keyword counts only as a whole word: "push" is not in "pushd".
const HIGH = ["rm -rf", "delete", "drop", "reset --hard", "push", "force", "deploy", "migration", "--prod", "supabase", "vercel",
  "stripe", "send money", "transfer money", "payout", "refund", "gh pr merge", "git merge"];
const MEDIUM = ["install", "add", "curl", "fetch", "network", "npx", "git checkout", "git branch"];
// Every short form PowerShell accepts for a parameter name: "-Recurse" as "-r", "-rec" or "-recurse"
const prefixes = (w) => Array.from({ length: w.length }, (_, k) => w.slice(0, w.length - k)).join("|");
// "first, then later in the same command (no | ; or & between), tail": tried only from the first match of `first` in
// each part, whose text holds any later start's, so it finds every match a plain pattern would, in time linear in the
// command. A plain pattern restarts its scan of the rest at every "rd", so a long "rd rd rd ..." takes quadratic time.
// Each tail takes one \s after the command word, not \s+, so spaces have one way to match.
const sameSegment = (first, tail) => ({ test: (s) => s.split(/[|;&]/).some((seg) => { const i = seg.search(first); return i >= 0 && tail.test(seg.slice(i)); }) });
// "from, then the next | hands to to": a download piped into a shell, the same linear way
const pipedTo = (from, to) => ({ test: (s) => { const p = s.split("|"); for (let k = 0; k + 1 < p.length; k++) if (from.test(p[k]) && to.test(p[k + 1])) return true; return false; } });
// Calls the lists do not name that are as hard to undo, each with its reason. "format" counts only as the drive
// command, so "npm run format" does not. A command split by quotes ("git pu''sh") is not caught, and a shell call is
// never Safe anyway.
const ALSO_HIGH = [
  [/(?<![\w-])(rm|rmdir|del|erase|unlink)(?=\s|$)/i, "deletes files"],
  [sameSegment(/(?<![\w-])(rd|rmdir)\s/i, /^(rd|rmdir)\s(?:[^|;&]*\s)?\/s(?![\w-])/i), "deletes files"],
  // PowerShell's short names for Remove-Item with -Recurse: "ri -r build", "rd build -Recurse"
  [sameSegment(/(?<![\w-])(ri|rd)\s/i, new RegExp("^(ri|rd)\\s(?:[^|;&]*\\s)?-(" + prefixes("recurse") + ")(?![\\w-])", "i")), "deletes files"],
  [/(?<![\w-])remove-item(?![\w-])/i, "deletes files"],
  [/(?<![a-z0-9])trash(?![a-z0-9])/i, "deletes files"],
  [/(?<![a-z0-9])(rmSync|unlinkSync|rimraf)(?![a-z0-9])/i, "deletes files"],
  [/(?<![\w-])git\s+(clean|restore)(?![\w-])/i, "deletes files"],
  // git work thrown away: changes under a path ("git checkout -- .", "git checkout ."), a branch that may not be merged
  // ("git branch -D", a capital D only: "-d" refuses an unmerged branch), and the stash
  [sameSegment(/(?<![\w-])git\s+checkout\s/i, /^git\s+checkout\s(?:[^|;&]*\s)?(--\s+[^\s|;&]|\.(?=\s|$|[|;&]))/i), "deletes files"],
  [sameSegment(/(?<![\w-])git\s+branch\s/, /^git\s+branch\s(?:[^|;&]*\s)?-D(?![\w-])/), "deletes files"],
  [/(?<![\w-])git\s+stash\s+(drop|clear)(?![\w-])/i, "deletes files"],
  [/(?<![\w.-])format(\.com)?\s+([a-z]:|\/)/i, "deletes files"],
  [/(?<![\w-])format-volume(?![\w-])/i, "deletes files"],
  [/(?<![\w-])dropdb(?![\w-])/i, "changes the live site or database"],
  // a table emptied or a database migrated ("TRUNCATE TABLE x", "npm run db:migrate")
  [/(?<![a-z0-9])(truncate|migrate)(?![a-z0-9])/i, "changes the live site or database"],
  [/(?<![a-z0-9])publish(?![a-z0-9])/i, "publishes or pushes code"],
  [/(?<![a-z0-9])unpublish(?![a-z0-9])/i, "publishes or pushes code"],
  [/(?<![\w-])gh\s+pr\s+merge(?![\w-])/i, "publishes or pushes code"],
  [sameSegment(/(?<![\w-])gh\s+api\b/i, /^gh\s+api\b[^|;&]*\/merges?(?![\w-])/i), "publishes or pushes code"],
  [/(?<![\w-])gh\s+release\s+(create|upload)(?![\w-])/i, "publishes or pushes code"],
  [/(?<![\w-])(iex|invoke-expression)(?![\w-])/i, "runs code you cannot see"],
  [pipedTo(/(?<![\w-])(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?![\w-])/i, /^\s*(sh|bash|zsh|pwsh|powershell|node|python3?|iex)(?![\w-])/i), "runs code you cannot see"],
  // a script handed to PowerShell as Base64: -EncodedCommand or any short form of it ("-e", "-ec", "-enc")
  [sameSegment(/(?<![\w-])(powershell|pwsh)(\.exe)?\s/i, new RegExp("^(powershell|pwsh)(\\.exe)?\\s(?:[^|;&]*\\s)?-(ec|" + prefixes("encodedcommand") + ")(?![\\w-])", "i")), "runs code you cannot see"],
];
const REASON = {
  "rm -rf": "deletes files", delete: "deletes files", "reset --hard": "deletes files",
  drop: "changes the live site or database", deploy: "changes the live site or database", migration: "changes the live site or database",
  "--prod": "changes the live site or database", supabase: "changes the live site or database", vercel: "changes the live site or database",
  push: "publishes or pushes code",
  force: "skips a safety check",
  stripe: "moves money", "send money": "moves money", "transfer money": "moves money", payout: "moves money", refund: "moves money",
  "gh pr merge": "merges code", "git merge": "merges code",
  install: "installs software", add: "installs software", npx: "installs software",
  curl: "uses the internet", fetch: "uses the internet", network: "uses the internet",
  "git checkout": "switches or merges branches", "git branch": "switches or merges branches",
};
// A command that hits several high keywords shows the first of these it hits.
const HIGH_ORDER = ["deletes files", "moves money", "changes the live site or database", "merges code", "publishes or pushes code", "runs code you cannot see", "skips a safety check"];
const LEVEL = { low: "Safe", medium: "Check first", high: "Risky" };
const word = (kw) => new RegExp("(?<![a-z0-9])" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+") + "(?![a-z0-9])", "i");
const RX = new Map([...HIGH, ...MEDIUM].map((kw) => [kw, word(kw)]));
const GIT_ADD = word("git add");
// "add" counts only as git's add or a package manager's. A package manager's add, install or i installs software, so
// "npm i left-pad" does, and "npm run add-user" reads as the program it runs.
const PM_ADD = /(?<![\w-])(npm|pnpm|yarn|bun)\s+(add|install|i)(?![\w-])/i;

function scan(text) {
  const s = typeof text === "string" ? text : "";
  const hits = new Set();
  for (const kw of HIGH) if (RX.get(kw).test(s)) hits.add(REASON[kw]);
  for (const [re, reason] of ALSO_HIGH) if (re.test(s)) hits.add(reason);
  const high = HIGH_ORDER.find((r) => hits.has(r));
  if (high) return { level: "high", reason: high };
  const kw = MEDIUM.find((k) => RX.get(k).test(s) && (k !== "add" || GIT_ADD.test(s) || PM_ADD.test(s)));
  if (kw) return { level: "medium", reason: kw === "add" && GIT_ADD.test(s) ? "stages files in git" : REASON[kw] };
  return PM_ADD.test(s) ? { level: "medium", reason: "installs software" } : { level: "low", reason: null };
}

const READ_ONLY = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"]);
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Secrets and the settings that hold them: env files, keys and tokens (npm, git, netrc, gh, docker, kube), credentials
// with or without a leading dot, Claude's and MCP's settings, git's insides
const SECRET_PATH = /(^|\/)(\.env[^/]*|\.npmrc|\.claude\.json|\.mcp\.json|\.?credentials[^/]*|\.git-credentials|[._]netrc)$|(^|\/)(\.claude|\.git|\.ssh|\.aws|\.config\/gh|\.docker|\.kube)(\/|$)/i;
// Files that run code later on their own or decide what runs: settings, CI, editor tasks, git hooks, scripts, lockfiles,
// package manager and Node version settings, and the instruction files every later session in that folder follows
const AUTOMATION_PATH = /(^|\/)(settings[^/]*\.json|package\.json|[^/]+\.lock|[^/]+-lock\.(json|ya?ml)|bun\.lockb|npm-shrinkwrap\.json|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|bunfig\.toml|\.nvmrc|\.node-version|CLAUDE(\.local)?\.md|AGENTS\.md)$|(^|\/)(\.github|\.vscode|\.husky|hooks)(\/|$)/i;
const SAFE = { level: "low", reason: null };
const SECRETS = { level: "medium", reason: "touches settings or secrets" };
const AUTOMATION = { level: "medium", reason: "changes settings or automation" };
const OUTSIDE = { level: "medium", reason: "changes a file outside this project" };
const OUTSIDE_READ = { level: "medium", reason: "reads files outside this project" };
const UNUSUAL = { level: "medium", reason: "an unusual file name" };
const TWO_FILES = { level: "medium", reason: "names two different files" };
const RUNS = { level: "medium", reason: "runs a program on your computer" };
const TOO_LONG = { level: "medium", reason: "too long to check in full" };
const ONLINE = { level: "medium", reason: "uses the internet" };
const CONNECTED = { level: "medium", reason: "uses a connected app" };
const UNKNOWN = { level: "medium", reason: "a tool VibeQuarters cannot check" };
// The most text a scan reads. The patterns' cost grows with the square of the text, so more is Risky unread, and VS Code
// asks. HQ's own copies are at most 4,000 characters: only the bridge, rating a full input, ever meets this.
const MAX_SCAN = 32768;
const TOO_BIG = { level: "high", reason: "too long to check" };
const FULL_RISK = { level: "high", reason: "rated Risky on the full call" }; // the bridge's risky mark, its kept copy milder
const chip = ({ level, reason }) => ({ level, label: LEVEL[level], reason });
// Each tool's own path key. A file tool's other path keys must name the same file; a read tool's secret check reads
// them all, plus Grep's and Glob's glob and Glob's pattern.
const OWN_KEY = new Map([["Read", "file_path"], ["Edit", "file_path"], ["MultiEdit", "file_path"], ["Write", "file_path"], ["NotebookEdit", "notebook_path"], ["NotebookRead", "notebook_path"], ["Grep", "path"], ["Glob", "path"], ["LS", "path"]]);
const PATH_KEYS = ["file_path", "notebook_path", "path"];
const str = (v) => (typeof v === "string" ? v : "");
const pathOf = (tool, i) => (OWN_KEY.has(tool) ? str(i[OWN_KEY.get(tool)]) : "");
const slash = (p) => p.replace(/\\/g, "/");
// Windows rules on purpose, whatever runs the tests: HQ and the chats it answers run on Windows (case-insensitive).
const HOME = path.win32.resolve(os.homedir());
// The file Windows opens: ".", ".." and a trailing slash resolve away, and a leading "~", alone or before a slash, is
// the home folder, as Claude Code expands it. A relative path with no folder to resolve against is read from home.
const full = (fp, cwd) => path.win32.resolve(typeof cwd === "string" && cwd ? cwd : HOME, /^~([\\/]|$)/.test(fp) ? HOME + fp.slice(1) : fp);
const rooted = (fp) => path.win32.isAbsolute(fp) || /^~([\\/]|$)/.test(fp);
// A glob that can reach past its folder: ".." anywhere, or the pattern or any brace alternative starting at a slash, a
// backslash, "~" or a drive letter ("*.{ts,tsx}" stays inside)
const ESCAPES = /\.\.|(^|[{,])\s*([\/\\~]|[A-Za-z]:)/;
const same = (a, b, cwd) => full(a, cwd).toLowerCase() === full(b, cwd).toLowerCase();
// Folder names that make a folder below home no project, and a file below a project's folder a settings change,
// compared without regard to case: settings, programs and startup folders, and Windows' old home junctions, which
// reach AppData and the rest under other names
const NOT_PROJECT = new Set(["appdata", "bin", "hooks", "windowspowershell", "powershell", "startup", "start menu", "node_modules", "application data", "local settings", "my documents", "cookies", "nethood", "printhood", "recent", "sendto", "templates"]);
// The request's folder when it is a project, else null. A project is an allowlist, not a denylist: a folder strictly
// below the home folder whose path below home holds no folder that starts with a dot (except a repo's own worktree,
// "<repo>/.claude/worktrees/<name>" and below, never the home folder's own .claude) and none of NOT_PROJECT, spelled
// with no unusual name in any folder (a short name, a trailing dot or space, a stream: see unusual()). Anything else
// is no project: the home folder and above, another drive, Windows, ProgramData, the settings folders and the folders
// whose files run at login, at a shell's start or on the PATH.
function projectOf(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  const root = path.win32.resolve(cwd);
  const rel = path.win32.relative(HOME, root);
  if (!rel || rel.startsWith("..") || path.win32.isAbsolute(rel) || unusual(root)) return null;
  const segs = rel.toLowerCase().split("\\");
  const worktree = (k) => k > 0 && segs[k] === ".claude" && segs[k + 1] === "worktrees" && k + 2 < segs.length;
  return segs.some((s, k) => (s.startsWith(".") && !worktree(k)) || NOT_PROJECT.has(s)) ? null : root;
}
// The path below the project's folder ("" for the folder itself) when it resolves within a project, else null
function below(fp, cwd) {
  const root = projectOf(cwd);
  if (!root) return null;
  const rel = path.win32.relative(root, full(fp, cwd));
  return rel.startsWith("..") || path.win32.isAbsolute(rel) ? null : rel;
}
// Inside the project, never the folder itself spelling only; a link made inside a project needs an approved shell call
// first
const inside = (fp, cwd) => !!fp && !!below(fp, cwd);
// A secret or automation name. Within a project the folders above it do not count (a project may sit in
// .claude/worktrees or under a folder named hooks): the lists read the path below the project's folder, and the typed
// path when it is relative. Anywhere else they read the typed path and the whole resolved path.
function flagged(re, fp, cwd) {
  if (!fp) return false;
  const rel = below(fp, cwd);
  if (rel !== null) return re.test(slash(rel)) || (!rooted(fp) && re.test(slash(fp)));
  return re.test(slash(fp)) || re.test(slash(full(fp, cwd)));
}
// A name Windows reads as another file than it spells: a path segment that ends in a dot or a space (Windows drops
// them), holds a colon past the drive letter (an NTFS stream, "package.json::$DATA") or a "~" and a digit (a short 8.3
// name, "PACKAG~1.JSO"). The segments "." and ".." are ordinary.
const unusual = (fp) => slash(fp).replace(/^[a-z]:/i, "").split("/").some((s) => (s !== "." && s !== ".." && /[. ]$/.test(s)) || s.includes(":") || /~\d/.test(s));
// A file below the project's folder with a NOT_PROJECT name in its path, the file's own name included
const listed = (fp, cwd) => {
  const rel = below(fp, cwd);
  return !!rel && rel.toLowerCase().split("\\").some((s) => NOT_PROJECT.has(s));
};
// What another tool's scan reads: its name, then every key name and every string in its input at any depth, in order,
// joined with spaces, so a word right after a newline is a whole word. Names and keys read their underscores as spaces
// ("drop_tables" is "drop tables"). Null once that passes MAX_SCAN, keys counted.
function textOf(tool, input) {
  const parts = [];
  let n = -1; // the joined length: each part and the space before it, less the first one's
  const stack = [input, String(tool).replace(/_/g, " ")];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      n += 1 + v.length;
      if (n > MAX_SCAN) return null;
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (let k = v.length - 1; k >= 0; k--) stack.push(v[k]);
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v);
      for (let k = keys.length - 1; k >= 0; k--) stack.push(v[keys[k]], keys[k].replace(/_/g, " "));
    }
  }
  return parts.join(" ");
}

// The chip for one call. Safe is what Approve all safe takes unread, so only a read or a file change can be Safe: a
// whole read within a real project, unless any path it names touches secrets; a file change only inside a real
// project, outside settings, automation and secrets (as typed and as resolved), under an ordinary name, naming one
// file and never cut (what was cut was not read). A shell call, a connector and every other tool are at least Check
// first, after the keyword scan, so a Risky hit stays Risky.
function riskOf(tool, input, trimmed = false, cwd = null) {
  const i = input && typeof input === "object" ? input : {};
  if (READ_ONLY.has(tool)) {
    const named = [...PATH_KEYS, "glob", ...(tool === "Glob" ? ["pattern"] : [])].map((k) => str(i[k]));
    if (named.some((p) => flagged(SECRET_PATH, p, cwd))) return chip(SECRETS);
    if (trimmed) return chip(TOO_LONG);
    if (tool === "TodoWrite") return chip(SAFE);
    // A Glob pattern or a Grep glob that can reach past the folder it searches (Grep's own pattern is a regex over
    // contents, not a path)
    const globs = tool === "Glob" ? [str(i.pattern)] : tool === "Grep" ? [str(i.glob)] : [];
    if (globs.some((g) => ESCAPES.test(g))) return chip(OUTSIDE_READ);
    // A short name or a stream opens another file than the one spelled (ENV~1 is .env), as for a change
    if (named.some((p) => unusual(p))) return chip(UNUSUAL);
    // What it reads: its own path, or the request's folder when it names none
    return chip(below(pathOf(tool, i), cwd) !== null ? SAFE : OUTSIDE_READ);
  }
  if (FILE_TOOLS.has(tool)) {
    const fp = pathOf(tool, i);
    if (flagged(SECRET_PATH, fp, cwd) || flagged(AUTOMATION_PATH, fp, cwd) || listed(fp, cwd)) return chip(AUTOMATION);
    if (unusual(fp)) return chip(UNUSUAL);
    if (fp && PATH_KEYS.some((k) => str(i[k]) && !same(str(i[k]), fp, cwd))) return chip(TWO_FILES);
    if (trimmed) return chip(TOO_LONG);
    return chip(inside(fp, cwd) ? SAFE : OUTSIDE);
  }
  if (tool === "Bash" || tool === "PowerShell") {
    if (str(i.command).length > MAX_SCAN) return chip(TOO_BIG);
    const r = scan(i.command);
    return chip(r.level !== "low" ? r : trimmed ? TOO_LONG : RUNS);
  }
  if (tool === "WebFetch" || tool === "WebSearch") return chip(ONLINE);
  // Only a Risky hit changes the reason here: every such tool is already Check first, and a medium word would only add
  // wrong words ("add_comment" installs nothing).
  const text = textOf(tool, i);
  if (text === null) return chip(TOO_BIG);
  const r = scan(text);
  if (r.level === "high") return chip(r);
  if (trimmed) return chip(TOO_LONG);
  return chip(!/^mcp__/.test(tool) ? UNKNOWN : /browser|navigate/i.test(tool) ? ONLINE : CONNECTED);
}

const ch = (n) => String.fromCharCode(n);
// Characters that hide or reorder text, built with String.fromCharCode, never typed: the C0 and C1 controls and DEL,
// the Arabic letter mark, the zero-width and direction marks, the direction embeddings and overrides, the word joiner,
// the invisible operators and the direction isolates
const HIDDEN = new RegExp("[\\x00-\\x1f\\x7f-\\x9f" + ch(0x61c) + ch(0x200b) + "-" + ch(0x200f) + ch(0x202a) + "-" + ch(0x202e) + ch(0x2060) + "-" + ch(0x2069) + "]", "g");
const squash = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
// Text for the one line, a name or a choice: whitespace runs read as one space, and hidden characters are dropped.
const clean = (s) => squash(squash(s).replace(HIDDEN, ""));
// A detail line shows each hidden character as a marker ("[U+202E]") so the owner sees that something is odd; a tab
// stays a tab.
const mark = (s) => s.replace(HIDDEN, (c) => (c === "\t" ? c : "[U+" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") + "]"));
// At most n characters, counted in code points so no emoji is cut in half; a cut text ends in an ellipsis.
const cut = (s, n) => {
  const c = [...s];
  return c.length > n ? c.slice(0, Math.max(0, n - 1)).join("") + "…" : s;
};
const base = (p) => clean(p).split(/[\\/]/).filter(Boolean).pop() || "";
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const lines = (s) => (typeof s === "string" && s ? s.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") : []);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const folderOf = (cwd) => clean(cwd).split(/[\\/]/).filter(Boolean).slice(-2).join("/");
// A connector's server in plain words: "plugin_database_database" reads "database", "claude_ai_Example_Files" "Example
// Files".
function serverOf(s) {
  s = s.replace(/^plugin_/, "").replace(/^claude_ai_/, "");
  const h = s.split("_");
  if (h.length % 2 === 0 && h.slice(0, h.length / 2).join("_") === h.slice(h.length / 2).join("_")) s = h.slice(0, h.length / 2).join("_");
  return s.replace(/_/g, " ");
}

// What a call does, in a few words (phrase), the same with no names or paths (generic), and the detail. A value with
// several lines gives several detail lines.
function callWords(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  const own = pathOf(tool, i);
  const file = base(own);
  const pairs = () => Object.entries(i).flatMap(([k, v]) => lines(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
  if (tool === "Bash" || tool === "PowerShell") {
    const d = clean(i.description).replace(/\.+$/, "");
    return { phrase: d ? lowerFirst(d) : "run a command", generic: "run a command", detail: lines(i.command), detailKind: "command" };
  }
  if (tool === "Edit" || tool === "MultiEdit") {
    const edits = tool === "MultiEdit" ? (Array.isArray(i.edits) ? i.edits : []) : [i];
    const out = edits.flatMap((e) => lines(e && e.old_string));
    const inn = edits.flatMap((e) => lines(e && e.new_string));
    return { phrase: file ? `change ${file}, ${plural(out.length, "line")} out, ${inn.length} in` : "change a file", generic: "change a file", detail: [...out.map((l) => "- " + l), ...inn.map((l) => "+ " + l)], detailKind: "change" };
  }
  if (tool === "Write") return { phrase: file ? "write " + file : "write a file", generic: "write a file", detail: lines(i.content).map((l) => "+ " + l), detailKind: "change" };
  if (tool === "NotebookEdit") return { phrase: file ? "change " + file : "change a notebook", generic: "change a notebook", detail: lines(i.new_source).map((l) => "+ " + l), detailKind: "change" };
  if (tool === "Read") return { phrase: file ? "read " + file : "read a file", generic: "read a file", detail: [squash(own)].filter(Boolean), detailKind: "text" };
  if (tool === "WebFetch") {
    let host = "";
    try {
      host = new URL(i.url).hostname.replace(/^www\./, "");
    } catch {}
    return { phrase: host ? "open " + host : "open a web page", generic: "open a web page", detail: [squash(i.url)].filter(Boolean), detailKind: "text" };
  }
  if (tool === "WebSearch") {
    const q = clean(i.query);
    return { phrase: q ? "search the web for " + q : "search the web", generic: "search the web", detail: [squash(i.query)].filter(Boolean), detailKind: "text" };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) return { phrase: `use ${serverOf(m[1])}: ${m[2].replace(/_/g, " ")}`, generic: "use a connected tool", detail: pairs(), detailKind: "text" };
  return { phrase: "use " + tool, generic: "use a tool", detail: pairs(), detailKind: "text" };
}

// The name (at most 32 characters) and the rest of the line, so both together are at most 80.
function fit(name, what) {
  const who = cut(clean(name) || "A chat", NAME_MAX);
  return { who, what: cut(clean(what), MAX_LINE - [...who].length - 1) };
}
const CUT_NOTE = "Only the first part is shown; the rest was too long to send";
const WIDE_NOTE = "A long line was cut; open it in VS Code to read it all";
// At most 60 lines of at most 300 characters, then a count, then WIDE_NOTE when a line was cut at the width. A cut input
// (the request keeps 4,000 characters) opens with CUT_NOTE, and its count says "at least": it counts only the kept part.
function capDetail(list, trimmed = false) {
  const shown = list.slice(0, DETAIL_LINES).map((l) => mark(String(l)));
  const out = shown.map((l) => cut(l, DETAIL_WIDTH));
  const wide = out.some((l, k) => l !== shown[k]);
  if (list.length > DETAIL_LINES) out.push(`and ${trimmed ? "at least " : ""}${list.length - DETAIL_LINES} more lines`);
  if (wide) out.push(WIDE_NOTE);
  return trimmed ? [CUT_NOTE, ...out] : out;
}
// The questions a question request carries, 1 to 4 in the shape HQ reads (lib/decisions.js requestOf), else null
function questionsOf(input) {
  const qs = input && typeof input === "object" ? input.questions : null;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const fine = (q) => q && typeof q === "object" && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0 && q.options.every((o) => o && typeof o === "object" && typeof o.label === "string");
  return qs.every(fine) ? qs : null;
}
const CONFIRM_MAX = 60; // characters of what a Risky Approve's second click names
// What a Risky Approve's second click says will run: a command's first line with text, cut, and how many more lines it
// has; for any other tool the call's own words (never the description the agent wrote)
function confirmOf(tool, input, w) {
  const ls = tool === "Bash" || tool === "PowerShell" ? lines(str(input && input.command)).map(clean).filter(Boolean) : [];
  if (!ls.length) return "Yes, " + cut(clean(w.phrase), CONFIRM_MAX);
  return "Yes, run: " + cut(ls[0], CONFIRM_MAX) + (ls.length > 1 ? ` (and ${plural(ls.length - 1, "more line")})` : "");
}
// A safety hook's ask (lib/askmark.js): the item carries it, and its reason opens the detail
const hookOf = (req) => (req.hookAsk ? { hookAsk: { hook: req.hookAsk.hook, reason: req.hookAsk.reason } } : {});
const withHook = (req, detail) => (req.hookAsk ? [squash(req.hookAsk.reason), ...detail].filter((l, k) => k > 0 || l) : detail);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const chatLink = (id) => (UUID.test(id) ? "vscode://anthropic.claude-code/open?session=" + id : null);

// One open request as an item. `who` names the asker (a subagent's floor agent, else the session), the session, and
// the figure in the room that raises its hand ("a:<agent id>" or "s:<session id>"). A malformed question throws
// "describe: not a question request", so the caller that drops it can log why. A notice (a prompt HQ held to the cap,
// now asked in VS Code) keeps its words and chip, offers nothing, says how long HQ held it, and links its chat.
function describe(req, who = {}) {
  const common = { id: req.id, sessionId: req.sessionId, sessionName: who.sessionName || null, agentId: req.agentId || null, figure: who.figure || null, askedAt: req.askedAt, toolName: req.toolName, hash: req.hash, folder: folderOf(req.cwd), link: null };
  const notice = req.notice === true;
  const mins = Math.round((req.movedAt - req.askedAt) / 60e3); // under half a minute when its HQ page closed early
  const moved = notice ? { notice: true, moved: `Moved to VS Code after ${mins < 1 ? "less than 1" : mins} min`, link: chatLink(req.sessionId) } : {};
  const name = who.name || who.sessionName;
  const trimmed = req.trimmed === true;
  if (req.event === "PreToolUse") {
    const qs = questionsOf(req.toolInput);
    if (!qs) throw new Error("describe: not a question request");
    const q = qs[0];
    const shown = (x) => x.options.map((o) => (squash(o.description) ? `${squash(o.label)}: ${squash(o.description)}` : squash(o.label)));
    // one question with one pick: one click on its option
    if (qs.length === 1 && q.multiSelect !== true)
      return {
        ...common, kind: "question", ...moved, ...fit(name, "asks: " + q.question), generic: "asks you a question",
        detail: capDetail([squash(q.question), ...shown(q)], trimmed), detailKind: "text",
        risk: null, choices: notice ? [] : q.options.map((o, k) => ({ key: "opt:" + k, label: clean(o.label), description: clean(o.description) })),
      };
    // any other shape: the owner picks for each question, then Send
    const n = qs.length;
    return {
      ...common, kind: "question", ...moved, ...fit(name, n === 1 ? "asks: " + q.question : `asks ${n} questions: ${q.question}`), generic: n === 1 ? "asks you a question" : `asks you ${n} questions`,
      detail: capDetail(qs.flatMap((x) => [squash(x.question) + (x.multiSelect === true ? " (one or more)" : ""), ...shown(x)]), trimmed), detailKind: "text",
      risk: null, choices: notice ? [] : [{ key: "picks", label: "Send" }],
      questions: qs.map((x) => ({ question: clean(x.question), multiSelect: x.multiSelect === true, options: x.options.map((o) => ({ label: clean(o.label), description: clean(o.description) })) })),
    };
  }
  // a plan approval: the plan to start on, no chip; Keep planning is a deny with the owner's note
  if (req.toolName === "ExitPlanMode") {
    const plan = req.toolInput && typeof req.toolInput.plan === "string" ? req.toolInput.plan : "";
    return {
      ...common, kind: "permission", ...moved, ...hookOf(req), ...fit(name, "wants to start on its plan"), generic: "wants to start on its plan",
      detail: capDetail(withHook(req, lines(plan)), trimmed), detailKind: "text", risk: null,
      choices: notice ? [] : [{ key: "allow", label: "Approve" }, { key: "revise", label: "Keep planning" }],
    };
  }
  const w = callWords(req.toolName, req.toolInput);
  // the bridge marks a request risky when its full call reads Risky, so when the kept copy reads lower (the cut hid the
  // trigger) it is shown as Risky on the full call; a Risky Approve takes a second click, which says what will run
  let risk = riskOf(req.toolName, req.toolInput, trimmed, req.cwd);
  if (req.risky === true && risk.level !== "high") risk = chip(FULL_RISK);
  return {
    ...common, kind: "permission", ...moved, ...hookOf(req), ...fit(name, "wants to " + w.phrase), generic: "wants to " + w.generic,
    detail: capDetail(withHook(req, w.detail), trimmed), detailKind: w.detailKind, risk,
    choices: notice ? [] : [{ key: "allow", label: "Approve" }, { key: "deny", label: "Deny" }, { key: "revise", label: "Ask for changes" }],
    ...(!notice && risk.level === "high" ? { confirm: confirmOf(req.toolName, req.toolInput, w) } : {}),
  };
}

// A finished turn waiting for the owner's reply: its task line, and a link that opens the chat in VS Code.
function describeReply(s, who = {}) {
  return {
    id: "reply:" + s.id, kind: "reply", sessionId: s.id, sessionName: s.name, agentId: null, figure: who.figure || "s:" + s.id,
    askedAt: s.lastAt, toolName: null, hash: null, folder: folderOf(s.cwd), link: chatLink(s.id),
    ...fit(s.name, "is waiting for your reply"), generic: "is waiting for your reply",
    detail: capDetail([squash(s.task) || squash(s.action) || "No task line yet."]), detailKind: "text", risk: null, choices: [],
  };
}

module.exports = { describe, describeReply, callWords, riskOf, HIGH, MEDIUM, ALSO_HIGH, MAX_LINE, READ_ONLY, FILE_TOOLS };

// ---------- The secret cuts for the desk screens ----------
// Every string a desk screen shows passes through cutSecrets before it leaves the server: an Authorization or Cookie
// header's rest of line, a private key block, key and token shapes (Stripe, OpenAI and Anthropic, GitHub, Slack, AWS,
// Google, JWTs, Supabase and others), a bearer token, a URL's userinfo, every text field's value in a page snapshot, a
// secret flag's value, curl's, mysql's, sshpass's and docker login's password flags, an OAuth code, a Slack webhook's
// path, a named secret's value (a name holding key, secret, token, pass, pwd, auth, credential, cookie, signature,
// private or service_role, or a pw name, then = or :), an env line's value (NAME=value), a bare AWS secret key, a key
// body line, and any run of 32 or more key characters mixing capitals, small letters and digits. Each becomes
// "[hidden]"; the words around it stay.
const HIDE = "[hidden]";
// Every cut runs in time linear in its text: a match may start only where a name or token starts (a
// lookbehind refuses the run's own characters before it), and a part that something must follow is bounded, so no
// crafted run of name characters and keywords can make one backtrack over the whole text again and again. A run of
// whitespace was never the source (it cannot be taken for a name), so whitespace stays wide: up to 64, newlines where
// they were allowed before, and aligned config lines stay masked.
const CUT = {
  auth: [/(\b(?:proxy-)?authorization\s{0,64}(?:["']\s{0,64})?[:=]\s{0,64}).+/gi, "$1" + HIDE],
  cookie: [/(\b(?:set-)?cookie\s{0,64}(?:["']\s{0,64})?:\s{0,64}).+/gi, "$1" + HIDE],
  // each line of the block becomes "[hidden]" (the cut keeps the text's lines, so the screens can tell
  // which lines a cut changed)
  privateKey: [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/gi, (m) => m.replace(/[^\n]+/g, HIDE)],
  stripe: [/(?<![A-Za-z0-9_])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, HIDE],
  openai: [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, HIDE],
  github: [/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, HIDE],
  slack: [/(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g, HIDE],
  awsKeyId: [/(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])/g, HIDE],
  google: [/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}/g, HIDE],
  // a JWT may follow a dash (--token-eyJ...), so its first two parts are bounded: a dash run of eyJ starts cannot each
  // scan to the end of the text (the second to 4096); a longer part is still a key-like run
  jwt: [/(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]*/g, HIDE],
  prefixed: [/(?<![A-Za-z0-9_])(?:sbp|sb_secret|whsec|glpat|shpat|shpss|hf|npm)_[A-Za-z0-9_-]{16,}/g, HIDE],
  bearer: [/\b(Bearer)(\s{1,64}|%20)(?:\[hidden\])?[A-Za-z0-9._~+/=-]{6,}/gi, "$1$2" + HIDE],
  // a URL's whole userinfo before the @ that comes before its host: an empty user, a token alone, a / or @ in a password;
  // the host may be any shape (${PORT}, [::1], {{ db_host }}, a socket path), only no @ may follow in it
  urlUserinfo: [/((?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/?#@:]{0,256}:[^\s]{0,256}?|[^\s/?#@:]{1,256})@(?=[^\s/?#@]{0,300}(?:[/?#\s"'`]|$))/gi, "$1" + HIDE + "@"],
  // a page snapshot's text field, labeled or not: its label stays, the value typed into it goes (a password, a card)
  textbox: [/^([ \t]{0,256}-[ \t]{1,64}textbox\b(?:[ \t]{1,64}"(?:[^"\\\n]|\\.){0,256}")?[^\n:"]{0,256}:[ \t]{0,64})\S.*$/gim, "$1" + HIDE],
  // a password field's label met anywhere else on a line (text flattened out of a snapshot)
  textboxLabel: [/(textbox\s{1,64}"[^"\n]{0,256}(?:pass|secret|token|key|pin|code)[^"\n]{0,256}"[^\n:]{0,256}:\s{0,64}).+/gi, "$1" + HIDE],
  flag: [/((?<![A-Za-z0-9_-])--?[A-Za-z-]{0,40}(?:password|passwd|token|secret|api-?key|auth)[A-Za-z-]{0,40}\s{1,64})(?!-)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s"'`]+)/gi, "$1" + HIDE],
  // a URL's signature: Azure's sig, and (as the name cut no longer counts the word) a presigned URL's
  // signature, X-Amz-Signature and X-Goog-Signature
  sig: [/([?&](?:sig|(?:x-(?:amz|goog)-)?signature)=)[^&\s"'`]+/gi, "$1" + HIDE],
  oauthCode: [/([?&]code=)[^&\s"'`#]+/gi, "$1" + HIDE],
  slackHook: [/(hooks\.slack\.com\/services\/)[^\s"'`<>)]+/gi, "$1" + HIDE],
};
// Commands whose flags carry a password, each cut in its own line (a line continued by a backslash included): curl's
// -u / --user and -b / --cookie, mysql's and mariadb's -p glued to its value, sshpass -p, docker login -p / --password.
// Elsewhere -p is a port or parents, -u an upstream and -b a branch, so those stay.
const FLAG_VALUE = `('[^'\\n]*'|"[^"\\n]*"|[^\\s'"]+)`;
const CURL_FLAG = new RegExp(`((?:^|[ \\t])(?:--user|--cookie)(?:[ \\t]{1,64}|=)|(?:^|[ \\t])-[ub][ \\t]{0,64})` + FLAG_VALUE, "g");
const MYSQL_FLAG = new RegExp(`((?:^|[ \\t])-p)` + FLAG_VALUE, "g");
const PASS_FLAG = new RegExp(`((?:^|[ \\t])(?:-p|--password)(?:[ \\t]{1,64}|=)?)('[^'\\n]*'|"[^"\\n]*"|[^\\s'"-][^\\s'"]*)`, "g");
const inLine = (flag) => (line) => line.replace(flag, (all, f, v) => (hidden(v) ? all : f + HIDE));
Object.assign(CUT, {
  curl: [/\bcurl\b(?:\\\r?\n|[^\n]){0,4096}/g, inLine(CURL_FLAG)],
  mysql: [/\b(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump)\b(?:\\\r?\n|[^\n]){0,4096}/g, inLine(MYSQL_FLAG)],
  sshpass: [/\bsshpass\b(?:\\\r?\n|[^\n]){0,4096}/g, inLine(PASS_FLAG)],
  dockerLogin: [/\bdocker[ \t]{1,64}login\b(?:\\\r?\n|[^\n]){0,4096}/g, inLine(PASS_FLAG)],
});
const CUTS = Object.values(CUT);
// A named secret's value: a name (a whole run of name characters, at most 256) that names a secret, then = or :, its
// quotes escaped or not. A quoted value is hidden to its closing quote (a passphrase with spaces; up to three of the same
// quote, as TOML and Python write), a bare one to its end. A name that names no secret keeps its value, and the scan goes
// on inside that value (a URL's query names its own). The = or : may be written %3D or %3A in a URL (its quotes %22 or
// %27), &#61; or &#58; in HTML, = or : in JSON, or full width; after a URL's, the value ends at %22, %27, %26, & or a
// space.
// One vocabulary: a name names a secret when the line rule's words count it (secretLine, below): a secret
// word, token, auth, an UPPER_CASE name ending in _KEY, a name ending in dsn, pass, pwd or pw as the name or its end
// ($pw, SMTP_PW, db_pass) or after an owner word (dbPass), and PASS in capitals alone only before =. So output_tokens,
// forceSinglePass, x.key, ParameterKey and Go's --- PASS: keep their values, in a screen as in a label or a file name.
const DSN_END = /(?<![A-Za-z0-9])dsn$/i, EQ_SEP = new RegExp("=|%3[Dd]|&#61;|" + /\\u003[Dd]/.source + "|" + ch(0xff1d));
// (an UPPER_CASE _KEY name is a key name, below, so the deny list applies to it; and a camelCase Auth end)
const secretName = (n, sep = "=") => SECRET_WORDS.test(n) || TOKEN_WORD.test(n) || AUTH_WORD.test(n) || keyName(n) || PIN_END.test(n) || SIG_END.test(n) ||
  CAMEL_AUTH_END.test(n) || DSN_END.test(n) || PW_OWNED_END.test(n) || (PW_END.test(n) && (n !== "PASS" || EQ_SEP.test(sep)));
const SEP_WORD = "(?:" + [/[:=]/.source, /%3[AaDd]/.source, /&#(?:58|61);/.source, /\\u003[AaDd]/.source, ch(0xff1a), ch(0xff1d)].join("|") + ")";
const SEP = /\\?["']?(?:%2[27])?\s{0,64}/.source + SEP_WORD + /\s{0,64}(?:%2[27])?/.source;
// a bare value's characters; a "[hidden]" an earlier cut wrote counts as part of it, so text after it is cut too; a
// backslash counts unless a quote follows it (pa\ss is one value, an escaped JSON value ends at \")
const BARE = "(?:" + /\[hidden\]/.source + "|" + /[^\s"'`&,;<>()[\]{}\\]/.source + "|" + /\\(?!["'])/.source + ")";
const VALUES = [/"""[^"\n]{1,512}?"""/.source, /'''[^'\n]{1,512}?'''/.source, /\\?"[^"\n]{1,512}?\\?"/.source, /\\?'[^'\n]{1,512}?\\?'/.source, /\\?["']?/.source + BARE + "{1,256}"];
const NAMED = new RegExp(/(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,256})/.source + "(" + SEP + ")(?=(" + VALUES.join("|") + "))", "g");
const VALUE_REST = new RegExp(BARE + "*", "y"), URL_VALUE = /(?:(?!%2[267])[^\s&"'`])+/y;
const QUOTE_OPEN = /^(?:"""|'''|\\?["'])/, QUOTE_CLOSE = /(?:"""|'''|\\?["'])$/;
// a value already cut is exactly "[hidden]", quoted or not; anything more is cut again
const hidden = (v) => v === HIDE || v === '"' + HIDE + '"' || v === "'" + HIDE + "'";
function cutNamed(s) {
  let out = "", from = 0, m;
  NAMED.lastIndex = 0;
  while ((m = NAMED.exec(s))) {
    const [all, name, sep, val] = m;
    // not a secret's name: the scan goes on right after it, so a name inside the separator's %27 or %22 is seen
    if (!secretName(name, sep)) { NAMED.lastIndex = m.index + name.length; continue; }
    let open = "", inner, close = "", stop;
    if (sep.includes("%")) { // a URL's value, to its end
      URL_VALUE.lastIndex = m.index + all.length;
      const u = URL_VALUE.exec(s);
      if (!u) continue;
      inner = u[0];
      stop = URL_VALUE.lastIndex;
    } else {
      const o = QUOTE_OPEN.exec(val);
      open = o ? o[0] : "";
      inner = val.slice(open.length);
      const c = open ? QUOTE_CLOSE.exec(inner) : null;
      if (c && inner.length > c[0].length) { close = c[0]; inner = inner.slice(0, -close.length); }
      stop = m.index + all.length + val.length;
      if (!close) { VALUE_REST.lastIndex = stop; VALUE_REST.exec(s); stop = VALUE_REST.lastIndex; } // a bare value to its end
    }
    if (!inner || hidden(inner)) continue;
    out += s.slice(from, m.index) + name + sep + open + HIDE + close;
    from = NAMED.lastIndex = stop;
  }
  return out + s.slice(from);
}
// an env line's value (NAME=value), quoted or not; its quotes stay
const ENV_LINE = /(?<![A-Za-z0-9_.$-])([A-Z][A-Z0-9_]{1,127}=)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s"'`&;,)]+)/g;
const envCut = (all, name, val) => {
  const q = val[0] === '"' || val[0] === "'" ? val[0] : "", inner = q ? val.slice(1, -1) : val;
  return !inner || hidden(inner) ? all : name + q + HIDE + q;
};
// key shapes with no name: an AWS secret access key (40 characters, / and + among them), a whole line of 60 or more
// base64 characters (a private key's body without its BEGIN line, a Read's line number before it allowed), and any run of
// 32 or more key characters. Each only when it mixes capitals, small letters and digits: lowercase hex (git SHAs,
// hashes) stays.
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const KEY_LINE = new RegExp("^([ \\t]{0,64}(?:\\d{1,9}(?:\\t|" + ch(0x2192) + ")[ \\t]{0,64})?)([A-Za-z0-9/+=]{60,})[ \\t]*$", "gm");
const KEYLIKE = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}/g;
const CAPS = /[A-Z]/, SMALL = /[a-z]/, DIGIT = /[0-9]/;
const mixed = (w) => CAPS.test(w) && SMALL.test(w) && DIGIT.test(w);
// the hidden characters but tab, newline and carriage return, dropped before the cuts: one inside a token
// or a name kept it from matching any shape, and dropping it afterwards rejoined it on screen. Every
// control, format and default-ignorable character (variation selectors, tag characters, the Hangul fillers and the
// musical formatting marks among them); the escape is kept until terminal color codes are read, then dropped too.
const ESC = ch(27), ESCS = new RegExp(ESC, "g");
const HIDDEN_SOFT = new RegExp("(?![\\t\\n\\r" + ESC + "])[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}]", "gu");
const soft = (s) => s.replace(HIDDEN_SOFT, "").replace(ANSI, "").replace(ESCS, "");
function cutSecrets(s) {
  if (typeof s !== "string" || !s) return "";
  s = soft(s);
  for (const [re, to] of CUTS) s = s.replace(re, to);
  s = cutNamed(s);
  s = s.replace(ENV_LINE, envCut);
  s = s.replace(AWS_SECRET, (w) => (mixed(w) ? HIDE : w));
  s = s.replace(KEY_LINE, (all, pre, body) => (mixed(body) ? pre + HIDE : all));
  return s.replace(KEYLIKE, (w) => (mixed(w) ? HIDE : w));
}
// the cuts in one pass, two ways: full, as cutSecrets cuts; and shapes, every cut but the two by a name
// (NAMED and ENV_LINE), which tell the screens which lines a key's shape changed
const cutTail = (s) => s.replace(AWS_SECRET, (w) => (mixed(w) ? HIDE : w)).replace(KEY_LINE, (all, pre, body) => (mixed(body) ? pre + HIDE : all)).replace(KEYLIKE, (w) => (mixed(w) ? HIDE : w));
function cutBoth(s) {
  s = soft(s);
  for (const [re, to] of CUTS) s = s.replace(re, to);
  return { full: cutTail(cutNamed(s).replace(ENV_LINE, envCut)), shapes: cutTail(s) };
}
const ANSI =new RegExp(ESC + "\\[[0-9;?]{0,64}[ -/]{0,16}[@-~]", "g");
// A file whose contents are secrets by their nature: env files, npm and git credentials, netrc, .pgpass, the Claude and
// MCP configs, a base name holding "secret", key and certificate files (.pem, .key, .p12, .pfx), ssh keys (id_rsa*,
// id_ed25519*) anywhere, and anything under .ssh, .aws, .docker, .kube or gh's config. A screen shows its name, never
// its lines.
const SECRET_BASE = /^(?:\.env.*|\.npmrc|\.claude\.json|\.mcp\.json|\.?credentials.*|\.git-credentials|[._]netrc|\.pgpass|.*secret.*|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519).*)$/i;
const SECRET_DIR = /(?:^|\/)(?:\.ssh|\.aws|\.config\/gh|\.docker|\.kube)(?:\/|$)/i;
function secretFile(p) {
  const f = slash(String(p || ""));
  return SECRET_BASE.test(f.slice(f.lastIndexOf("/") + 1)) || SECRET_DIR.test(f);
}

// ---------- secret lines hidden whole ----------
// The main guard. A line that names a password, a key, a token, a secret or the like, or holds a password in a web
// address, is hidden whole, with the lines that belong to it; every other line stays as it is. The cuts above stay as
// the inner layer: a line a cut changes is a secret line too (a key's shape with no name near it), and the cuts alone
// serve file names and step labels (a name like password-reset.tsx shows). A hidden line never travels as text: it is
// its indent in spaces, a NUL and its length (at most the screen's width), and the page draws a dim bar that long. No
// screen text holds a NUL (the controls go first), so no text passes for a hidden line, and a hidden line holds nothing
// else.
const BAR = ch(0), WIDTH = 160, BAR_INDENT = 80;
const BAR_LINE = new RegExp("^( {0," + BAR_INDENT + "})" + BAR + "(\\d{1,3})$");
const barLine = (indent, len) => { const i = Math.min(indent, BAR_INDENT); return " ".repeat(i) + BAR + Math.max(1, Math.min(len, WIDTH - i)); };
const barOf = (l) => { const m = typeof l === "string" ? BAR_LINE.exec(l) : null; return m ? { indent: m[1].length, len: +m[2] } : null; };
// 1. The secret words, in any case: these always; a connection string; an auth token, key or header, and x-auth; a dsn
// as a name; the key names. Bare "key" never: React's key= and map keys are everywhere. Also
// service role with or without its separator; a key word run together with what it keys (appkey, sshkey, AESKey,
// hmacKeyHex, sessionKey2; with the i flag the acronyms too); an API key in prose ("Your API key:", which a reply writes);
// pswd, and password in German, French, Spanish, Portuguese, Dutch, Polish and Finnish.
const SECRET_WORDS = new RegExp([
  /password|passwd|passphrase|pass(?:code|key)|pswd|passwort|mot_de_passe|contrasena|senha|wachtwoord|haslo|salasana/.source,
  /secret|credential|authorization|bearer|cookie|service[_-]?role|convertto-securestring/.source,
  /(?:app|priv|ssh|enc|hmac|webhook|aes|rsa|jwt|tls|gpg|pgp|sign|crypt|session|root|admin|stripe)key(?:hex|b64|base64|pem|der|bytes|raw|live|test|prod|v?[0-9]{1,4})?(?![a-z0-9_])/.source,
  /identified[ \t]{1,64}by|connection[_-]?string|auth[_-]?(?:token|key|header)|x-auth/.source,
  /api[_ -]?key|private[_ -]?key|(?:access|signing|encryption|master|client|service|license)[_-]?key/.source,
].join("|"), "i");
const DSN_NAME = /(?<![A-Za-z0-9])dsn["'`]?[ \t]{0,64}[:=]/i;
// token, in any case, but not tokenize, tokenizer or tokenise, nor a count's or a plural's: tokens,
// output_tokens, tokensOf, tokenCount, token_usage, token_budget, TOKEN_LIMIT; token, api_token, tokenSecret and
// GITHUB_TOKEN still count. And auth as a whole word (app auth, --auth, auth:), never author, authenticate, authorize
// or OAuth.
const TOKEN_WORD = /[Tt][Oo][Kk][Ee][Nn](?![Ii][SsZz]|[_-]?(?:[Cc]ount|COUNT|[Uu]sage|USAGE|[Bb]udget|BUDGET|[Ll]imit|LIMIT)|[_-]?[Ss](?![a-z]))/;
const AUTH_WORD = /(?<![A-Za-z0-9])auth(?![A-Za-z0-9])/i;
// An identifier ending in a separated key: camelCase (appKey, sessionKey) or snake and kebab case
// (webhook_key, hmac-key), at the identifier's end; never key alone, .key, key=, or a word that merely ends in key
// (monkey, turkey). The part before the separator names what the key is for; KEY_NAME_DENY, this one constant, is the
// list of those parts that name a key that is no secret (a database's, a cache's, a list's, a route's, a file's, a
// keyboard's, a public one), and parameter, since a CloudFormation ParameterKey names a
// parameter (ParameterKey: Stage stays as it is; the value beside a secret one is hidden).
// An UPPER_CASE or kebab name ending in _KEY or -KEY is a key name too (STORAGE_KEY keeps its value, DD-APP-KEY
// does not), and a camelCase one may end in a suffix after Key (webhookKeyB64, cacheKeyV2); the deny list holds the
// keyboard's modifiers (ctrl, shift, alt, meta) and get, tag, sum, label, feature, step, count, to, on and category.
const KEY_NAME_DENY = new Set(("primary foreign sort partition range hash composite compound natural surrogate candidate unique index " +
  "cache storage local query mutation row column field table record entry item list group child parent node element component prop attr data " +
  "route nav menu tab page cursor next prev first last order sequence event idempotency dedupe dedup " +
  "i18n translation locale lookup map dict object file image photo asset s3 bucket path " +
  "hot shortcut keyboard react state store context public publishable sigv4 parameter " +
  "ctrl shift alt meta get tag sum label feature step count to on category").split(" "));
const KEY_NAME = /(?<![A-Za-z0-9])([A-Za-z0-9]{1,64})[_-](?:[Kk]ey|KEY)(?![A-Za-z0-9_])|([A-Z]?[a-z0-9]{1,64})Key(?:Hex|B64|Base64|Pem|Der|Bytes|Raw|Live|Test|Prod|V?[0-9]{1,4})?(?![A-Za-z0-9_])/g;
function keyName(l) {
  KEY_NAME.lastIndex = 0;
  for (let m; (m = KEY_NAME.exec(l)); ) if (!KEY_NAME_DENY.has((m[1] || m[2]).toLowerCase())) return true;
  return false;
}
// pin_code as a field (pinCode, PIN_CODE), and signature as a field (prose about a function's signature
// is not); passcode and passkey are secret words above. pin alone as a field too ("pin":, PIN=, user_pin:),
// never pinned, spinner or pinCount.
const FIELD_END = /["'`]?[ \t]{0,64}(?:=>|[:=])/.source;
const PIN = "(?:(?<![A-Za-z0-9])(?:[Pp]in(?:[_-]?[Cc]ode)?|PIN(?:[_-]?CODE)?)|(?<=[a-z0-9])Pin[_-]?Code)";
const PIN_FIELD = new RegExp(PIN + FIELD_END), PIN_END = new RegExp(PIN + "$");
const SIG_FIELD = new RegExp("signature" + FIELD_END, "i"), SIG_END = /signature$/i;
// 2. pass, pwd or pw as a field (the whole name, or its _pass, -pwd or Pw end; then a closing quote at most and :, = or
// =>) or as a flag (--pass, --pwd, -pass, -pw, or -pwd glued to its value). Never Python's pass or the shell's pwd alone.
// PASS in capitals alone counts only before = (Go's --- PASS: TestX and a bare PASS stay), as a name's end
// (DB_PASS) before : as well; and Pass, Pwd or Pw as a camelCase end only after an owner word (dbPass, smtpPw,
// primaryDbPass), never forceSinglePass or renderPass.
const PW_FIELD = /(?<![A-Za-z0-9])(?:(?!PASS)[Pp][Aa][Ss][Ss]|[Pp][Ww][Dd]|[Pp][Ww])(?![A-Za-z0-9_])["'`]?[ \t]{0,64}(?:=>|[:=])/;
const PASS_CAPS = /(?<=[A-Za-z0-9][_-])PASS(?![A-Za-z0-9_])["'`]?[ \t]{0,64}(?:=>|[:=])|(?<![A-Za-z0-9_-])PASS(?![A-Za-z0-9_])["'`]?[ \t]{0,64}=/;
const PW_OWNERS = "db|user|admin|root|smtp|mail|ftp|sftp|ssh|redis|mysql|postgres|pg|sql|api|app|account|login|wifi|vault|master|service|client|proxy|ldap|email|bind|keystore|truststore".split("|");
const anyCase = (w) => [...w].map((c) => "[" + c.toUpperCase() + c + "]").join("");
const PW_OWNED = "(?:(?<![A-Za-z0-9])(?:" + PW_OWNERS.map(anyCase).join("|") + ")|(?<=[a-z0-9])(?:" +
  PW_OWNERS.map((w) => w[0].toUpperCase() + w.slice(1) + "|" + w.toUpperCase()).join("|") + "))(?:[Pp]ass|[Pp]wd|[Pp]w|PASS|PWD|PW)(?![A-Za-z0-9_])"; // (dbpass, smtppass, mysqlpwd)
const PW_CAMEL_FIELD = new RegExp(PW_OWNED + /["'`]?[ \t]{0,64}(?:=>|[:=])/.source);
const PW_FLAG = /(?<![A-Za-z0-9_-])(?:--?(?:pass|pwd|pw)(?![A-Za-z0-9_-])|-pwd)/i;
// 3. Credential flags: -u, --user, --proxy-user or -U and then name:value; a tool's login line with -p; mysql's or
// mariadb's -p glued to a value; sshpass -p; openssl's -k or -pass.
const USER_FLAG = /(?<![A-Za-z0-9_-])(?:-u|--user|--proxy-user)(?:[ \t]{1,64}|=)?["']?[^\s:"']{1,256}:[^\s"']/i;
const LOGIN = /\S[ \t]{1,64}login(?![A-Za-z0-9_-])/i, P_FLAG = /(?<!\S)-p/, P_GLUED = /(?<!\S)-p[^\s-]/;
const MYSQL_WORD = /(?<![A-Za-z0-9_])(?:mysql|mariadb)/i, SSHPASS_WORD = /(?<![A-Za-z0-9_])sshpass(?![A-Za-z0-9_])/i;
const OPENSSL_WORD = /(?<![A-Za-z0-9_])openssl(?![A-Za-z0-9_])/i, OPENSSL_FLAG = /(?<!\S)-(?:k|pass)(?![A-Za-z0-9_-])/i;
// 4. A URL's userinfo, whatever its host looks like; a Go DSN's user:pass@tcp( or @unix(.
const URL_USER = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@/i, GO_DSN = /(?<=:[^\s@]{0,256})@(?:tcp|unix)\(/i;
// 5. A page snapshot's text field with a value: textbox or searchbox, then [ref=...] and a colon, then a value, anywhere
// on the line (a Read's or a Grep's gutter before it).
const SNAP_BOX = /(?<![A-Za-z0-9_])(?:textbox|searchbox)(?![A-Za-z0-9_])/i;
const SNAP_VALUE = /\[ref=[^\]\s]{1,64}\](?:[ \t]{0,64}\[[^\]\n]{0,256}\]){0,16}:[ \t]{0,64}\S/;
// Auth as a camelCase end in a field (basicAuth:, proxyAuth =); a quoted name as a call's first argument
// (define('DB_PASS', ...), os.Setenv("DB_PWD", ...)) or as a subscript being assigned (os.environ["DB_PASS"] =), read
// by the field rules as name=; and a tool's own password flag: zip, unzip, sqlcmd, bcp, osql or isql -P, 7z -p glued,
// redis-cli -a, the mongo tools' -p, net use /user:, smbclient and its kin -U user%pass, ssh-keygen -N.
const CAMEL_AUTH = /[a-z0-9]Auth(?![A-Za-z0-9_])["'`]?[ \t]{0,64}(?:=>|[:=])/, CAMEL_AUTH_END = /[a-z0-9]Auth$/;
const ARG_NAME = /\([ \t]{0,64}(["'`])([A-Za-z0-9_.-]{1,64})\1[ \t]{0,64},|\[[ \t]{0,64}(["'`])([A-Za-z0-9_.-]{1,64})\3[ \t]{0,64}\][ \t]{0,64}(?:=>|[:=])/g;
const fieldLine = (l) => PIN_FIELD.test(l) || SIG_FIELD.test(l) || DSN_NAME.test(l) || PW_FIELD.test(l) || PASS_CAPS.test(l) || PW_CAMEL_FIELD.test(l) || CAMEL_AUTH.test(l);
function argField(l) {
  ARG_NAME.lastIndex = 0;
  for (let m; (m = ARG_NAME.exec(l)); ) if (fieldLine((m[2] || m[4]) + "=")) return true;
  return false;
}
const toolWord = (w) => new RegExp("(?<![A-Za-z0-9_-])(?:" + w + ")(?![A-Za-z0-9_-])", "i");
const TOOL_PW = [[toolWord("zip|unzip|sqlcmd|bcp|osql|isql"), /(?<!\S)-P/], [toolWord("7z|7za|7zr"), /(?<!\S)-p\S/], [toolWord("redis-cli"), /(?<!\S)-a(?![A-Za-z0-9_-])/],
  [toolWord("mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport"), /(?<!\S)-p(?![A-Za-z0-9_-])/], [/(?<![A-Za-z0-9_-])net[ \t]{1,64}use(?![A-Za-z0-9_-])/i, /\/user:/i],
  [toolWord("smbclient|rpcclient|smbmap|smbget"), /(?<!\S)-U[ \t]{0,64}\S{1,256}%|--user=\S{1,256}%/], [toolWord("ssh-keygen"), /(?<!\S)-N(?![A-Za-z0-9_-])/]];
const toolPw = (l) => TOOL_PW.some(([t, f]) => t.test(l) && f.test(l));
// (6. A line a cut changed, a name's cut aside: hiddenLines.)
function secretLine(l) {
  return SECRET_WORDS.test(l) || TOKEN_WORD.test(l) || AUTH_WORD.test(l) || keyName(l) || fieldLine(l) || argField(l) || toolPw(l) || PW_FLAG.test(l) ||
    USER_FLAG.test(l) || (LOGIN.test(l) && P_FLAG.test(l)) || (MYSQL_WORD.test(l) && P_GLUED.test(l)) || (SSHPASS_WORD.test(l) && P_FLAG.test(l)) ||
    (OPENSSL_WORD.test(l) && OPENSSL_FLAG.test(l)) || URL_USER.test(l) || GO_DSN.test(l) || (SNAP_BOX.test(l) && SNAP_VALUE.test(l));
}
// The lines that belong to a secret line: the next one when it ends (trimmed) in :, = or =>, an open bracket, a YAML
// block indicator or a line continuation; a quoted value it leaves open, to the line that closes it; the deeper-indented
// lines after it, to the first indented the same or less (a blank line does not stop them), at most 200 (a
// service account's JSON or a long YAML block runs past 50); a quoted value at most 50. And a key block, BEGIN to
// END: an END with no BEGIN before it hides from the top, a BEGIN with no END to the bottom. Indent is read past a
// Read's or a Grep's gutter.
// > and | open the next line only as YAML's block indicator (after a space or a colon,
// with its chomping and indent marks), so markup's > and a shell's pipe chain no more lines.
const OPENS = /(?:[:=([{\\`^]|=>|(?:^|[\s:])[|>][+-]?[0-9]?)$/, BELONG = 50, DEEPER = 200;
// A fenced block's line; a heredoc a line opens (<<EOF, <<-EOS, <<~EOS,
// <<<'EOT', its tag quoted or not, a redirect or a ; after it); an XML element a line opens and leaves open; a SQL
// statement's head (INSERT, REPLACE or MERGE INTO, UPSERT, UPDATE name SET) and end (a ;, a -- comment after it); a
// Kubernetes Secret's kind line and a YAML document's separator.
const FENCE = /^(?:`{3}|~{3})/, TAG_END = /[;,)]{1,16}$/;
const HEREDOC = /<<<?[-~]?[ \t]{0,64}(["']?)([A-Za-z_][A-Za-z0-9_]{0,64})\1[ \t]{0,64}(?:[;)|&>].{0,256})?$/;
const XML_OPEN = /^<([A-Za-z_][A-Za-z0-9_:.-]{0,64})(?:[ \t][^<>{}]{0,256})?>[^<{}]{0,4096}$/;
const SQL_HEAD = /(?<![A-Za-z0-9_])(?:insert[ \t]{1,64}into|replace[ \t]{1,64}into|merge[ \t]{1,64}into|upsert|update[ \t]{1,64}[A-Za-z_"][A-Za-z0-9_."]{0,128}[ \t]{0,64}(?:set(?![A-Za-z0-9_])|$))(?![A-Za-z0-9_])/i;
const SQL_END = /;[ \t]{0,64}(?:--[\s\S]*)?$/, K8S_SECRET = /^kind:[ \t]{0,64}["']?Secret["']?$/, DOC_SEP = /^---(?:[ \t]|$)/;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{1,64}-----/i, PEM_END = /-----END [A-Z0-9 ]{1,64}-----/i;
const READ_GUTTER = new RegExp("^[ \\t]{0,16}\\d{1,9}(?:\\t|" + ch(0x2192) + ")"), GREP_GUTTER = /^(?:[A-Za-z]:)?[^\s:][^\n:]{0,255}?[:-]\d{1,9}[:-]/;
const WORDISH = /[A-Za-z0-9_]/, CRS = /\r/g, CRLF = /\r\n/g, TABS = /\t/g;
function shapeOf(l) {
  const g = READ_GUTTER.exec(l) || GREP_GUTTER.exec(l);
  return shapeAt(g ? l.slice(g[0].length) : l);
}
function shapeAt(t) {
  let w = 0;
  for (let j = 0; j < t.length && (t[j] === " " || t[j] === "\t"); j++) w += t[j] === "\t" ? 2 : 1;
  return { indent: w, blank: !t.trim() };
}
// the quote a line leaves open, read from quote q ("" for none): a backslash escapes the next character, an apostrophe
// opens a quote only where no word runs into it (don't), and a backtick that ends the line continues it instead. The
// reading stops at a comment (// anywhere, # at the line's start or after a space), skips a regex literal, and a
// backtick that ends the line opens a quote after = ( , : ? [ {, =>, return or a word (a tagged template).
function quoteAfter(l, q) {
  const end = l.trimEnd().length - 1;
  let prev = "", rx = true;
  for (let j = 0; j < l.length; j++) {
    const c = l[j];
    if (c === "\\") { j++; continue; }
    if (q) { if (c === q) { q = ""; prev = c; } continue; }
    if (c === "/" && l[j + 1] === "/") break;
    if (c === "#" && (j === 0 || l[j - 1] === " " || l[j - 1] === "\t")) break;
    if (c === "/" && rx) { const e = regexEnd(l, j, prev); if (e > 0) { j = e; prev = c; continue; } if (REGEX_AFTER.has(prev)) rx = false; }
    if (c === "`" && j === end) { if (tickOpens(l.slice(0, j))) q = c; continue; }
    if (c === '"' || c === "`" || (c === "'" && !(j > 0 && WORDISH.test(l[j - 1])))) q = c;
    if (c !== " " && c !== "\t") prev = c;
  }
  return q;
}
const TICK_AFTER = /(?:[=(,:?[{]|=>|(?<![A-Za-z0-9_$])return)$/;
const tickOpens = (before) => /[A-Za-z0-9_$]$/.test(before) || TICK_AFTER.test(before.trimEnd().slice(-7));
// Where a regex literal that opens at t[j] ends. A / after = ( , or : (spaces aside), not // or /*, opens
// one; it ends at the next / that no backslash escapes and no [...] class holds. -1 when none opens there or it does not
// end on the line (the caller then stops looking for one, so a line is read once).
const REGEX_AFTER = new Set(["=", "(", ",", ":"]);
function regexEnd(t, j, prev) {
  if (t[j] !== "/" || t[j + 1] === "/" || t[j + 1] === "*" || !REGEX_AFTER.has(prev)) return -1;
  let cls = false;
  for (let e = j + 1; e < t.length; e++) {
    const c = t[e];
    if (c === "\\") e++;
    else if (cls) { if (c === "]") cls = false; }
    else if (c === "[") cls = true;
    else if (c === "/") return e;
  }
  return -1;
}
// The deeper-indented lines belong only to a key line (a key, then : or =, as YAML, JSON, INI or an
// assignment to a name writes it: password: |, "credentials": {, password: a with its plain value's next lines); a code
// line (describe("token handling", () => {, function getToken() {, if (token) {) hides itself. And a value field (value,
// Value, secretValue, val, ParameterValue) beside a name field (name, Name, key, Key, ParameterKey, ParameterName) that
// names a secret, in the same object: at the name's key column, back to the object's opening line and on to a line
// indented less or a new list item there (both ways), at most 50 lines (an ECS or k8s env entry, a
// CloudFormation parameter).
const KEY_START = /^(?:-[ \t]{1,64})?["']?[A-Za-z0-9_.-]{1,256}["']?[ \t]{0,64}[:=]/;
const NAME_FIELD = /^(-[ \t]{1,64})?["']?(?:name|Name|key|Key|ParameterKey|ParameterName)["']?[ \t]{0,64}[:=][ \t]{0,64}["']?([^"'\s,}]{1,256})/;
const VALUE_FIELD = /^["']?(?:value|Value|secretValue|val|ParameterValue)["']?[ \t]{0,64}[:=]/;
const PW_END = /(?:^|[^A-Za-z0-9])(?:pass|pwd|pw)$/i, PW_OWNED_END = new RegExp(PW_OWNED + "$");
const namesSecret = (v) => secretLine(v) || PW_END.test(v) || PW_OWNED_END.test(v);
const LIST_ITEM = /^-[ \t]{1,64}/;
// a line's text past a Read's or a Grep's gutter; and trimmed
const gutterless = (l) => { const g = READ_GUTTER.exec(l) || GREP_GUTTER.exec(l); return (g ? l.slice(g[0].length) : l).replace(CRS, ""); };
// An expression's lines. A hidden line that leaves a bracket open (its strings and comments aside) hides the
// lines to the close of its innermost one, at most 200 on, when that bracket is ( or [, or a { that opens an expression.
// A { opens a code block when the text before it ends in ) or =>, in else, try, do or finally, in a class, interface,
// enum or namespace header, or in a function's return type (): T or ) -> T); any other { opens an expression (after =,
// :, (, a comma, return). A code block's { no longer hides the next line either: that line is a statement. And a
// continuation: the next line when it starts with ? : . + || && or ?? (a + at column 0 is a diff's mark, ... a spread),
// or when the line ends in + || && ?? or ? (not ++); a trailing comma ends it.
const BLOCK_HEAD = /(?:\)|=>|(?<![A-Za-z0-9_$])(?:else|try|do|finally))[ \t]{0,64}$|(?<![A-Za-z0-9_$])(?:class|interface|enum|namespace)(?![A-Za-z0-9_$"'])[^{}=;]{0,256}$|\)[ \t]{0,64}(?::|->)[ \t]{0,64}[A-Za-z_$][^(){};=]{0,256}$/;
const blockBrace = (before) => BLOCK_HEAD.test(before.slice(-300));
// A Go or Rust function's header (func, fn or pub fn at the line's start) whose line ends in { opens a code
// block too, whatever its return type. b is a line's trimmed text, at the place of a { in it.
const GO_RUST = /^(?:func|fn|pub[ \t]{1,64}fn)[ \t]/;
// So does a control head (if, for, switch, match, while, elif or else at the line's start, as Go, Rust and Python write
// them) whose line ends in { or, for Python, in :
const CTRL_HEAD = /^(?:(?:if|for|switch|match|while|elif)[ \t(]|else(?![A-Za-z0-9_$]))/;
const opensBlock = (b, at) => (at === b.length - 1 && (GO_RUST.test(b) || CTRL_HEAD.test(b))) || blockBrace(b.slice(0, at));
const COMMENT_LINE = /^(?:\/\/|#)/;
const CONT_START = /^[ \t]{0,256}(?:\?|:|\.(?!\.)|\|\||&&)|^[ \t]{1,256}\+(?!\+)/, CONT_END = /(?:(?<!\+)\+|\|\||&&|\?)$/;
// a line's brackets, its strings and comments aside: where those still open at its end sit, its net change, and the
// lowest it dips below its start (a close of a bracket an earlier line opened)
function bracketsOf(t) {
  const open = [];
  let net = 0, low = 0, q = "", prev = "", rx = true;
  for (let j = 0; j < t.length; j++) {
    const c = t[j];
    if (q) { if (c === "\\") j++; else if (c === q) { q = ""; prev = c; } continue; }
    if (c === "/" && t[j + 1] === "/") break;
    if (c === "/" && t[j + 1] === "*") { const e = t.indexOf("*/", j + 2); if (e < 0) break; j = e + 1; continue; }
    if (c === "#" && (j === 0 || t[j - 1] === " " || t[j - 1] === "\t")) break;
    // A regex literal's brackets and quotes are its own (/authorization["\s:=]+/)
    if (c === "/" && rx) { const e = regexEnd(t, j, prev); if (e > 0) { j = e; prev = c; continue; } if (REGEX_AFTER.has(prev)) rx = false; }
    if (c === '"' || c === "`" || (c === "'" && !(j > 0 && WORDISH.test(t[j - 1])))) q = c;
    else if (c === "(" || c === "[" || c === "{") { open.push(j); net++; }
    else if (c === ")" || c === "]" || c === "}") { open.pop(); if (--net < low) low = net; }
    if (c !== " " && c !== "\t") prev = c;
  }
  return { open, net, low };
}
// raw: a text's lines; shapes: the same lines through the cuts but the name cuts (a name decides a line by
// the words above, a value's shape by the cuts). True for each line to hide. numbered: the lines are a
// Grep's of one file, each behind its number's gutter (4: or 5-), which is read past as a Read's is.
function hiddenLines(raw, shapes, numbered) {
  const n = raw.length, hide = new Array(n).fill(false);
  if (shapes.length !== n) return hide.fill(true); // the cuts keep every line; were they ever not to, nothing shows
  const primary = raw.map((l, i) => l !== shapes[i] || secretLine(l.replace(CRS, "")));
  let from = -1;
  for (let i = 0; i < n; i++) {
    if (from < 0 && PEM_BEGIN.test(raw[i])) from = i;
    if (PEM_END.test(raw[i])) { hide.fill(true, from < 0 ? 0 : from, i + 1); from = -1; }
  }
  if (from >= 0) hide.fill(true, from);
  const body = numbered ? raw.map((l) => l.replace(NUM_GUTTER, "")) : raw;
  const S = body.map(shapeOf), G = body.map(gutterless), B = G.map((g) => g.trim());
  for (let i = 0; i < n; i++) {
    const m = NAME_FIELD.exec(B[i]);
    if (!m || !namesSecret(m[2])) continue;
    const col = S[i].indent + (m[1] ? shapeAt(m[1].slice(1)).indent + 1 : 0);
    for (let k = i + 1; k < n && k <= i + BELONG; k++) {
      if (S[k].blank || S[k].indent > col) continue;
      if (S[k].indent < col || B[k][0] === "-") break;
      if (VALUE_FIELD.test(B[k])) primary[k] = true;
    }
    if (m[1]) continue; // a list item's first key: nothing of its object comes before it
    for (let k = i - 1; k >= 0 && k >= i - BELONG; k--) {
      if (S[k].blank || S[k].indent > col) continue;
      const d = LIST_ITEM.exec(B[k]); // the list item this key belongs to: its first key
      if (d && S[k].indent + shapeAt(d[0].slice(1)).indent + 1 === col) { if (VALUE_FIELD.test(B[k].slice(d[0].length))) primary[k] = true; break; }
      if (S[k].indent < col || d) break;
      if (VALUE_FIELD.test(B[k])) primary[k] = true;
    }
  }
  // A SQL statement a secret line is part of, from its head (INSERT INTO, UPDATE t SET and
  // the like) to the line that ends in ;, no blank line between, at most 50 lines; the values a row of VALUES or a SET
  // line holds have their secret column's name on another line
  for (let i = 0, head = -1, done = -1; i < n; i++) {
    if (S[i].blank) { head = -1; continue; }
    if (SQL_HEAD.test(B[i])) head = i;
    if (head >= 0 && head !== done && primary[i] && i - head <= BELONG) {
      done = head;
      for (let k = head; k < n && k <= head + BELONG && !S[k].blank; k++) { hide[k] = true; if (SQL_END.test(B[k])) break; }
    }
    if (SQL_END.test(B[i])) head = -1;
  }
  // A Kubernetes Secret (kind: Secret at indent 0) hides its whole YAML document, from the
  // --- before it to the --- after it, at most 200 lines each way: every value under its data is a secret
  for (let i = 0; i < n; i++) {
    if (S[i].indent || !K8S_SECRET.test(B[i])) continue;
    let s = i, e = i;
    while (s > 0 && s > i - DEEPER && !DOC_SEP.test(B[s - 1])) s--;
    while (e + 1 < n && e < i + DEEPER && !DOC_SEP.test(B[e + 1])) e++;
    hide.fill(true, s, e + 1);
  }
  for (let i = 0; i < n; i++) {
    if (!primary[i]) continue;
    hide[i] = true;
    if (!KEY_START.test(B[i])) continue;
    // A key that ends in : owns a list written flush with it (- item at its own indent)
    const flush = B[i].endsWith(":");
    for (let k = i + 1; k < n && k <= i + DEEPER; k++) {
      if (S[k].blank) continue;
      if (S[k].indent < S[i].indent || (S[k].indent === S[i].indent && !(flush && LIST_ITEM.test(B[k])))) break;
      hide[k] = true;
    }
  }
  const scans = new Array(n), scanOf = (k) => scans[k] || (scans[k] = bracketsOf(B[k]));
  // The lines line i's innermost open bracket spans, when it opens an expression
  // When that bracket closes, line i's next bracket out that is still open carries the span on by the same
  // test, until a bracket that opens a code block or none is left
  const span = (i) => {
    const { open } = scanOf(i), expr = (d) => d > 0 && !(B[i][open[d - 1]] === "{" && opensBlock(B[i], open[d - 1]));
    let target = open.length, depth = target;
    if (!expr(target)) return;
    for (let j = i + 1; j < n && j <= i + DEEPER; j++) {
      hide[j] = true;
      const t = scanOf(j), low = depth + t.low;
      if (low < target) { if (!expr(low)) break; target = low; }
      depth += t.net;
    }
  };
  // Hides the lines after line k to the first that isEnd takes, at most max of them; the last one hidden
  const hideTo = (k, max, isEnd) => {
    let f = k + 1;
    for (; f < n && f <= k + max; f++) { hide[f] = true; if (isEnd(B[f])) return f; }
    return f - 1;
  };
  for (let i = 0; i < n; i++) {
    if (!hide[i]) continue;
    let q = quoteAfter(raw[i], ""), k = i;
    while (q && k + 1 < n && k < i + BELONG) { hide[++k] = true; q = quoteAfter(raw[k], q); }
    if (k === i) span(i);
    // A heredoc line k opens hides to its tag, at most 200 lines; an XML element it opens
    // and leaves open, to its close, at most 50, when its tag names a secret (<privateKey>, never a <div>)
    const hd = HEREDOC.exec(B[k]), xt = hd ? null : XML_OPEN.exec(B[k]);
    if (hd) k = hideTo(k, DEEPER, (b) => b.replace(TAG_END, "") === hd[2]);
    else if (xt && namesSecret(xt[1])) k = hideTo(k, BELONG, (b) => b.includes("</" + xt[1] + ">"));
    const end = raw[k].trimEnd(), b = B[k];
    // a code block's head opens no value: a { after one, and a Python control head's :
    const block = (b.endsWith("{") && opensBlock(b, b.length - 1)) || (b.endsWith(":") && CTRL_HEAD.test(b));
    let last = k;
    if (k + 1 < n && OPENS.test(end) && !block) {
      let m = k + 1;
      hide[m] = true;
      // A prose label (not a key line) ending in : keeps hiding through up to two blank
      // lines to its value; and a fenced block the next line opens hides to its close, at most 50 lines
      if (!KEY_START.test(b) && b.endsWith(":")) while (m + 1 < n && m <= k + 2 && S[m].blank) hide[++m] = true;
      if (FENCE.test(B[m])) last = hideTo(m, BELONG, (x) => FENCE.test(x));
    }
    // a continuation; comment-only lines before it are skipped, and hidden with it
    if (k + 1 < n && CONT_END.test(b)) hide[k + 1] = true;
    else if (k + 1 < n) {
      let c = k + 1;
      while (c < n && c <= k + BELONG && COMMENT_LINE.test(B[c])) c++;
      if (c < n && CONT_START.test(G[c])) hide.fill(true, k + 1, c + 1);
    }
    i = last; // the lines inside a quoted value, a heredoc, an element or a fenced block are not read again
  }
  return hide;
}
// ---------- A value whose name the screen cannot see ----------
// A config file's line shows only when its ancestry does: its parent line (the nearest earlier line indented less) is in
// the text the screen sees, and that line's parent, up to indent 0. A Read window from line 1 is unchanged; anything
// else (a later window, an edit's old or new text, a Grep's lines) can start inside a block whose name it cuts off.
// Config files go by name: YAML's only, .yml and .yaml (docker-compose files among them), where a value
// can sit on lines of its own under its key; JSON, TOML, INI, XML, HCL, properties and plist keep a value on its key's
// line, so a line there with no ancestry in the window is no orphan value (the secret files keep their own rule).
const CONFIG_BASE = /^(?:.{0,256}\.ya?ml|docker-compose.{0,256})$/i;
function configFile(p) {
  const f = slash(String(p || ""));
  return CONFIG_BASE.test(f.slice(f.lastIndexOf("/") + 1));
}
const READ_NUM = new RegExp("^[ \\t]{0,16}(\\d{1,9})(?:\\t|" + ch(0x2192) + ")");
// a Grep's line: path, then : (a match) or - (context), its line number and the same mark; or, without numbers, path and
// a colon; or, from a Grep of one file, the number alone
const GREP_LINE = /^((?:[A-Za-z]:)?[^\s:][^\n:]{0,255}?)([:-])(\d{1,9})\2/, GREP_NONUM = /^((?:[A-Za-z]:)?[^\s:][^\n:]{0,255}?):/, NUM_GUTTER = /^(\d{1,9})([:-])/;
// marks in out the lines of one window (idx, in order) with no ancestry in it
function orphans(S, idx, out) {
  const stack = [];
  for (const i of idx) {
    if (S[i].blank) continue;
    const d = S[i].indent;
    while (stack.length && stack[stack.length - 1].d >= d) stack.pop();
    const ok = d === 0 || (stack.length > 0 && stack[stack.length - 1].ok);
    stack.push({ d, ok });
    if (!ok) out[i] = true;
  }
}
// The lines a screen's context hides besides the secret lines: every line of a command's output when the command is a
// secret line or names a secret file (all); a config file's lines with no ancestry (config: a Read or an edit's text;
// grep: a Grep's lines, the runs of one file's consecutive line numbers as windows, grepFile when it searched one config
// file); fragment, the text's first line is a long line's kept end (a shell's tail cut
// into it), which can start inside a secret's name, so it is hidden; and a Grep's line from a secrets file is hidden,
// as a Read of that file is.
function contextHidden(raw, opt) {
  const n = raw.length, out = new Array(n).fill(false);
  if (opt.all) return out.fill(true);
  if (opt.fragment && n) out[0] = true;
  if (opt.config) {
    const first = raw.find((l) => l.trim()), g = first != null ? READ_NUM.exec(first) : null;
    if (!(g && +g[1] === 1)) orphans(raw.map(shapeOf), raw.map((_, i) => i), out);
  }
  if (opt.grep) {
    const S = new Array(n), idx = [];
    let prev = null;
    const flush = () => { if (idx.length) orphans(S, idx, out); idx.length = 0; };
    for (let i = 0; i < n; i++) {
      const l = raw[i], sf = GREP_LINE.exec(l) || GREP_NONUM.exec(l);
      if (sf && secretFile(sf[1])) out[i] = true;
      let m = opt.grepFile ? NUM_GUTTER.exec(l) : null, path = m ? "" : null, num = m ? +m[1] : NaN, g = m ? m[0].length : 0;
      if (path == null && (m = GREP_LINE.exec(l)) && configFile(m[1])) { path = m[1]; num = +m[3]; g = m[0].length; }
      else if (path == null && (m = GREP_NONUM.exec(l)) && configFile(m[1])) { path = m[1]; g = m[0].length; }
      else if (path == null && opt.grepFile && l !== "--") path = "";
      if (path == null) { flush(); prev = null; continue; }
      if (!prev || prev.path !== path || num !== prev.num + 1) flush();
      S[i] = shapeAt(l.slice(g));
      idx.push(i);
      prev = { path, num };
    }
    flush();
  }
  return out;
}

// A screen's text as rows, { line, key, hidden }. The line is what shows: the cuts made on the whole text (a key block
// spans lines), a line rewritten in place by carriage returns read as it ended, tabs as two spaces, hidden characters
// dropped, and a secret line, or one that belongs to it, a bar its length. The key is the line as it showed before
// anything was hidden, which an edit's diff matches old and new lines by; it never leaves the server. opt, when
// given, is the screen's context (contextHidden).
function screenRows(s, opt) {
  if (typeof s !== "string" || !s) return [];
  const plain = soft(s), lines = (t) => t.replace(CRLF, "\n").split("\n"), shown = (l) => l.slice(l.lastIndexOf("\r") + 1).replace(TABS, "  ").replace(HIDDEN, "").trimEnd();
  // every Grep's lines are read past a bare number's gutter (4: or 5-), which only a Grep of one
  // file prints, whatever the file's type; a folder's lines start with their path
  const both = cutBoth(plain), raw = lines(plain), cut = lines(both.full), hide = hiddenLines(raw, lines(both.shapes), !!(opt && opt.grep));
  if (cut.length !== raw.length) hide.fill(true);
  if (opt) contextHidden(raw, opt).forEach((h, i) => { if (h) hide[i] = true; });
  const rows = raw.map((r, i) => {
    const key = shown(r);
    if (!hide[i]) return { line: shown(cut[i]), key, hidden: false };
    const indent = key.length - key.trimStart().length;
    return { line: indent < key.length ? barLine(indent, [...key].length - indent) : "", key, hidden: true };
  });
  while (rows.length && !rows[rows.length - 1].line) rows.pop();
  return rows;
}
// A screen's text as the lines it shows.
function screenLines(s, opt) {
  return screenRows(s, opt).map((r) => r.line);
}

// every regex (or the function running it) the screens' text passes through, by name, for the timing test
// (test/screen-time.test.mjs)
const SCREEN_RES = {
  ...Object.fromEntries(Object.entries(CUT).map(([k, [re]]) => [k, re])), curlFlag: CURL_FLAG, mysqlFlag: MYSQL_FLAG, passFlag: PASS_FLAG,
  namedScan: NAMED, named: cutNamed, secretName, valueRest: VALUE_REST, urlValue: URL_VALUE, envLine: ENV_LINE,
  awsSecret: AWS_SECRET, keyLine: KEY_LINE, keylike: KEYLIKE, ansi: ANSI, hidden: HIDDEN, hiddenSoft: HIDDEN_SOFT, escs: ESCS, secretBase: SECRET_BASE,
  secretDir: SECRET_DIR, secretFile,
  // The line rule, the lines that belong to a secret line, and the bar
  secretWords: SECRET_WORDS, dsnName: DSN_NAME, pwField: PW_FIELD, pwCamel: PW_CAMEL_FIELD, pwFlag: PW_FLAG, userFlag: USER_FLAG,
  login: LOGIN, pFlag: P_FLAG, pGlued: P_GLUED, mysqlWord: MYSQL_WORD, sshpassWord: SSHPASS_WORD, opensslWord: OPENSSL_WORD, opensslFlag: OPENSSL_FLAG,
  urlUser: URL_USER, goDsn: GO_DSN, snapBox: SNAP_BOX, snapValue: SNAP_VALUE, secretLine, opens: OPENS, pemBegin: PEM_BEGIN, pemEnd: PEM_END,
  readGutter: READ_GUTTER, grepGutter: GREP_GUTTER, shape: shapeOf, quoteAfter: (s) => quoteAfter(s, ""), barLine: BAR_LINE, screenRows,
  // Config files and a Grep's lines
  configBase: CONFIG_BASE, readNum: READ_NUM, grepLine: GREP_LINE, grepNoNum: GREP_NONUM, numGutter: NUM_GUTTER,
  configRows: (s) => screenRows(s, { config: true }), grepRows: (s) => screenRows(s, { grep: true }), grepFileRows: (s) => screenRows(s, { grep: true, grepFile: true }),
  // Token and auth, PASS in capitals and the owner words, a key line, the sibling value rule, the two-way cut
  tokenWord: TOKEN_WORD, authWord: AUTH_WORD, passCaps: PASS_CAPS, keyStart: KEY_START, nameField: NAME_FIELD, valueField: VALUE_FIELD, pwEnd: PW_END,
  pwOwnedEnd: PW_OWNED_END, namesSecret, cutBoth,
  // One vocabulary for the name cut, the sibling rule both ways, an expression's span, a continuation
  dsnEnd: DSN_END, eqSep: EQ_SEP, listItem: LIST_ITEM, gutterless, blockHead: BLOCK_HEAD, blockBrace, contStart: CONT_START, contEnd: CONT_END, brackets: bracketsOf,
  // A key name, a pin code and a signature field, a Go or Rust header
  keyNameRe: KEY_NAME, keyName, pinField: PIN_FIELD, pinEnd: PIN_END, sigField: SIG_FIELD, sigEnd: SIG_END, goRust: GO_RUST, opensBlock,
  // CamelCase auth, a quoted name as an argument or subscript, a tool's password flag, a block's head, a
  // comment line, a fence, a heredoc, an XML element, a SQL statement, a Kubernetes Secret, a tagged template, a regex
  camelAuth: CAMEL_AUTH, camelAuthEnd: CAMEL_AUTH_END, argName: ARG_NAME, argField, fieldLine, toolPw, ctrlHead: CTRL_HEAD, commentLine: COMMENT_LINE,
  fence: FENCE, tagEnd: TAG_END, heredoc: HEREDOC, xmlOpen: XML_OPEN, sqlHead: SQL_HEAD, sqlEnd: SQL_END, k8sSecret: K8S_SECRET, docSep: DOC_SEP,
  tickAfter: TICK_AFTER, tickOpens, regexEnd: (s) => regexEnd("=/" + s, 1, "="), fragmentRows: (s) => screenRows(s, { fragment: true }),
};
Object.assign(module.exports, { cutSecrets, screenLines, screenRows, secretFile, configFile, barOf, barLine, SCREEN_RES });
