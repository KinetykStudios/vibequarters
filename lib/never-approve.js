// Commands that are never approved for the owner, whatever approval-levels.json lists: deletes, force pushes, hard
// resets, deploys, publishes and database wipes. The list's words match a command as it is usually typed; this reads the
// command's own words instead, so another flag order, a git global option (git -C repo ...), a shortened option, quotes
// or a wrapper (sudo, npx, bash -c, xargs) does not hide one. It leans toward yes: a wrong yes is one click, and the only
// answer it can give is "wait for the owner". It is not a wall: a script file that does the same is not read.
"use strict";

// Commands that only read, print or record the words given to them, so those words are not commands themselves
const DATA = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "ls", "wc", "pwd", "git", "gh", "write-output", "write-host", "select-string"]);
// Commands that run text given to them: with one of these in the line, even printed words may run (echo "..." | sh)
const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "eval", "iex", "invoke-expression", "xargs", "parallel", "ssh", "wsl", "source"]);
const GIT_RUNS = new Set(["submodule", "bisect", "rebase", "filter-branch", "config"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
const BEFORE_BARE = new Set(["npx", "bunx", "pnpm", "yarn", "bun", "npm", "dlx", "exec", "x", "sudo", "env", "time", "call", "-y", "--yes", "--bun"]);
// what runs a package's command: the next word that is no option names it, with a version or without (npx x@latest)
const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "dlx"]);
const LAUNCHER_VALUE = new Set(["-p", "--package", "-w", "--workspace", "-C", "--prefix", "--cwd", "-F", "--filter"]);
// vercel's own commands that put nothing live; with none of them, vercel deploys
const VERCEL_READS = new Set(["env", "logs", "log", "ls", "list", "inspect", "whoami", "link", "pull", "dev", "build", "login", "logout", "help", "teams", "switch", "projects", "project", "domains", "dns", "certs", "init", "git", "integration", "install", "open", "cache", "blob", "httpstat", "curl"]);

const isFlag = (w) => w.startsWith("-");
const positional = (args) => args.filter((a) => !isFlag(a));
// true when the words hold every given one, in that order
function inOrder(words, ...want) {
  let i = 0;
  for (const w of words) if (w === want[i]) i++;
  return i >= want.length;
}
// a long option or a start of its name, as git and GNU tools take it: --forc, --dele, --recur
const longOption = (w, full, min = 1) => w.startsWith("--") && w.split("=")[0].length >= 2 + min && full.startsWith(w.split("=")[0]);
const cluster = (w, letters) => /^-[A-Za-z0-9]+$/.test(w) && [...letters].some((l) => w.slice(1).includes(l));

