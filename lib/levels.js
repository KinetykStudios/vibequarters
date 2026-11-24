// Approval levels (approval-levels.json, the owner's list): for a permission inside an approve window, "routine" is
// approved at once, "yours" is never approved for the owner, and "judge" goes to a quick judgment (lib/judge.js). The
// file is read again whenever it changes; one that cannot be read or does not hold the expected lists makes everything
// "yours", so a typo can never approve anything.
"use strict";
const fs = require("fs");
const { neverApprove, wipesData, noComments } = require("./never-approve");

const LISTS = { routine: ["tools", "commands", "hooks"], yours: ["tools", "hooks", "hookPhrases", "words"] };

// The lists from the file's JSON, a missing list as empty, or null when any given list is not a list of strings
function shape(j) {
  if (!j || typeof j !== "object") return null;
  const out = {};
  for (const [part, keys] of Object.entries(LISTS)) {
    const src = j[part] && typeof j[part] === "object" ? j[part] : {};
    out[part] = {};
    for (const k of keys) {
      const v = src[k] === undefined ? [] : src[k];
      if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s)) return null;
      out[part][k] = v;
    }
  }
  return out;
}

// file -> { mtimeMs, size, levels }: the app's own list and the approval presets (lib/approvals.js) each keep theirs
const cache = new Map();
// The levels in file, or null; read again only when the file's time or size changed
function loadLevels(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.levels;
  let levels = null;
  try {
    levels = shape(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {}
  if (cache.size > 16) cache.clear();
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, levels });
  return levels;
}