// the work tree or a folder of it, as git checkout and git restore name one; a single file is judged, as with rm
const WHOLE = /^(.*\/)?\.{0,2}$|^:|[*?[]/;
const manyFiles = (files) => files.length !== 1 || WHOLE.test(files[0]) || !files[0].split("/").pop().includes(".");

function gitNever(args) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) i += GIT_VALUE.has(args[i]) ? 2 : 1;
  const sub = (args[i] || "").toLowerCase();
  const rest = args.slice(i + 1);
  const long = (full, min) => rest.some((w) => longOption(w, full, min));
  const pos = positional(rest);
  switch (sub) {
    case "reset": return long("--hard");
    case "clean": case "filter-branch": case "filter-repo": return true;
    case "push":
      return ["--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune"].some((f) => long(f))
        || rest.some((w) => /^-[A-Za-z0-9]*[fd][A-Za-z0-9]*$/.test(w))
        || pos.some((w) => /^[+:]/.test(w) || /(^|[/.@])(heroku|dokku)\b/i.test(w));
    case "branch": return rest.some((w) => cluster(w, "D")) || ((long("--delete") || rest.some((w) => cluster(w, "d"))) && (long("--force") || rest.some((w) => cluster(w, "f"))));
    case "tag": return long("--delete") || rest.some((w) => /^-[A-Za-z]*d$/.test(w));
    case "stash": return pos[0] === "drop" || pos[0] === "clear";
    case "update-ref": return rest.some((w) => cluster(w, "d")) || long("--stdin") || long("--delete");
    case "reflog": return pos[0] === "expire" || pos[0] === "delete";
    case "rm": return rest.some((w) => cluster(w, "r"));
    case "checkout": {
      if (long("--force", 2) || rest.some((w) => /^-[qdmt]*f/.test(w))) return true;
      const dash = rest.indexOf("--");
      return dash >= 0 ? manyFiles(rest.slice(dash + 1)) : pos.some((w) => WHOLE.test(w));
    }
    case "checkout-index": return long("--force") || rest.some((w) => cluster(w, "f"));
    case "switch": return long("--force", 2) || long("--discard-changes", 2) || rest.some((w) => /^-[qdmt]*f/.test(w));
    case "restore": {
      if (long("--pathspec-from-file")) return true;
      const staged = long("--staged", 2) || rest.some((w) => cluster(w, "S"));
      if (staged && !long("--worktree") && !rest.some((w) => cluster(w, "W"))) return false;
      const files = rest.filter((w, k) => !isFlag(w) && !/^(-s|--source)$/.test(rest[k - 1] || ""));
      return files.length > 0 && manyFiles(files);
    }
    case "remote": return pos[0] === "rm" || pos[0] === "remove";
    case "worktree": return pos[0] === "remove" && (long("--force") || rest.some((w) => cluster(w, "f")));
    default: return false;
  }
}
// rm of one plain file is judged; more than one, a folder, a wildcard or a list from elsewhere waits for the owner
function rmNever(args) {
  if (args.some((w) => /^-[rRfvidI]*[rR][rRfvidI]*$/.test(w) || /^-r[a-z]*$/i.test(w) || longOption(w, "--recursive") || longOption(w, "--no-preserve-root"))) return true;
  const targets = positional(args);
  return targets.length !== 1 || /[*?[\]{},$%]/.test(targets[0]);
}
function npmNever(args) {
  const pos = positional(args).map((w) => w.toLowerCase());
  const pub = (w) => (w && w.length >= 2 && "publish".startsWith(w)) || (w && w.length >= 3 && "unpublish".startsWith(w));
  // a flag may take the first word as its value (--workspace app publish)
  return pub(pos[0]) || (args.length > 0 && isFlag(args[0]) && pub(pos[1])) || (pos[0] === "npm" && pub(pos[1]));
}
function ghNever(args) {
  const pos = positional(args).map((w) => w.toLowerCase());
  const top = pos.slice(0, 5);
  if (inOrder(top, "pr", "merge") || ["create", "edit", "delete", "upload", "delete-asset"].some((s) => inOrder(top, "release", s))) return true;
  if (inOrder(top, "workflow", "run")) return true;
  if (["delete", "archive", "rename", "edit"].some((s) => inOrder(top, "repo", s)) || top.slice(1, 3).includes("delete")) return true;
  if (!top.includes("api")) return false;
  const all = args.join(" ");
  if (/(-X|--method)[ =]*["']?delete\b/i.test(all) || /mergePullRequest|\bdelete[A-Z]\w*\s*\(/.test(all)) return true;
  return /\/(merge|merges|releases|dispatches|git\/refs)\b/.test(all) && /(^| )(-X|--method|-f|-F|--field|--raw-field|--input)/.test(all) && !/(-X|--method)[ =]*["']?get\b/i.test(all);
}
const anyOf = (args, ...names) => positional(args).some((w) => names.includes(w.toLowerCase()));
// an HTTP DELETE, as curl and wget take the method, and as PowerShell does
const sendsDelete = (args) => args.some((w, k) => /^(-[A-Za-z]*X|--req\w*|--meth\w*)=?delete$/i.test(w) || (/^(-[A-Za-z]*X|--req\w*|--meth\w*)$/.test(w) && /^delete$/i.test(args[k + 1] || "")));
const webDelete = (args) => /(^| )-me\w*[ :]+delete( |$)/i.test(args.join(" "));
const dropsVolumes = (args) => args.slice(args.indexOf("down")).some((w) => longOption(w, "--volumes", 2) || /^-v/.test(w));
const asks = (args) => args.length === 1 && /^(-h|-v|--help|--version)$/.test(args[0]);

// One verb and the words after it; exact is false when the verb is not the first word of its part
const VERBS = {
  git: gitNever,
  rm: rmNever,
  gh: ghNever,
  npm: npmNever, pnpm: npmNever, yarn: npmNever, bun: npmNever,
  vercel: (a, exact) => {
    if (a.some((w) => /^--prod/i.test(w) || /^--target=prod/i.test(w))) return true;
    const p = positional(a);
    return p.length ? exact && !VERCEL_READS.has(p[0].toLowerCase()) : exact && !a.some((w) => /^(-v|-h|--version|--help)$/.test(w));
  },
  pulumi: (a) => anyOf(a, "up", "update", "destroy", "cancel", "import") || positional(a).slice(0, 2).join(" ") === "stack rm",
  terraform: (a) => anyOf(a, "apply", "destroy"),
  kubectl: (a) => anyOf(a, "apply", "delete", "replace", "drain"),
  helm: (a) => anyOf(a, "install", "upgrade", "uninstall", "delete", "rollback"),
  docker: (a) => anyOf(a, "push", "prune") || a.some((w) => /^--push\b/.test(w)) || ["rm", "remove"].some((s) => inOrder(positional(a), "volume", s)) || (inOrder(positional(a), "compose", "down") && dropsVolumes(a)),
  "docker-compose": (a) => anyOf(a, "down") && dropsVolumes(a),
  supabase: (a) => inOrder(a, "db", "push") || inOrder(a, "db", "reset") || anyOf(a, "deploy", "delete"),
  prisma: (a) => inOrder(a, "migrate", "reset") || inOrder(a, "migrate", "deploy") || inOrder(a, "db", "push"),
  twine: (a) => anyOf(a, "upload"),
  gem: (a) => anyOf(a, "push", "yank"),
  nuget: (a) => anyOf(a, "push", "delete"),
  aws: (a) => a.some((w) => /^--delete/.test(w) || /^(rm|rb|(delete|terminate|purge|remove)(-.*)?)$/i.test(w)),
  gsutil: (a) => anyOf(a, "rm", "rb") || (anyOf(a, "rsync") && a.some((w) => cluster(w, "d"))),
  gcloud: (a) => anyOf(a, "delete", "deploy"),
  az: (a) => anyOf(a, "delete"),
  doctl: (a) => anyOf(a, "delete", "create-deployment"),
  heroku: (a) => a.some((w) => /:(destroy|reset|promote|rollback)$|^(destroy|container:push)$/i.test(w)),
  fly: (a) => anyOf(a, "deploy", "destroy"),
  wrangler: (a) => anyOf(a, "deploy", "delete", "publish"),
  rsync: (a) => a.some((w) => /^--del/.test(w) || longOption(w, "--remove-source-files", 4)),
  robocopy: (a) => a.some((w) => /^\/(mir|purge|move)$/i.test(w)),
  find: (a) => a.some((w) => w === "-delete"),
  truncate: () => true,
  dd: (a) => a.some((w) => /^of=/i.test(w) && !NOWHERE.test(w.slice(3))),
  cp: (a) => a.find((w) => !isFlag(w)) === "/dev/null",
  format: (a) => a.some((w) => /^[a-z]:\/?$/i.test(w)),
  curl: sendsDelete, wget: sendsDelete,
  http: (a) => a.some((w) => /^delete$/i.test(w)),
  "invoke-restmethod": webDelete, "invoke-webrequest": webDelete, irm: webDelete, iwr: webDelete,
};
// The same, for a name that is also an everyday word or package: only as the command itself or what npx and the like run
const PACKAGES = {
  "semantic-release": (a) => !asks(a) && !a.some((w) => w === "-d" || w === "--dry-run"),
  "release-it": (a) => !asks(a) && !a.includes("--dry-run"),
  np: (a) => !asks(a) && !a.includes("--preview"),
  "gh-pages": (a) => !asks(a), surge: (a) => !asks(a),
  "del-cli": () => true, "trash-cli": () => true, "empty-trash-cli": () => true,
  lerna: (a) => anyOf(a, "publish"),
  netlify: (a) => anyOf(a, "deploy"),
  firebase: (a) => anyOf(a, "deploy") || a.some((w) => /:(delete|disable)$/.test(w)),
  cdk: (a) => anyOf(a, "deploy", "destroy"),
  serverless: (a) => anyOf(a, "deploy", "remove"),
};
for (const [alias, name] of [["netlify-cli", "netlify"], ["firebase-tools", "firebase"], ["aws-cdk", "cdk"], ["sls", "serverless"], ["sst", "serverless"]]) PACKAGES[alias] = PACKAGES[name];
for (const [alias, name] of [["npm-cli", "npm"], ["podman", "docker"], ["nerdctl", "docker"], ["tofu", "terraform"], ["terragrunt", "terraform"], ["oc", "kubectl"], ["flyctl", "fly"], ["railway", "fly"], ["vc", "vercel"], ["dotnet", "nuget"], ["gcloud.cmd", "gcloud"]]) VERBS[alias] = VERBS[name];
// deletes whatever follows
for (const w of ["del", "erase", "rd", "rmdir", "ri", "remove-item", "unlink", "shred", "sdelete", "rimraf", "trash", "dropdb", "flushall", "flushdb", "clear-content", "clear-recyclebin", "format-volume", "clear-disk", "remove-partition", "diskpart"]) VERBS[w] = () => true;
// code that deletes files, in any command that can run it (node -e, python -c, a PowerShell line)
const CODE_DELETE = /\brmtree\b|\brm_rf?\b|\bfileutils\.rm|\bdropdatabase\(|\brm(dir)?sync\b|\bunlinksync\b|\brimraf\b|\.(rm|rmdir)\s{0,9}\(|\brm\(|\[["'](rm|rmdir|unlink)(sync)?["']\]|\bos\.(remove|unlink|rmdir|removedirs)\b|\bfs(promises|\.promises)?\.(rm|rmdir|unlink)\b|\.unlink(?=\(|$)|\bunlink\(|\.delete(?=\(|$)|::delete\b|\bremove-item\b/i;

// a redirect's file, or dd's, that keeps nothing
const NOWHERE = /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|nul|\$null)$/i;

// The command as parts (split at ; | & line breaks, brackets and backticks outside quotes, redirects left out), each a list of words
// { text, quoted }. A backslash is an escape (Bash) or, with slash set, part of a path (PowerShell, cmd). A part's cuts is
// true when a redirect of it empties a file, its after the character before it.
function partsOf(cmd, slash) {
  const out = [[]];
  let word = null, quoted = false, q = null, file = ""; // file: the redirect the next word is the file of
  const end = () => {
    if (word !== null && !file) out[out.length - 1].push({ text: word, quoted });
    if (word !== null && /^(>|>\||&>)$/.test(file) && !NOWHERE.test(word)) out[out.length - 1].cuts = true;
    if (word !== null) file = "";
    word = null;
    quoted = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && q !== "'") {
      if (slash) word = (word || "") + "/";
      else if (cmd[i + 1] !== undefined) word = (word || "") + cmd[++i];
      continue;
    }
    if (q) {
      if (c === q) q = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; word = word || ""; quoted = true; continue; }
    if (c === " " || c === "\t") { end(); continue; }
    // a redirect takes one word as its file; the words after it still belong to the same command
    if (c === "<" || c === ">" || (c === "&" && cmd[i + 1] === ">")) {
      if (/^\d+$/.test(word || "")) word = null;
      end();
      file = c;
      while (/[<>&|]/.test(cmd[i + 1] || "")) file += cmd[++i];
      continue;
    }
    if (";|&\n\r(){}`".includes(c)) { end(); file = ""; out.push(Object.assign([], { after: c })); continue; }
    word = (word || "") + c;
  }
  end();
  return out.filter((p) => p.length || p.cuts);
}
// a part that does nothing but empty a file (: > x, > x, cat /dev/null > x). A bare > is read only in the command itself,
// and not next to a heredoc, whose lines may start with one.
function empties(part, bareToo) {
  if (!part.cuts || part.length > 2) return false;
  const said = part.map((w) => w.text).join(" ");
  return said === ":" || said === "true" || said === "cat /dev/null" || (!said && bareToo && !/[)}`]/.test(part.after || ""));
}
// a command's name: its folder and extension off, any case
const nameOf = (w) => w.split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

function partNever(part, runs, depth) {
  let words = part.map((w) => w.text);
  let from = 0;
  while (from < words.length && /^[A-Za-z_]\w*=/.test(words[from])) from++;
  const head = nameOf(words[from] || "");
  const data = DATA.has(head);
  const gitRuns = head === "git" && words.some((w) => GIT_RUNS.has(w) || /alias/i.test(w));
  // open: the next word may be the command itself; launched: npx or the like came before; skip: its option's value is next
  let open = true, launched = false, manager = false, skip = false, verbs = 0;
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    if (i > from && data && !gitRuns) break;
    const name = nameOf(w);
    const first = open && !skip;
    const verb = first && launched ? nameOf(w.replace(/(.)@[^@/]*$/, "$1")) : name;
    if (Object.hasOwn(VERBS, verb) && ++verbs > 100) return true; // this many in one command: unsure
    if (Object.hasOwn(VERBS, verb) && VERBS[verb](words.slice(i + 1), first)) return true;
    if (first && Object.hasOwn(PACKAGES, verb) && PACKAGES[verb](words.slice(i + 1))) return true;
    if (LAUNCHERS.has(name) || (manager && (name === "x" || name === "exec"))) {
      open = launched = true;
      skip = false;
    } else if (skip) skip = false;
    else if (launched && isFlag(w)) skip = LAUNCHER_VALUE.has(w);
    else if (!BEFORE_BARE.has(name)) open = false;
    manager = manager || ["npm", "pnpm", "yarn", "bun"].includes(name);
    if (/^mkfs(\.|$)/.test(verb)) return true;
  }
  // text handed to something that runs it
  if (data && !gitRuns && !runs) return false;
  if (words.slice(from).some((w) => CODE_DELETE.test(w))) return true;
  return part.some((w, i) => i > from && (w.quoted || /^!/.test(w.text)) && /[\s;|&`(]/.test(w.text) && never(w.text.replace(/^[\w.-]*=?!/, ""), depth + 1));
}

function never(cmd, depth) {
  if (depth > 4) return true; // commands inside commands this deep: unsure
  for (const slash of [false, true]) {
    const parts = partsOf(cmd, slash);
    const runs = parts.some((p) => p.some((w) => RUNNERS.has(nameOf(w.text))));
    if (!slash && parts.some((p) => empties(p, !depth && !cmd.includes("<<")))) return true;
    if (parts.some((p) => partNever(p, runs, depth))) return true;
  }
  return false;
}

// True when the command holds a step only the owner may approve
function neverApprove(command) {
  const cmd = String(command).replace(/[\\`]\r?\n/g, " ").replace(/\$\{?IFS\}?/g, " ");
  if (never(cmd, 0)) return true;
  // what $( ) and backticks hold runs even inside double quotes; more than a few is unsure
  const starts = [...cmd.matchAll(/\$\(|`/g)];
  if (starts.length > 40) return true;
  return starts.some((m) => never(cmd.slice(m.index + m[0].length).replace(/["']/g, " "), 1));
}

// A database statement that empties or drops a table, comments set aside (DELETE/**/FROM)
const SQL = /\bdelete\s+from\b|\bdrop\s+(table|database|schema)\b|(^|;)\s*truncate\s+["\w]|\btruncate\s+table\b/i;
const noComments = (t) => t.replace(/\/\*[^]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
function wipesData(sql) {
  return [sql, noComments(sql)].some((t) => SQL.test(t));
}

module.exports = { neverApprove, wipesData, noComments };