// Routine means sure, so this reads a Bash command strictly and says no whenever it is unsure (a hand-written quote
// parser is easy to get a second command past). After the two harmless forms below are set aside, any character outside
// SAFE makes it not routine: no backslash, $, backtick, parentheses, braces, angle brackets, tab, newline or non-ASCII,
// so quotes cannot be escaped and nothing expands or runs inside a word.
const SAFE = /^[A-Za-z0-9 _\-.\/:=,@%+~^#*?\[\]"';|&]*$/;
// what writes nowhere: a stream joined to another (2>&1) or sent to /dev/null (plain spaces only: a line break there
// would hide a second command)
const HARMLESS_REDIRECT = / \d?>&\d(?= |$)| \d?> *\/dev\/null(?= |$)/g;
// the command with its plain spaces and line breaks off both ends (any other blank is a character SAFE refuses)
function trimmed(cmd) {
  let a = 0, b = cmd.length;
  while (a < b && " \n".includes(cmd[a])) a++;
  while (b > a && " \n".includes(cmd[b - 1])) b--;
  return cmd.slice(a, b);
}
// the exit-code form (cmd; rc=$?; echo "exit=$rc"; exit $rc): an assignment of $? and its reads. Only a whole statement
// (; or the ends around it: after && or || it may never run), only a name that starts lowercase or one of a few more: the
// shell gives names like _, PATH and IFS a meaning of their own. A read before its assignment is no exit code, and only
// echo and exit may read one (an unset one would vanish from the command).
const EXIT_NAME = /^(?:[a-z]\w*|RC|EC|EXIT|EXIT_CODE|STATUS|CODE|RESULT|[A-Z]+_RC)$/;
const CODE = "\u0001"; // the place of a $? in the command, a character no routine command holds
const READ = "\u0002"; // the place of the $ of a $name
const MARKS = /[\u0001\u0002]/;
// the only NAME=value prefixes kept: Git Bash's path switches and output settings, none of which runs a program. A time
// zone or locale is read from the file it names, so it is a plain name.
const PLACE = /^(?:\w[\w+.@-]*(?:\/[\w+-]+)*)?$/;
const SETTING = /^[\w*;.-]*$/;
const SAFE_ENV = new Map([["MSYS2_ARG_CONV_EXCL", SETTING], ["MSYS_NO_PATHCONV", SETTING], ["NO_COLOR", SETTING], ["FORCE_COLOR", SETTING], ["TZ", PLACE], ["LANG", PLACE], ["LC_ALL", PLACE]]);
// options that run another program or write a file, in any routine command: a second layer, as no table below holds one
const RISKY = ["--output", "--ext-diff", "--upload-pack", "--receive-pack", "--exec", "--pre", "--config-env", "--textconv", "--hostname-bin", "--test-reporter-destination"];
// A risky option, with anything after it, or, for git, any start of its name: git accepts a shortened option
// (--upload-pac=x). --text and git's --pretty are options of their own that do neither.
function riskyOption(word, git) {
  const name = word.split("=")[0].replace(/_/g, "-"); // node takes _ for - in an option
  if (git && name === "--pretty") return false;
  return RISKY.some((r) => name.startsWith(r) || (git && name.length > 2 && name !== "--text" && r.startsWith(name)));
}

// The parts of a command split at ; | || && outside quotes, each { op, words } (op: what stands before it), or null for
// a single & or an unclosed quote
function split(cmd) {
  const out = [{ op: "", words: [] }];
  let word = null;
  let q = null;
  const end = () => { if (word !== null) out[out.length - 1].words.push(word); word = null; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; word = (word || "") + c; continue; }
    if (c === " ") { end(); continue; }
    if (c === ";" || c === "|" || c === "&") {
      if (c === "&" && cmd[i + 1] !== "&") return null;
      const twice = c !== ";" && cmd[i + 1] === c;
      if (twice) i++;
      end();
      out.push({ op: twice ? c + c : c, words: [] });
      continue;
    }
    word = (word || "") + c;
  }
  if (q) return null;
  end();
  return out;
}
// a word as the program gets it, and what of it the shell may still expand
const exact = (w) => w.replace(/'([^']*)'|"([^"]*)"/g, (m, a, b) => (a === undefined ? b : a));
const outsideQuotes = (w) => w.replace(/'[^']*'|"[^"]*"/g, "");
const isGlob = (s) => /[*?[{]/.test(s);

// Secrets files. A plain read of one is never routine, so the judge (which leaves it for the owner) sees it. This is a speed
// bump for the plain forms, not a wall: routine already runs code a session wrote (node --test, npm test), so a
// session set on getting around a name check can. A secrets file's name: .env and .env.<name> (not a template:
// example, sample, template, dist, defaults), .dev.vars, .npmrc, .netrc/_netrc, .pypirc, .git-credentials,
// .credentials.json, .envrc, secret(s).yml, a kubeconfig, a private SSH key named id_*, the logins gcloud, Vault, Postgres,
// MySQL, Azure, Terraform, s3cmd, boto and Claude Code keep, a shell's history, a service account's .json, a key store
// (.pem, .key, .p12 and the like), Terraform state, a name that says it (prod.env, x-token, x-secret.txt), or a backup of
// any of these; plus a file in a hidden folder's secrets/, .aws/credentials, .docker/config.json, .kube/config*, .cargo and .gem credentials, GitHub CLI's
// hosts.yml, /proc/<pid>/environ, /dev/clipboard and any file under .ssh but a public key, config, known_hosts or
// authorized_keys. Every test here is linear: no pattern built from the call.
const SECRET_NAME = /^(?:\.env(?:[.-][\w.-]*)?|[\w-][\w.-]*\.env|[\w.-]*[-_.](?:token|secret)(?:\.txt)?|(?:tokens?|secrets?|passwords?|api[-_]?keys?)\.txt|api[-_]?key|credentials\.json|client_secret[\w.-]*\.json|\.envrc|secrets?\.(?:ya?ml|json|toml)|\.secrets|secring\.gpg|kubeconfig|[\w.-]+\.kubeconfig|\.dockercfg|\.dev\.vars|[._]netrc|\.npmrc|\.pypirc|\.git-credentials|\.credentials\.json|application_default_credentials\.json|credentials\.db|access_tokens\.db|\.vault-token|\.pgpass|pgpass\.conf|\.my\.cnf|\.mylogin\.cnf|accesstokens\.json|msal_token_cache\.[\w.]+|credentials\.tfrc\.json|\.s3cfg|\.boto|\.claude\.json(?:\.[\w-]+)*|\.[a-z]+(?:_[a-z]+)?_history|fish_history|consolehost_history\.txt|\.histfile|id_(?:rsa|ed25519|ecdsa|dsa)[\w.-]*)$/i;
const KEY_STORE = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".kdbx", ".tfstate", ".tfstate.backup"];
const TEMPLATE = new Set(["example", "sample", "template", "dist", "defaults"]);
const SSH_PUBLIC = /^(?:[^/]+\.pub|config|known_hosts[^/]*|authorized_keys)$/i;
// a wildcard near one of these words may reach a secrets file
const SECRET_WORD = /env|pem|key|netrc|_net|npmrc|pypirc|credential|id_|ssh|aws|dev\.vars|secret|kube|docker|hosts|vault-t|pgpass|my\.cnf|mylogin|\.azure|gcloud|accesst|access_t|msal_token|tfst|tfrc|\.s3cfg|\.boto|_hist|histfile|^[/\\]dev[/\\]|\.cargo|\.gem\b|service[-_]?account|\.(?:p12|pfx|jks|keystore|ppk|kdbx)|[/\\]gh[/\\]|github cli|[-_.]tok|access-t|client_s|password|com\.vercel|\.supabase|\.codex/i;

// a plain path (quotes out, slashes forward, a drive letter, ./ and Windows' dropped trailing dots or spaces set aside)
function trimEnd(s) {
  let e = s.length;
  while (e && (s[e - 1] === "." || s[e - 1] === " ")) e--;
  return s.slice(0, e);
}
// a file's name without a backup's ending (.npmrc.bak, .env~)
function noBackup(s) {
  let e = s.length;
  for (let m; (m = /(?:~|\.(?:bak|old|orig|backup|save|swp|copy|\d{1,3}))$/i.exec(s.slice(Math.max(0, e - 8), e)));) e -= m[0].length;
  return s.slice(0, e) || s;
}
// searched: the path is searched whole (grep, rg, the Grep tool), so a folder that holds only secrets counts too
function literalSecret(p, searched = false) {
  const segs = p.replace(/["']/g, "").replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").split("/")
    .filter((s) => s && s !== ".").map((s) => (s === ".." ? s : trimEnd(s) || (s.startsWith("..") ? ".." : ""))).filter(Boolean);
  if (!segs.includes("..")) return secretName(segs, searched);
  const flat = []; // read both ways: as written, and with each .. taking back the folder before it
  for (const s of segs) if (s === ".." && flat.length && flat[flat.length - 1] !== "..") flat.pop(); else flat.push(s);
  return secretName(segs, searched) || secretName(flat, searched);
}
function secretName(segs, searched) {
  const base = noBackup(segs[segs.length - 1] || "");
  const low = base.toLowerCase();
  const dir = (segs[segs.length - 2] || "").toLowerCase();
  if (searched && ([".ssh", ".aws", ".kube", ".docker", ".azure", ".cargo", ".gem", ".supabase", "com.vercel.cli", "github cli"].includes(low) || (low === "secrets" && dir.startsWith(".") && dir !== "..") || (low === "gh" && dir === ".config") || (low === "gcloud" && [".config", "roaming"].includes(dir)))) return true;
  if (segs.slice(0, -1).some((s) => s.toLowerCase() === ".ssh")) return !SSH_PUBLIC.test(base); // anywhere under .ssh
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.includes("legacy_credentials") || (dirs.includes(".aws") && dir === "cache") || (dirs.includes("proc") && low === "environ") || (dirs[0] === "dev" && low === "clipboard")) return true;
  if (dirs.some((s, k) => s === "secrets" && k && (/^\.[^.]/.test(dirs[k - 1]) || (k === 1 && dirs[0] === "run")))) return true;
  if ((dirs.includes(".gnupg") && dir.startsWith("private-keys")) || (dir === "gcloud" && low === "credentials") || (dir === "stripe" && low === "config.toml") || (dir === "config" && dirs.includes(".wrangler"))) return true;
  if (low === "auth.json" && dirs.some((s) => ["com.vercel.cli", ".codex", ".composer", "opencode"].includes(s))) return true;
  if (dir === ".aws" && low === "credentials") return true;
  if ((dir === ".cargo" || dir === ".gem") && low.startsWith("credentials")) return true;
  if ((dir === "gh" || dir === "github cli") && /^hosts\.ya?ml/.test(low)) return true;
  if (dir === ".docker" && low.startsWith("config.json")) return true;
  if (dir === ".kube" && low.startsWith("config")) return true;
  if (low.endsWith(".pub") || low.includes(" ")) return false;
  if (low.length > 4 && KEY_STORE.some((x) => low.endsWith(x))) return true;
  if (low.endsWith(".json") && /service[-_]?account/.test(low) && !low.split(".").some((x) => TEMPLATE.has(x))) return true;
  if (!SECRET_NAME.test(base)) return false;
  return !(/\.env|^client_secret/.test(low) && (low.split(".").some((x) => TEMPLATE.has(x)) || (low.startsWith(".env-") && TEMPLATE.has(low.slice(5)))));
}
// a wildcard that may reach a secrets file: near a secrets word, or on a dot-file name; a public key list is fine
function globSecret(g) {
  const segs = g.replace(/\\/g, "/").split("/");
  const last = segs[segs.length - 1];
  if (/\.pub$/i.test(last)) return false;
  return SECRET_WORD.test(g) || last.startsWith(".") || segs.some((s) => s.startsWith(".") && isGlob(s));
}
const SHORT_NAME = /~\d/; // a Windows short (8.3) name, which reads a file by another name
// a file on another computer (\\server\share, //server/share): opening one sends this Windows sign-in to that server
const unc = (p) => /^["']?(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(p);
// Git Bash turns a word that starts with a path, behind any option letter or punctuation, into a Windows path for git, gh,
// rg and node, and opens what is under /proc to do so: in no word, text too, but inside a folder (src/proc/x) or a sentence
const PROC = /^-.*\/proc\/|(?:^|[\W_])(?<!\w )\/proc\/|(?:^|[^a-z0-9])-[a-z0-9]\/proc\//i;
// A path that may leave this computer or reach the system's own files: // anywhere, or /proc or /dev (but /dev/null)
// from the root or after a .., named or by a wildcard
function elsewhere(p) {
  if (p.includes("//") || /^\/\?/.test(p)) return true;
  if (p === "/dev/null") return false;
  const segs = p.split("/").filter((s, k) => s !== "." || !k);
  let up = false;
  return segs.some((s, k) => {
    if (s === "..") up = true;
    if (!up && !(k === 1 && segs[0] === "")) return false;
    return /^(?:proc|dev)$/i.test(s) || (isGlob(s) && (s.includes("[") || !s.includes(".")) && k < segs.length - 1);
  });
}

// What a word may be. Each check takes the word and the part of it the shell may expand.
const is = (re) => (v, open) => re.test(v) && !isGlob(open);
const NUMBER = is(/^\d{1,9}$/);
const COUNT = is(/^[-+]?\d{1,12}[a-zA-Z]{0,3}$/); // head and tail: -n -5, -n +5, -c 1K
const NAME = is(/^\w[\w.,:+-]*$/);
const WHEN = is(/^(?:always|never|auto)$/);
// search text an option always takes as it is; other text must not look like an option
const LITERAL = (v, open) => !isGlob(open);
const TEXT = (v, open) => LITERAL(v, open) && !/^-(?! )/.test(v);
// a file or folder. reader: the command prints what is in it; search: it searches a folder whole; stdin: - is the pipe
const pathOf = ({ reader, search, stdin } = {}) => (v) => {
  if (v === "-") return !!stdin;
  if (!v || v.startsWith("-") || elsewhere(v) || SHORT_NAME.test(v) || v.replace(/^[A-Za-z]:(?=\/)/, "").includes(":")) return false;
  if (search && /^\/[.*\/]*$/.test(v)) return false; // the whole system
  if (v.split("/").some((s) => s !== "." && s !== ".." && /[. ]$/.test(s))) return false; // Windows drops these
  return !(isGlob(v) && (reader || globSecret(v))) && !literalSecret(v, search);
};
const FILE = pathOf({ reader: true, search: true });
// what a pull request shows to others: a .md or .txt file of the project or the temp folder, in no hidden folder
const TEMP = /^(?:\/c)?\/(?:(?:private\/)?tmp|var\/folders|Users\/[^/]+\/AppData\/Local\/Temp)\//i;
const BODY = (v) => {
  const p = v.replace(/^[Cc]:(?=\/)|^\.\//, "");
  return FILE(v) && !p.includes(":") && /[.](?:md|txt)$/i.test(p) && !p.split("/").some((s) => /^[.~]/.test(s)) && (!p.startsWith("/") || TEMP.test(p));
};
// git's own: a revision, a path, a revision's path (HEAD:a.js) or a pathspec (:/ :^a). A ~1 is a revision's only before --.
const gitWord = (v, open, k, ended) => {
  const at = v.split(":");
  if (!v || /^-|^[A-Za-z]:(?!\/)/.test(v) || at.length > 4 || (ended && SHORT_NAME.test(v)) || (isGlob(v) && globSecret(v))) return false;
  return at.every((s, n) => [at.slice(n).join(":"), s.replace(/^\^+/, "")].every((f) => !elsewhere(f) && !literalSecret(f)));
};
const gitPath = (v, open, k) => gitWord(v, open, k, true);
// git diff compares two files or folders outside a repository whole: a ~1 is then a revision only by a name no short name has
const REVISION = /^\^?(?:[\w.\/-]*\/)?(?:HEAD|@|main|master|dev|[\w.-]{7,})(?:[~^]\d*)*(?::[^~]*)?$/;
const diffWord = (words) => words.length < 2 || words.every(({ v }) => !literalSecret(v, true) && v.split(/\.{2,3}/).every((s) => !SHORT_NAME.test(s) || REVISION.test(s)));
// a wildcard naming the files a search reads: one for a single character is rare, and may stand for a letter of a secret's
const GLOB = (v) => !/^-|[?[]|\/\//.test(v) && !globSecret(v) && !literalSecret(v, true);
const LEFT_OUT = (v) => !v.startsWith("-");
// gh's jq may print the environment: env or $ENV, not the field .env
const JQ_ENV = /\$ENV|(^|[^.\w$])env\b/;
const JQ = (v, open) => !/^-/.test(v) && !/^\[|[*?\/]/.test(open) && !JQ_ENV.test(v);

// What runs a project's own tests or lint (node --test, npm, pnpm, yarn, bun, npx, bunx) is routine only as the listed
// command, then plain files of the project and the options below. Any other option may load code, start another
// program, write a file or leave the project (--import, --node-options, --script-shell, --prefix, --globalSetup), and a
// list of those is never complete.
const RUNS_CODE = new Set(["node", "npm", "pnpm", "yarn", "bun", "bunx", "npx"]);
const TEST_NAME = (v) => /^\w[\w .,:\/-]*$/.test(v) && !/data:|\w:\S/i.test(v); // no scheme, no drive
const WILD = /[*?]/;
// a file, folder or pattern inside the project: no .. or hidden folder, home, drive or scheme, no installed package
// (Windows drops a name's trailing dot), and no [ ], whose one character may be a dot. A wildcard stands for a whole ** of
// folders (node looks in no node_modules or hidden folder for that; n*/ would name one) or in the name of a file with an
// extension. An unquoted ** is the shell's, which looks in node_modules too.
function projectWord(w, open) {
  const segs = (w.startsWith("./") ? w.slice(2) : w).split("/");
  if (segs.length > 1 && segs[segs.length - 1] === "") segs.pop();
  if (literalSecret(w) || (isGlob(w) && globSecret(w)) || (WILD.test(open) && WILD.test(w.split("/").slice(0, -1).join("/")))) return false;
  return segs.every((s, k) => /^[\w@+*?]([\w.@+*?-]*[\w@+*?-])?$/.test(s) && s.toLowerCase() !== "node_modules"
    && (!WILD.test(s) || (k < segs.length - 1 ? s === "**" : /\.[a-z]{1,6}$/i.test(s) || /\.[*?]?[a-z]{1,3}$/i.test(s))));
}
// named as a test (a.test.js, test/a.js): node --test runs any file it is given
const testWord = (w, open) => projectWord(w, open) && w.split("/").some((s) => /(^|[._-])(tests?|specs?|e2e)([._-]|$)/i.test(s));
// a bare word could be a task's name to the script behind it
const lintWord = (w, open) => projectWord(w, open) && /[./]/.test(w);
const VITE_CONFIG = (w, open) => projectWord(w, open) && !WILD.test(w) && /^vite(st)?\.([\w-]+\.)*config\.[cm]?[jt]s$/.test(w.split("/").pop());

// The tables. flags stand alone. values take one value, after = or as the next word (a short one: the rest of its word or
// the next). eq takes one only attached. short: "cluster" when flags may share one - (-rn), "glue" when a value may follow
// its letter. like: a number standing alone (-5). plain: what any other word is. pattern: the first plain word is the
// search text, unless one of these options is there. ends: -- ends the options. strict: an unquoted wildcard that may
// become an option is refused, to the end or (openEnd) only before --. all: every word, with no options.
function table({ flags = "", values = {}, eq = {}, ...rest }) {
  const map = (o) => new Map(Object.entries(o).flatMap(([names, kind]) => names.split(" ").map((n) => [n, kind])));
  return { ...rest, flags: new Set(flags.split(" ")), values: map(values), eq: map(eq) };
}
const DIFF = {
  flags: "-p -u -s -z -a -b -w -W -R -M -C -B --patch --no-patch --raw --patch-with-stat --stat --numstat --shortstat --dirstat --summary --compact-summary --name-only --name-status --color --no-color --word-diff --color-words --color-moved --no-renames --find-renames --find-copies --check --full-index --binary --text --ignore-cr-at-eol --ignore-space-at-eol --ignore-space-change --ignore-all-space --ignore-blank-lines --function-context --exit-code --quiet --no-ext-diff --no-textconv --no-prefix --minimal --patience --histogram --abbrev --no-abbrev --relative --pickaxe-all --pickaxe-regex --submodule --ignore-submodules",
  values: { "-S -G -I --ignore-matching-lines --word-diff-regex": TEXT, "-l --inter-hunk-context --stat-width --stat-name-width --stat-count": NUMBER, "--diff-filter --diff-algorithm --ws-error-highlight": NAME },
  eq: { "-U --unified --abbrev": NUMBER, "-M -C -B --find-renames --find-copies": is(/^\d{1,3}%?$/), "--color": WHEN, "--stat": is(/^\d+(?:,\d+)*$/), "--word-diff --color-moved --dirstat --submodule --ignore-submodules": NAME, "--relative": gitPath },
  short: "glue", plain: gitWord, ends: true, openEnd: true, strict: true,
};
const LOG = table({
  ...DIFF, like: /^-\d{1,6}$/,
  flags: DIFF.flags + " -c -m -i -E -F -P -g -t --cc --oneline --graph --all --follow --decorate --no-decorate --reverse --merges --no-merges --first-parent --branches --tags --remotes --date-order --topo-order --author-date-order --left-right --left-only --right-only --cherry --cherry-pick --cherry-mark --boundary --full-history --simplify-merges --simplify-by-decoration --ancestry-path --dense --sparse --regexp-ignore-case --extended-regexp --fixed-strings --perl-regexp --invert-grep --all-match --no-walk --walk-reflogs --abbrev-commit --no-abbrev-commit --parents --children --relative-date --source --use-mailmap --notes --no-notes --no-diff-merges --pretty --not --show-pulls",
  values: { ...DIFF.values, "-n --max-count --skip": NUMBER, "--grep --author --committer --since --after --until --before --date": TEXT, "-L": gitWord },
  eq: { ...DIFF.eq, "--format --pretty": TEXT, "--decorate --no-walk --diff-merges --notes --encoding": NAME, "--branches --tags --remotes --glob --exclude --decorate-refs --decorate-refs-exclude": TEXT, "--min-parents --max-parents": NUMBER },
});
const GREP = table({
  flags: "-E -F -G -P -i -y -w -x -z -s -v -n -H -h -o -q -a -I -r -R -L -l -c -T -Z -U -u -b --extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --word-regexp --line-regexp --null-data --no-messages --invert-match --byte-offset --line-number --line-buffered --with-filename --no-filename --only-matching --quiet --silent --text --recursive --dereference-recursive --files-without-match --files-with-matches --count --initial-tab --null --binary --color --colour --version --help",
  // --inc: the one shortened name kept
  values: { "-e --regexp": LITERAL, "-f --file": FILE, "-m -A -B -C --max-count --after-context --before-context --context": NUMBER, "--include --inc": GLOB, "--exclude --exclude-dir": LEFT_OUT, "-d -D --directories --devices": is(/^(?:read|recurse|skip)$/), "--binary-files": is(/^(?:binary|text|without-match)$/), "--label": TEXT },
  eq: { "--color --colour": WHEN },
  short: "cluster", like: /^-\d{1,6}$/, plain: pathOf({ search: true, stdin: true }), pattern: ["-e", "-f", "--regexp", "--file", "--version", "--help"], ends: true,
});
const JSON_OUT = { "--json": NAME, "-q --jq": JQ, "-t --template": TEXT, "-R --repo": is(/^\w[\w.-]*\/\w[\w.-]*$/) };
const gh = (flags, values, plain) => table({ flags, values: { ...JSON_OUT, ...values }, plain: (v, open, k) => !k && plain(v, open), short: "cluster" });
const PR = is(/^(?:\d{1,9}|https:\/\/github\.com\/\w[\w.\/-]*|\w[\w.\/-]*(?::\w[\w.\/-]*)?)$/);
const RUN = is(/^\d{1,18}$/);
const NONE = () => false;
const TABLES = new Map(Object.entries({
  "git status": table({ flags: "-s -b -v -z -u -uno -uall -unormal --short --branch --porcelain --long --verbose --untracked-files --ignored --column --no-column --ahead-behind --no-ahead-behind --renames --no-renames --find-renames --show-stash --ignore-submodules", eq: { "--porcelain --untracked-files --ignored --ignore-submodules --column": NAME, "--find-renames": NUMBER }, short: "cluster", plain: gitPath, ends: true, openEnd: true, strict: true }),
  "git diff": table({ ...DIFF, flags: DIFF.flags + " --cached --staged --merge-base --base --ours --theirs --follow", check: (seen, words) => diffWord(words) }),
  "git log": LOG,
  "git show": LOG,
  "git add": table({ flags: "-A -u -n -v -N --all --no-all --update --dry-run --verbose --intent-to-add --refresh --renormalize --ignore-errors --ignore-removal --no-ignore-removal", values: { "--chmod": is(/^\+x$/) }, short: "cluster", plain: gitPath, ends: true, openEnd: true, strict: true }),
  // one that gives no message opens an editor
  "git commit": table({ flags: "-a -q -s -v -o -z --all --quiet --signoff --no-signoff --verbose --only --amend --no-edit --allow-empty --allow-empty-message --dry-run --reset-author --short --branch --porcelain --long --status --no-status", values: { "-m --message --author --date --trailer": TEXT, "-F --file": FILE, "--fixup": is(/^\w[\w.\/~^-]*$/), "--cleanup": NAME }, short: "cluster", plain: gitPath, ends: true, strict: true,
    check: (seen) => ["-m", "--message", "-F", "--file", "--no-edit", "--fixup", "--dry-run"].some((o) => seen.has(o)) }),
  // only options that change nothing local, then a remote's plain name, then plain branch names: no path or URL (its
  // upload-pack runs), no refspec with + or : and no prune or force (they overwrite or delete branches)
  "git fetch": table({ flags: "-q -v --quiet --verbose --all --no-tags --dry-run --progress --no-progress", plain: (v, open, k) => !isGlob(open) && (k ? /^[A-Za-z0-9][\w.\/-]*$/ : /^[A-Za-z0-9][\w.-]*$/).test(v), strict: true }),
  "git branch --show-current": table({ plain: NONE }), // a later --no-show-current turns the flag off
  "git rev-parse": table({ flags: "-q --quiet --verify --short --abbrev-ref --symbolic --symbolic-full-name --all --branches --tags --remotes --not --show-toplevel --show-prefix --show-cdup --show-superproject-working-tree --git-dir --git-common-dir --absolute-git-dir --is-inside-git-dir --is-inside-work-tree --is-bare-repository --is-shallow-repository --show-object-format --revs-only --no-revs --flags --no-flags", values: { "--git-path": gitPath }, eq: { "--short": NUMBER, "--abbrev-ref --path-format --show-object-format": NAME }, plain: gitWord, ends: true, openEnd: true, strict: true }),
  "gh pr view": gh("-c --comments", {}, PR),
  "gh pr checks": gh("--watch --required --fail-fast", { "-i --interval": NUMBER }, PR),
  "gh pr diff": gh("--name-only --patch", { "--color": WHEN }, PR),
  "gh pr list": gh("-d --draft", { "-s --state": NAME, "-L --limit": NUMBER, "-A --author -a --assignee -B --base -H --head -l --label -S --search --app": TEXT }, NONE),
  "gh pr edit": table({ values: { "-t --title -b --body -B --base -m --milestone --add-label --remove-label --add-assignee --remove-assignee --add-reviewer --remove-reviewer": TEXT, "-F --body-file": BODY, "-R --repo": JSON_OUT["-R --repo"] }, flags: "--remove-milestone", plain: (v, open, k) => !k && PR(v, open), short: "cluster" }),
  "gh run view": gh("--log --log-failed -v --verbose --exit-status", { "-j --job": RUN, "-a --attempt": NUMBER }, RUN),
  "gh run watch": gh("--exit-status --compact", { "-i --interval": NUMBER }, RUN),
  "gh run list": gh("-a --all", { "-L --limit": NUMBER, "-b --branch -w --workflow -u --user -e --event -s --status -c --commit --created": TEXT }, NONE),
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: table({
    flags: "-s -F -i -v -x -U -P -S -a -w -L -u -b -n -N -0 -o -p -q -H -I -c -l -h -V --case-sensitive --crlf --fixed-strings --ignore-case --invert-match --line-regexp --mmap --no-mmap --multiline --multiline-dotall --no-unicode --null-data --pcre2 --smart-case --stop-on-nonmatch --text --word-regexp --binary --follow --glob-case-insensitive --hidden --no-hidden --no-config --no-ignore --no-ignore-dot --no-ignore-exclude --no-ignore-files --no-ignore-global --no-ignore-parent --no-ignore-vcs --no-require-git --one-file-system --unrestricted --block-buffered --byte-offset --column --no-column --heading --no-heading --include-zero --line-buffered --line-number --no-line-number --max-columns-preview --null --only-matching --passthru --quiet --trim --vimgrep --with-filename --no-filename --sort-files --count --count-matches --files-with-matches --files-without-match --json --no-ignore-messages --no-messages --stats --files --type-list --version --help",
    values: { "-e --regexp": LITERAL, "-f --file": FILE, "-g --glob --iglob": GLOB, "-m -A -B -C -M -d -j --max-count --after-context --before-context --context --max-columns --max-depth --threads --dfa-size-limit --regex-size-limit": NUMBER, "--max-filesize": COUNT, "-t -T -E --type --type-not --encoding --engine --sort --sortr --colors": NAME, "--color": is(/^(?:always|never|auto|ansi)$/), "-r --replace --context-separator --field-context-separator --field-match-separator": TEXT },
    short: "cluster", plain: pathOf({ search: true, stdin: true }), pattern: ["-e", "-f", "--regexp", "--file", "--files", "--type-list", "--version", "--help", "-V", "-h"], ends: true, strict: true,
  }),
  ls: table({ flags: "-a -A -l -h -t -r -R -1 -d -S -F -i -n -o -p -s -c -u -x -m -C -g -G -k -L -N -H -U -Q -q -X -f -B -v --all --almost-all --author --directory --classify --file-type --full-time --group-directories-first --human-readable --si --inode --numeric-uid-gid --no-group --literal --dereference --reverse --recursive --size --color --version --help", values: { "-I --ignore --hide": LEFT_OUT, "-w --width": NUMBER, "--sort --time --time-style --format --indicator-style --quoting-style --block-size": NAME }, eq: { "--color": WHEN }, short: "cluster", plain: pathOf(), ends: true }),
  wc: table({ flags: "-c -m -l -L -w --bytes --chars --lines --max-line-length --words", short: "cluster", plain: pathOf({ stdin: true }), ends: true }),
  head: table({ flags: "-q -v -z --quiet --silent --verbose --zero-terminated", values: { "-n -c --lines --bytes": COUNT }, short: "cluster", like: /^-\d{1,6}$/, plain: pathOf({ reader: true, stdin: true }), ends: true }),
  tail: table({ flags: "-q -v -z --quiet --silent --verbose --zero-terminated", values: { "-n -c --lines --bytes": COUNT }, short: "cluster", like: /^-\d{1,6}$/, plain: pathOf({ reader: true, stdin: true }), ends: true }),
  cat: table({ flags: "-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting", short: "cluster", plain: pathOf({ reader: true, stdin: true }), ends: true }),
  pwd: table({ flags: "-P -L -W", plain: NONE }),
  echo: table({ all: (v, open) => !isGlob(open) || !elsewhere(v) }),
  exit: table({ plain: (v, open, k) => !k && (/^\d{1,3}$/.test(v) || v === CODE || /^\u0002\w+$/.test(v)) }),
}));
const NODE_TEST = table({
  flags: "--test-only --test-force-exit --experimental-test-coverage --no-warnings --enable-source-maps --experimental-strip-types",
  values: { "--test-concurrency --test-timeout": NUMBER, "--test-shard": is(/^\d{1,4}\/\d{1,4}$/), "--test-name-pattern --test-skip-pattern": TEST_NAME, "--test-reporter": is(/^(spec|tap|dot)$/), "--test-isolation --experimental-test-isolation": is(/^(none|process)$/) },
  plain: testWord, strict: true,
});
const VITEST = table({
  flags: "--silent --passWithNoTests --no-color --no-coverage --no-file-parallelism",
  values: { "-t --testNamePattern": TEST_NAME, "--bail --retry --testTimeout --hookTimeout --maxWorkers --minWorkers": NUMBER, "--reporter": is(/^(default|verbose|dot|tap|json|junit)$/), "--pool": is(/^(forks|threads)$/), "--project": is(/^\w[\w-]*$/), "--config": VITE_CONFIG },
  plain: projectWord, strict: true,
});
// The table of a listed command of those tools, or undefined: one this does not know is routine only exactly as listed. A
// script passes what follows its name on to a command this cannot see.
function runTable([tool, ...sub]) {
  if (tool === "node") return sub.join(" ") === "--test" ? NODE_TEST : undefined;
  if (tool === "npx" || tool === "bunx") return sub.join(" ") === "vitest run" ? VITEST : undefined;
  const script = (sub.length === 2 && sub[0] === "run" ? sub[1] : sub.length === 1 ? sub[0] : "").split(":")[0];
  if (script !== "test" && script !== "lint") return undefined;
  const values = tool === "bun" && script === "lint" ? { "--ext": is(/^\.[a-z]{1,5}(,\.[a-z]{1,5})*$/) } : {};
  return table({ flags: tool === "npm" ? "--silent --quiet -s -q" : "--silent", values, plain: script === "test" ? testWord : lintWord, ends: true, strict: true });
}

// True when every word after a command's name is in its table
function fits(t, raw) {
  if (t.all) return raw.every((r) => t.all(exact(r), outsideQuotes(r)));
  const seen = new Set();
  const plain = [], after = [];
  let ended = false;
  for (let i = 0; i < raw.length; i++) {
    const v = exact(raw[i]), open = outsideQuotes(raw[i]);
    if (t.strict && !(ended && t.openEnd) && /^[-*?[]/.test(v) && isGlob(open)) return false;
    if (ended) { after.push({ v, open, ended }); continue; }
    if (v === "--") {
      if (!t.ends) return false;
      ended = true;
      continue;
    }
    if (!v.startsWith("-") || v === "-") { plain.push({ v, open, ended }); continue; }
    if (t.flags.has(v) || (t.like && t.like.test(v))) { seen.add(v); continue; }
    let name = v, value;
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      if (eq > 0) { name = v.slice(0, eq); value = v.slice(eq + 1); }
    } else if (t.short) {
      let k = 1;
      while (t.short === "cluster" && k < v.length && t.flags.has("-" + v[k])) seen.add("-" + v[k++]);
      if (k === v.length) continue;
      name = "-" + v[k];
      if (k + 1 < v.length) value = v.slice(k + 1);
      if (value && value.startsWith("=")) return false; // gh drops it, others keep it
    }
    const attached = value !== undefined;
    const kind = t.values.get(name) || (attached && t.eq.get(name));
    if (!kind || (!attached && ++i >= raw.length)) return false;
    const loose = attached ? open : outsideQuotes(raw[i]);
    if (!attached && kind !== JQ && isGlob(loose)) return false; // it may become several words; attached, each keeps the option's name
    if (!kind(attached ? value : exact(raw[i]), loose)) return false;
    seen.add(name);
  }
  const words = [...plain, ...after];
  if (t.pattern && !t.pattern.some((o) => seen.has(o))) {
    const text = words.shift();
    if (!text || !LITERAL(text.v, text.open)) return false;
  }
  return words.every((x, k) => t.plain(x.v, x.open, k, x.ended)) && (!t.check || t.check(seen, words));
}

// the only commands that may stand after a |: they read the pipe, send it nowhere and take no command from it
const FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "cat", "echo"]);
// One part of a command: a listed command whose words its table knows, or, with no table, exactly as listed
function routinePart(want, op, words, codes) {
  let k = 0;
  for (let m; (m = /^([A-Za-z_]\w*)=/.exec(words[k] || "")) && SAFE_ENV.has(m[1]); k++) if (!SAFE_ENV.get(m[1]).test(exact(words[k].slice(m[0].length)))) return false;
  if (words.some((x) => PROC.test(exact(x)))) return false;
  const raw = words.slice(k);
  if (raw[0] === "git" && raw[1] === "-C") {
    const dir = exact(raw[2] || "");
    if (isGlob(dir) || !pathOf({ search: true })(dir) || literalSecret(dir + "/x")) return false;
    if (dir.length > 260) return false; // joined with every word below
    raw.splice(1, 2);
    for (const v of raw.slice(1).map(exact)) if ([v, v.slice(2), v.replace(/^-[A-Za-z]*?F/, ""), ...v.split(/[=:]/)].some((x) => x && (!x.includes(" ") || x.includes("../")) && literalSecret(dir + "/" + x, true))) return false;
  }
  const w = raw.map(exact);
  if (raw.some((x) => x.startsWith("#"))) return false; // the rest is a comment
  if (w.some((x) => MARKS.test(x)) && !((w[0] === "echo" || w[0] === "exit") && w.every((x) => [...x.matchAll(/\u0002(\w+)/g)].every((m) => codes.has(m[1]))))) return false;
  if (w.some((x) => riskyOption(x, w[0] === "git")) || (op === "|" && !FILTERS.has(w[0]))) return false;
  const size = RUNS_CODE.has(w[0]) ? 0 : [3, 2, 1].find((n) => TABLES.has(w.slice(0, n).join(" ")));
  return want.some((c) => {
    if (!c.every((t, j) => w[j] === t)) return false;
    const t = size ? TABLES.get(w.slice(0, size).join(" ")) : runTable(c);
    return t ? fits(t, raw.slice(size || c.length)) : w.length === c.length;
  });
}
// True when every part of a Bash command is a routine command or the exit-code form, and nothing in it writes a file,
// runs another program, expands, or changes how the next part runs
function routineCommand(commands, cmd) {
  if (typeof cmd !== "string" || MARKS.test(cmd)) return false;
  const s = trimmed((" " + trimmed(cmd)).replace(HARMLESS_REDIRECT, "").replaceAll("$?", CODE).replace(/\$(?=[A-Za-z_])/g, READ));
  const segs = SAFE.test(s.replace(/[\u0001\u0002]/g, "")) && split(s);
  if (!segs) return false;
  if (segs.length > 1 && segs[segs.length - 1].op === ";" && !segs[segs.length - 1].words.length) segs.pop();
  const want = commands.map((c) => c.split(" "));
  const codes = new Set();
  return segs.every(({ op, words }, i) => {
    const set = words.length === 1 && /^(\w+)=\u0001$/.exec(words[0]);
    if (!set) return routinePart(want, op, words, codes);
    codes.add(set[1]);
    return EXIT_NAME.test(set[1]) && (!op || op === ";") && (!segs[i + 1] || segs[i + 1].op === ";");
  });
}

// Text compared the same way on both sides, so spacing, quotes, backslashes, case and - against _ cannot hide a word
const norm = (t) => String(t).toLowerCase().replace(/["'`\\]/g, "").replace(/-/g, "_").replace(/\s+/g, " ").replace(/ ?([=:]) ?/g, "$1");
// every string in the call, read as written (JSON.stringify would turn a newline into \n and a quote into \")
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
const bare = (w) => w.replace(/["']/g, "");
// a git commit or push that skips its hooks: -n (also inside -nm), or --no-verify or any abbreviation git accepts
// (or --no-post-rewrite, the same way). Read two ways: as text between ; | and &, and as the shell's own words (quotes out, so a ; in a message ends nothing).
function skipsHooks(cmd) {
  for (const chunk of cmd.split(/[;|&]/)) {
    const g = /\bgit\b/i.exec(chunk);
    if (!g) continue;
    const rest = chunk.slice(g.index + 3);
    const c = /\bcommit\b/i.exec(rest);
    const after = c && rest.slice(c.index + 6);
    if (after) for (const m of after.matchAll(/\s-([a-z]*)(?=\s|$)/gi)) if (/n/i.test(m[1])) return true;
    const p = /\b(commit|push)\b/i.exec(rest);
    if (p && /\s--no-(ver|pos)/i.test(rest.slice(p.index))) return true;
  }
  for (const { words } of split((" " + cmd).replace(HARMLESS_REDIRECT, "").replace(/[\t\n\r]/g, " ").trim()) || []) {
    const w = words.map(bare);
    const g = w.indexOf("git");
    if (g < 0) continue;
    const at = w.findIndex((x, k) => k > g && (x === "commit" || x === "push"));
    const commit = w.indexOf("commit", g + 1); // past a folder named push (git -C push commit)
    for (let k = at + 1; at >= 0 && k < w.length; k++) {
      if (/^--no-(v|pos)/.test(w[k])) return true;
      const letters = /^-([A-Za-z]+)/.exec(w[k]);
      if (commit < 0 || k < commit || !letters) continue;
      const stop = letters[1].search(/[mFcCtSu]/); // from here on it is that option's value
      if ((stop < 0 ? letters[1] : letters[1].slice(0, stop)).includes("n")) return true;
    }
  }
  return false;
}
// a path field (Read, Grep path): a plain path, plus a short (8.3) name or an NTFS stream, which read a file by another name
const pathSecret = (p, searched) => /::|:\$/.test(p) || SHORT_NAME.test(p) || literalSecret(p, searched);
// True when a tool's path field may name a secrets file or a file on another computer. The tools drop blanks around it.
function readsSecret(tool, input) {
  const field = (k) => (typeof input[k] === "string" ? input[k].trim() : "");
  if (["file_path", "notebook_path", "path"].map(field).some((p) => unc(p) || pathSecret(p, tool === "Grep"))) return true;
  if (tool === "Glob" && (unc(field("pattern")) || /[\\/]{2}/.test(field("pattern")))) return true;
  // the Grep tool's globs, with a blank or a comma between, read what they match (they override .gitignore); a
  // single-character wildcard there is rare
  const g = field("glob").replace(/["']/g, "");
  return /[?[]/.test(g) || [g, ...g.split(/[\s,{}]+/)].some((x) => unc(x) || literalSecret(x) || globSecret(x));
}

// "routine", "yours" or "judge" for one request ({ toolName, toolInput, hookAsk, trimmed }); no levels or no
// request: "yours". A request HQ only holds a cut copy of is "yours": what was cut cannot be judged.
function levelOf(levels, req) {
  if (!levels || !req || req.trimmed === true) return "yours";
  const tool = String(req.toolName || "");
  const input = req.toolInput && typeof req.toolInput === "object" ? req.toolInput : {};
  const said = tool + " " + strings(input).join(" ");
  const texts = [norm(said), norm(noComments(said))]; // a comment between two words (DELETE/**/FROM) hides neither
  const asked = !!req.hookAsk;
  const hook = asked ? String(req.hookAsk.hook || "") : "";
  const reason = asked ? norm(req.hookAsk.reason || "") : "";
  const { routine, yours } = levels;
  if (yours.tools.includes(tool) || (asked && yours.hooks.includes(hook))) return "yours";
  if (asked && yours.hookPhrases.some((p) => reason.includes(norm(p)))) return "yours";
  if (yours.words.some((w) => texts.some((t) => t.includes(norm(w))))) return "yours";
  if (typeof input.command === "string" && (skipsHooks(input.command) || neverApprove(input.command))) return "yours";
  if (["command", "query", "sql"].some((k) => typeof input[k] === "string" && wipesData(input[k]))) return "yours";
  if (asked && !routine.hooks.includes(hook)) return "judge";
  if (readsSecret(tool, input)) return "judge";
  if (typeof input.command !== "string" && routine.tools.includes(tool)) return "routine"; // a listed command is read below, whatever tool carries it
  if (tool === "Bash" && routineCommand(routine.commands, input.command)) return "routine";
  return "judge";
}

module.exports = { loadLevels, levelOf };
