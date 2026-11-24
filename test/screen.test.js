// What a figure's monitors show, from its own transcript. The newest step (a tool call or a reply) as its screen
// draws it, with every string through the secret cuts and capped (160 characters a line, 30 lines, 4 KB a figure).
const test = require("node:test");
const assert = require("node:assert/strict");
const { newScreens, foldScreen, screenOf, shotOf, SCREEN_STEPS, SCREEN } = require("../lib/session");
const { cutSecrets, barOf } = require("../lib/describe");
// A hidden line is a bar (lib/describe.js barOf); an edit's line is its - or + mark, then the bar
const isBar = (l) => typeof barOf === "function" && l != null && !!(barOf(String(l)) || barOf(String(l).slice(1)));
const hasBar = (sc) => [sc.head, sc.title, ...sc.lines].some(isBar);
const { at, asst, tool, text } = require("./helpers");

const result = (sec, id, content, extra = {}) => ({ type: "user", timestamp: at(sec), isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const fold = (rows) => rows.reduce((v, r) => foldScreen(v, r), newScreens());
const screen = (rows, events) => screenOf(fold(rows), events);
const call = (sec, name, input) => { const b = tool(name, input); return { b, row: asst({ sec, content: [b] }) }; };
const PW = (verb) => "mcp__playwright__browser_" + verb;
const page = (url, title, extra = "") => `### Ran Playwright code\n\`\`\`js\nawait page.goto('${url}');\n\`\`\`\n### Page\n- Page URL: ${url}\n- Page Title: ${title}\n${extra}`;
const SNAP_FILE = "### Snapshot\n- [Snapshot](.playwright-mcp/page-2025-01-24T10-00-00-000Z.yml)";
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));

test("nothing yet is no screen", () => {
  assert.equal(screenOf(newScreens()), null);
  assert.equal(screen([{ type: "ai-title", aiTitle: "x" }]), null);
});

test("an edit is an editor: the file's tab, the old lines struck over the new, a little context around them", () => {
  const { b, row } = call(0, "Edit", { file_path: "C:\\work\\shop\\src\\Login.tsx", old_string: "a\nb\nc\nold1\nd", new_string: "a\nb\nc\nnew1\nnew2\nd" });
  const s = screen([row]);
  assert.equal(s.kind, "edit");
  assert.equal(s.head, "Login.tsx");
  assert.equal(s.done, false, "its result has not landed");
  assert.deepEqual(s.lines, [" b", " c", "-old1", "+new1", "+new2", " d"]);
  assert.equal(screen([row, result(1, b.id, "The file C:\\work\\shop\\src\\Login.tsx has been updated.")]).done, true);
  // a new file is all new lines; a MultiEdit shows each change in turn
  assert.deepEqual(screen([call(0, "Write", { file_path: "/w/a.md", content: "# A\n\nb" }).row]).lines, ["+# A", "+", "+b"]);
  assert.deepEqual(screen([call(0, "MultiEdit", { file_path: "/w/a.js", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] }).row]).lines, ["-x", "+y", "-p", "+q"]);
});

test("a long edit keeps old and new lines both on the screen, at most 30 lines", () => {
  const n = (k, w) => Array.from({ length: k }, (_, i) => w + i).join("\n");
  const s = screen([call(0, "Edit", { file_path: "/w/a.js", old_string: n(40, "old"), new_string: n(40, "new") }).row]);
  assert.equal(s.lines.length, SCREEN.lines);
  assert.ok(s.lines.filter((l) => l[0] === "-").length >= 10 && s.lines.filter((l) => l[0] === "+").length >= 10, s.lines.join("|"));
});

test("a shell call is a terminal: its command, then the last 20 lines of its output once the result lands", () => {
  const { b, row } = call(0, "Bash", { command: "npm test -- --run cart\necho done", description: "Run the cart tests" });
  const pending = screen([row]);
  assert.equal(pending.kind, "shell");
  assert.equal(pending.head, "npm test -- --run cart " + String.fromCharCode(0x2026), "a command of two lines shows its first, marked");
  assert.deepEqual(pending.lines, []);
  assert.equal(pending.done, false);
  const out = Array.from({ length: 25 }, (_, i) => "line " + (i + 1)).join("\n");
  const s = screen([row, result(5, b.id, out)]);
  assert.equal(s.done, true);
  assert.deepEqual(s.lines, Array.from({ length: 20 }, (_, i) => "line " + (i + 6)));
  assert.equal(screen([row, result(5, b.id, "Exit code 1\nboom", { is_error: true })]).error, true);
  // terminal colors and carriage-return progress are what the eye saw, not the codes
  const esc = String.fromCharCode(27);
  assert.deepEqual(screen([row, result(5, b.id, `${esc}[32mPASS${esc}[39m cart\n10%\r50%\r100%`)]).lines, ["PASS cart", "100%"]);
  assert.equal(screen([call(0, "PowerShell", { command: "Get-ChildItem" }).row]).kind, "shell");
});

test("a read is an editor with the file's tab and its first lines; a search shows its pattern and its first results", () => {
  const { b, row } = call(0, "Read", { file_path: "C:/work/shop/src/api/orders.ts" });
  assert.deepEqual(screen([row]).lines, []);
  const body = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(6)}\tconst x${i} = ${i};`).join("\n");
  const s = screen([row, result(1, b.id, body)]);
  assert.equal(s.kind, "read");
  assert.equal(s.head, "orders.ts");
  assert.equal(s.lines.length, 30);
  assert.equal(s.lines[0], "     1  const x0 = 0;", "a tab reads as two spaces");
  const g = call(0, "Grep", { pattern: "useCart\\(", path: "src" });
  const gs = screen([g.row, result(1, g.b.id, "Found 2 files\nsrc/a.ts\nsrc/b.ts")]);
  assert.deepEqual([gs.kind, gs.title, gs.head, gs.lines], ["search", "Grep", "useCart\\(", ["Found 2 files", "src/a.ts", "src/b.ts"]]);
  assert.equal(screen([call(0, "Glob", { pattern: "**/*.tsx" }).row]).head, "**/*.tsx");
});

test("a web fetch is a browser at its URL showing the page's text", () => {
  const { b, row } = call(0, "WebFetch", { url: "https://docs.example.com/guide?page=2", prompt: "summarize" });
  const p = screen([row]);
  assert.deepEqual([p.kind, p.head, p.title, p.lines, p.done], ["browser", "https://docs.example.com/guide?page=2", null, [], false]);
  const s = screen([row, result(2, b.id, "# Guide\nInstall it with npm.")]);
  assert.deepEqual(s.lines, ["# Guide", "Install it with npm."]);
});

test("a Playwright call is a browser: the URL its input names until the result lands, then the page's URL and title", () => {
  const nav = call(0, PW("navigate"), { url: "http://localhost:5173/checkout" });
  const p = screen([nav.row]);
  assert.deepEqual([p.kind, p.head, p.title, p.done], ["browser", "http://localhost:5173/checkout", null, false]);
  const s = screen([nav.row, result(1, nav.b.id, page("http://localhost:5173/checkout", "Checkout | Shop", SNAP_FILE))]);
  assert.deepEqual([s.head, s.title, s.lines], ["http://localhost:5173/checkout", "Checkout | Shop", []], "its snapshot went to a file: the URL and title only");
  // the plugin's copy of the server is the same browser
  assert.equal(screen([call(0, "mcp__plugin_playwright_playwright__browser_click", { element: "Pay", ref: "e5" }).row]).kind, "browser");
});

test("a snapshot's text is the page text for that page, until the browser is on another page", () => {
  const nav = call(0, PW("navigate"), { url: "http://localhost:5173/checkout" });
  const snap = call(2, PW("snapshot"), {});
  const yaml = '### Page\n- Page URL: http://localhost:5173/checkout\n- Page Title: Checkout | Shop\n### Snapshot\n```yaml\n- heading "Checkout" [level=1] [ref=e2]\n- button "Pay now" [ref=e5]\n```';
  const rows = [nav.row, result(1, nav.b.id, page("http://localhost:5173/checkout", "Checkout | Shop", SNAP_FILE)), snap.row, result(3, snap.b.id, yaml)];
  const s = screen(rows);
  assert.deepEqual([s.kind, s.head, s.title], ["browser", "http://localhost:5173/checkout", "Checkout | Shop"]);
  assert.deepEqual(s.lines, ['- heading "Checkout" [level=1] [ref=e2]', '- button "Pay now" [ref=e5]']);
  const click = call(4, PW("click"), { element: "Pay now", ref: "e5" });
  const c = screen([...rows, click.row]);
  assert.deepEqual([c.head, c.title, c.lines.length], ["http://localhost:5173/checkout", "Checkout | Shop", 2], "a click on that page, pending, shows the page and its text");
  const away = call(6, PW("navigate"), { url: "http://localhost:5173/thanks" });
  const w = screen([...rows, click.row, result(5, click.b.id, "### Ran Playwright code\n```js\nawait page.click();\n```"), away.row, result(7, away.b.id, page("http://localhost:5173/thanks", "Thanks", SNAP_FILE))]);
  assert.deepEqual([w.head, w.title, w.lines], ["http://localhost:5173/thanks", "Thanks", []]);
});

test("a screenshot is learned only from a screenshot call's own result; a browser step on that page shows it, another page does not", () => {
  const nav = call(0, PW("navigate"), { url: "http://localhost:5173/" });
  const shot = call(2, PW("take_screenshot"), { type: "png" });
  const link = "AppData\\Local\\Temp\\claude\\C--work\\abc\\page-1.png";
  const rows = [nav.row, result(1, nav.b.id, page("http://localhost:5173/", "Shop", SNAP_FILE)), shot.row];
  const pend = fold(rows);
  assert.equal(screenOf(pend).kind, "shot");
  assert.equal(shotOf(pend), null, "pending: no picture yet");
  const done = [...rows, result(3, shot.b.id, `### Result\n- [Screenshot of viewport](${link})\n### Ran Playwright code\n\`\`\`js\nawait page.screenshot({ path: '${link}' });\n\`\`\``)];
  const v = fold(done);
  assert.deepEqual([screenOf(v).head, screenOf(v).title], ["http://localhost:5173/", "Shop"]);
  assert.equal(shotOf(v).rel, link);
  const click = call(4, PW("click"), { element: "Cart", ref: "e3" });
  assert.equal(shotOf(fold([...done, click.row])).rel, link, "a click on the page it shows");
  const away = call(6, PW("navigate"), { url: "http://localhost:5173/cart" });
  assert.equal(shotOf(fold([...done, away.row, result(7, away.b.id, page("http://localhost:5173/cart", "Cart", SNAP_FILE))])), null);
  assert.equal(shotOf(fold([...done, call(8, "Bash", { command: "ls" }).row])), null, "a step that is not a browser shows none");
  // the same words in a shell's output, or a screenshot call that failed, teach nothing
  const sh = call(0, "Bash", { command: "cat notes.md" });
  const fake = fold([nav.row, result(1, nav.b.id, page("http://localhost:5173/", "Shop", SNAP_FILE)), sh.row, result(1, sh.b.id, `- [Screenshot of viewport](${link})`), click.row]);
  assert.equal(shotOf(fake), null);
  const bad = call(2, PW("take_screenshot"), {});
  assert.equal(shotOf(fold([...rows, result(3, bad.b.id, "### Error\nTimeout"), bad.row, result(4, bad.b.id, "### Error\nTimeout", { is_error: true })])), null);
});

test("a web search is a search page: the query and the result titles", () => {
  const { b, row } = call(0, "WebSearch", { query: "vitest fake timers" });
  const out = 'Web search results for query: "vitest fake timers"\n\nLinks: [{"title":"Fake Timers | Vitest","url":"https://vitest.dev/guide/mocking"},{"title":"Timers in Node","url":"https://nodejs.org/api/timers.html"}]\n\nA summary.';
  const s = screen([row, result(2, b.id, out)]);
  assert.deepEqual([s.kind, s.head, s.lines], ["web", "vitest fake timers", ["Fake Timers | Vitest", "Timers in Node"]]);
});

test("a reply is its newest text, wrapped at 160 characters; a call after it in the same message is newer", () => {
  const long = "word ".repeat(80).trim();
  const s = screen([asst({ sec: 0, stop: "end_turn", content: [text("I found it.\n\n" + long)] })]);
  assert.equal(s.kind, "reply");
  assert.equal(s.done, true);
  assert.equal(s.lines[0], "I found it.");
  assert.ok(s.lines.length > 3 && s.lines.every((l) => [...l].length <= SCREEN.width), "a paragraph is wrapped, not cut");
  assert.equal(s.lines.slice(2).join(" "), long, "every word is kept");
  assert.equal(screen([asst({ sec: 0, content: [text("Let me look."), tool("Read", { file_path: "/w/a.js" })] })]).kind, "read");
});

test("any other step is the fake terminal named by its label", () => {
  const s = screen([call(0, "TodoWrite", { todos: [] }).row]);
  assert.deepEqual([s.kind, s.head, s.lines], ["other", "Updating the plan", []]);
});

test("every line is at most 160 characters, at most 30 lines, and a figure's screen at most 4 KB", () => {
  const wide = Array.from({ length: 50 }, (_, i) => i + " " + "x".repeat(300)).join("\n");
  const w = screen([call(0, "Write", { file_path: "/w/big.txt", content: wide }).row]);
  assert.ok(w.lines.length <= SCREEN.lines && w.lines.every((l) => [...l].length <= SCREEN.width));
  assert.ok(bytes(w) <= SCREEN.bytes, bytes(w) + " bytes");
  // a terminal over its budget keeps its newest lines (two bytes a character here, so 20 full lines pass 4 KB)
  const sh = call(0, "Bash", { command: "build" });
  const t = screen([sh.row, result(1, sh.b.id, Array.from({ length: 20 }, (_, i) => "out" + i + " " + String.fromCharCode(0xfc).repeat(300)).join("\n"))]);
  assert.ok(bytes(t) <= SCREEN.bytes && t.lines.length < 20, `${t.lines.length} lines, ${bytes(t)} bytes`);
  assert.ok(t.lines[t.lines.length - 1].startsWith("out19"), "the newest line stays");
  const emoji = String.fromCodePoint(0x1f600).repeat(400);
  const e = screen([asst({ sec: 0, content: [text(emoji)] })]);
  assert.ok(e.lines.every((l) => [...l].length <= SCREEN.width && !/[\ud800-\udbff]$/.test(l)), "no emoji is cut in half");
});

test(`only the newest ${SCREEN_STEPS} step(s) keep their inputs; a late result for a step no longer kept changes nothing`, () => {
  const a = call(0, "Bash", { command: "first" }), b = call(1, "Bash", { command: "second" });
  const v = fold([a.row, b.row, result(2, a.b.id, "late")]);
  assert.equal(v.steps.length, SCREEN_STEPS);
  assert.equal(v.steps[v.steps.length - 1].input, "second");
  const s = screenOf(v);
  assert.deepEqual([s.head, s.done, s.lines], ["second", false, []]);
});

test("sidechain rows of a main transcript are not its figure's; a result for an id never seen is ignored", () => {
  const v = fold([asst({ sec: 0, sidechain: true, content: [tool("Bash", { command: "theirs" })] }), result(1, "tu_none", "x")]);
  assert.equal(screenOf(v), null);
});

test("the left screen's newest 6 steps (time and label) and the right screen's files touched, newest first", () => {
  const rows = ["a.js", "b.js", "c.js"].map((f, i) => call(i, i === 1 ? "Read" : "Edit", { file_path: "/w/" + f, old_string: "x", new_string: "y" }).row);
  rows.push(call(3, "Edit", { file_path: "/w/a.js", old_string: "1", new_string: "2" }).row);
  const events = Array.from({ length: 9 }, (_, i) => ({ at: i, tool: "Edit", label: "Step " + i }));
  const s = screen(rows, events);
  assert.deepEqual(s.steps, [8, 7, 6, 5, 4, 3].map((i) => ({ at: i, label: "Step " + i })));
  assert.deepEqual(s.files, [{ name: "a.js", edit: true }, { name: "c.js", edit: true }, { name: "b.js", edit: false }]);
  const many = Array.from({ length: 12 }, (_, i) => call(i, "Edit", { file_path: `/w/f${i}.js`, old_string: "x", new_string: "y" }).row);
  assert.equal(screen(many).files.length, SCREEN.files);
});

test("a secrets file's contents never show: its tab does", () => {
  for (const f of ["C:/work/app/.env", "C:/work/app/.env.local", "C:/Users/me/.npmrc", "C:/Users/me/.ssh/config"]) {
    const s = screen([call(0, "Write", { file_path: f, content: "PLAIN_LOOKING=value" }).row]);
    assert.deepEqual([s.secret, s.lines], [true, []], f);
  }
  const r = call(0, "Read", { file_path: "/w/.env" });
  const s = screen([r.row, result(1, r.b.id, "     1\tA=b")]);
  assert.deepEqual([s.head, s.secret, s.lines], [".env", true, []]);
});

// The secret cuts, one test per kind, each planted in a Bash output, an Edit's new text, a URL query and a page text.
// Nothing planted may reach the screen; its line is a bar; the lines around it stay.
function planted(value, { bash, edit, url, pageText }) {
  const sh = call(0, "Bash", { command: "run" });
  const fetch = call(0, "WebFetch", { url });
  const nav = call(0, PW("navigate"), { url: "http://localhost:5173/settings" });
  const snap = call(2, PW("snapshot"), {});
  const out = {
    bash: screen([sh.row, result(1, sh.b.id, "before\n" + bash + "\nafter")]),
    edit: screen([call(0, "Edit", { file_path: "/w/config.js", old_string: "a", new_string: edit }).row]),
    url: screen([fetch.row]),
    page: screen([nav.row, result(1, nav.b.id, page("http://localhost:5173/settings", "Settings", SNAP_FILE)), snap.row,
      result(3, snap.b.id, "### Snapshot\n```yaml\n- heading \"Settings\"\n" + pageText + "\n```")]),
  };
  for (const [where, s] of Object.entries(out)) {
    const j = JSON.stringify(s);
    for (const v of [].concat(value)) assert.ok(!j.includes(v), `${where}: ${v} leaked in ${j}`);
    assert.ok(hasBar(s), `${where}: the line is a bar in ${j}`);
  }
  assert.ok(JSON.stringify(out.bash).includes("before") && JSON.stringify(out.bash).includes("after"), "the lines around it stay");
  assert.ok(JSON.stringify(out.page).includes("Settings"));
  return out;
}

test("secret cuts, keys: API key shapes and named keys", () => {
  const K = "sk-" + "ant-api03-Zq9PLANTEDkeyVALUE1234567890ab", G = "AI" + "zaSyPLANTEDgoogleKEY0123456789abcdefg";
  planted([K, G], {
    bash: `ANTHROPIC key is ${K}\nmaps ${G}`,
    edit: `const client = new Anthropic({ apiKey: "${K}" });\nconst maps = "${G}";`,
    url: `https://api.example.com/v1/models?api_key=${K}&key=${G}`,
    pageText: `- text: "Your key ${K}"\n- code: ${G}`,
  });
});

test("secret cuts, tokens: token shapes, JWTs and named tokens", () => {
  const T = "gh" + "p_PLANTEDtoken1234567890abcdefABCDEF12", J = "ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiJQTEFOVEVEIn0.c2lnbmF0dXJlUExBTlRFRA", N = "plantedSessionTok99";
  planted([T, J, N], {
    bash: `token: ${T}\njwt ${J}\nsession_token=${N}`,
    edit: `const token = "${T}";\nconst jwt = "${J}";\nexport const sessionToken = "${N}";`,
    url: `https://api.example.com/cb?access_token=${T}&id_token=${J}&session_token=${N}`,
    pageText: `- code: "${T}"\n- text: ${J}\n- text: "sessionToken: ${N}"`,
  });
});

test("secret cuts, passwords: named passwords, a URL's password, a password field's value", () => {
  const P = "hunter2PLANTEDpw";
  planted(P, {
    bash: `mysql --password ${P}\nconnecting to postgres://admin:${P}@db.example.com/app\npassword=${P}`,
    edit: `const db = { user: "admin", password: "${P}" };`,
    url: `https://admin:${P}@db.example.com/login?password=${P}`,
    pageText: `- textbox "Password" [ref=e12]: ${P}\n- text: "pwd=${P}"`,
  });
});

test("secret cuts, .env lines: a NAME=value line keeps its name and loses its value", () => {
  const V = "postgres-PLANTED-env-value-77";
  const out = planted(V, {
    bash: `DATABASE_URL=${V}\nNODE_ENV=${V}`,
    edit: `export DATABASE_URL=${V}\nDEPLOY_TARGET=${V}`,
    url: `https://example.com/debug?DATABASE_URL=${V}`,
    pageText: `- text: DATABASE_URL=${V}`,
  });
  assert.equal(cutSecrets("DATABASE_URL=" + V), "DATABASE_URL=[hidden]", "the value cut keeps the name (a file name or a step label)");
});

test("secret cuts, Authorization: everything after it on the line, and a bearer token anywhere", () => {
  const A = "cGxhbnRlZDphdXRoUExBTlRFRA==", B = "plantedBearerValue99";
  planted([A, B], {
    bash: `> Authorization: Basic ${A}\n> GET / HTTP/1.1\nsent Bearer ${B}`,
    edit: `headers: { Authorization: "Bearer ${B}" },\nconst basic = "Authorization: Basic ${A}";`,
    url: `https://api.example.com/v1?authorization=Bearer%20${B}&sig=${A}`,
    pageText: `- text: "Authorization: Bearer ${B}"\n- code: Authorization=Basic ${A}`,
  });
});

test("the cuts leave ordinary text alone: code, hashes, ids, paths and links", () => {
  for (const s of [
    "const total = items.reduce((a, b) => a + b, 0);",
    "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "eeeeeeee-0000-0000-0000-000000000005",
    "C:/Users/me/my-app/public/floor/furniture.js",
    "https://example.com/docs?page=2&sort=asc",
    "Tests: 290 passed, 0 failed",
    "if (a === b) return;",
  ]) assert.equal(cutSecrets(s), s);
  // and the commands that carry a key are cut where they are written
  assert.equal(cutSecrets("export TOKEN=sk-live-123"), "export TOKEN=[hidden]");
  assert.ok(!cutSecrets("curl -H 'Authorization: Bearer sk-live-123' https://api.example.com").includes("sk-live-123"));
});

// Harder forms, each planted where it can appear: a Bash command (the terminal's prompt line), a Bash output, an Edit's
// new text, a Read's lines, and a URL or a page's text where that applies.
function plantedIn(value, where) {
  const out = {};
  if (where.command != null) out.command = screen([call(0, where.tool || "Bash", { command: where.command }).row]);
  if (where.bash != null) {
    const sh = call(0, "Bash", { command: "run" });
    out.bash = screen([sh.row, result(1, sh.b.id, "before\n" + where.bash + "\nafter")]);
  }
  if (where.edit != null) out.edit = screen([call(0, "Edit", { file_path: "/w/config.js", old_string: "a", new_string: where.edit }).row]);
  if (where.read != null) {
    const r = call(0, "Read", { file_path: "/w/notes.txt" });
    out.read = screen([r.row, result(1, r.b.id, where.read)]);
  }
  if (where.url != null) out.url = screen([call(0, "WebFetch", { url: where.url }).row]);
  if (where.pageText != null) {
    const nav = call(0, PW("navigate"), { url: "http://localhost:5173/settings" }), snap = call(2, PW("snapshot"), {});
    out.page = screen([nav.row, result(1, nav.b.id, page("http://localhost:5173/settings", "Settings", SNAP_FILE)), snap.row,
      result(3, snap.b.id, "### Snapshot\n```yaml\n- heading \"Settings\"\n" + where.pageText + "\n```")]);
  }
  assert.ok(Object.keys(out).length, "planted somewhere");
  for (const [k, s] of Object.entries(out)) {
    const j = JSON.stringify(s);
    for (const v of [].concat(value)) assert.ok(!j.includes(v), `${k}: ${v} leaked in ${j}`);
    assert.ok(hasBar(s), `${k}: the line is a bar in ${j}`);
  }
  return out;
}
const unchanged = (list) => { for (const s of list) assert.equal(cutSecrets(s), s); };

test("secret cuts, curl: a -u or --user value and a -b or --cookie value", () => {
  const U = "curlUserSECRET8", U2 = "curlUser2SECRET9", G = "curlGluedSECRET", C = "curlCookieSECRET5", C2 = "curlCookie2SECRET";
  for (const [v, cmd] of [[U, `curl -u admin:${U} https://api.example.com`], [U2, `curl --user admin:${U2} https://api.example.com`],
    [G, `curl -uadmin:${G} https://api.example.com`], [C, `curl -b 'sid=${C}' https://x.com`], [C2, `curl --cookie "sid=${C2}; theme=dark" https://x.com`]]) {
    const out = plantedIn(v, { command: cmd, bash: "+ " + cmd, edit: "#!/bin/sh\n" + cmd });
    assert.ok(isBar(out.command.head), "the command is a bar: " + out.command.head);
    assert.ok(cutSecrets(cmd).startsWith("curl "), "the value cut keeps the command");
  }
  // the same letters elsewhere mean something else
  unchanged(["git push -u origin main", "git checkout -b feature/cart", "npm run build -- --user-agent x", "tar -u -f a.tar b"]);
});

test("secret cuts, -p values only where -p is a password: mysql and mariadb glued, sshpass and docker login", () => {
  const M = "mysqlGluedSECRET10", R = "mariaGluedSECRET", S = "sshpassSECRET11", D = "dockerSECRET12";
  for (const [v, cmd] of [[M, `mysql -u root -p${M} db`], [R, `mariadb -h db -u app -p${R} shop`], [S, `sshpass -p ${S} ssh me@host`], [D, `docker login -u me -p ${D} registry.io`]])
    plantedIn(v, { command: cmd, bash: "$ " + cmd, edit: cmd });
  // elsewhere -p is a port, parents or a prompt
  unchanged(["mkdir -p src/cart", "ssh -p 2222 me@host", "docker run -p 8080:80 nginx", "mysql -u root -p shop", "scp -P 22 a b"]);
});

test("secret cuts, URL userinfo: the whole of it before the @, the host kept", () => {
  const cases = [
    ["redisPwSECRET9", "redis://:redisPwSECRET9@cache.example.com:6379"],
    ["ghtokenonlysecretvalue9f8e7d", "https://ghtokenonlysecretvalue9f8e7d@github.com/o/r.git"],
    ["pa/ssSECRET", "https://admin:pa/ssSECRET@host.example.com/x"],
    [["p@ssSECRET", "ssSECRET"], "https://admin:p@ssSECRET@host.example.com/x"],
  ];
  for (const [v, u] of cases) {
    const out = plantedIn(v, { command: `git clone ${u}`, bash: `remote: ${u}`, edit: `const conn = "${u}";`, url: u.startsWith("http") ? u : undefined, pageText: `- text: ${u}` });
    const host = u.slice(u.lastIndexOf("@") + 1).replace(/[:/].*$/, "");
    for (const s of Object.values(out)) assert.ok(hasBar(s), JSON.stringify(s));
    assert.ok(cutSecrets(u).includes("[hidden]@" + host), host + " stays in the value cut");
  }
  plantedIn("e2eRedisSECRET", { edit: 'const conn = "redis://:e2eRedisSECRET@cache:6379";' });
  unchanged(["https://www.npmjs.com/package/@scope/name", "http://localhost:5173/products?page=2", "git@github.com:o/r.git", "see https://example.com/@me for more"]);
});

test("secret cuts, named values: an escaped JSON body, a quoted passphrase whole, PowerShell variables and pw names", () => {
  plantedIn("escJsonSECRET14", { command: 'curl -d "{\\"password\\":\\"escJsonSECRET14\\"}" https://x.com', bash: '{\\"password\\":\\"escJsonSECRET14\\"}', edit: 'body: "{\\"password\\":\\"escJsonSECRET14\\"}"' });
  plantedIn(["correct horse", "battery SECRET15"], { bash: 'password: "correct horse battery SECRET15"', edit: 'password: "correct horse battery SECRET15"', pageText: '- text: password: "correct horse battery SECRET15"' });
  plantedIn("psPwVarSECRET7", { tool: "PowerShell", command: '$pw = "psPwVarSECRET7"', bash: '$pw = "psPwVarSECRET7"', edit: '$pw = "psPwVarSECRET7"' });
  plantedIn("psSecretVarSECRET", { tool: "PowerShell", command: "$clientSecret = 'psSecretVarSECRET'", edit: "$clientSecret = 'psSecretVarSECRET'" });
  plantedIn("quotedEnvSECRET3", { command: 'SMTP_PW="quotedEnvSECRET3" node send.js', bash: 'SMTP_PW="quotedEnvSECRET3"', edit: 'SMTP_PW="quotedEnvSECRET3"' });
  plantedIn("camelPwSECRET31", { edit: 'const dbPw = "camelPwSECRET31";', bash: "dbPw: camelPwSECRET31" });
  // pw is a secret's name only whole or as a suffix
  unchanged(["const lowpw = 5;", "pwned: false", "npw = 3", "upward: 2"]);
});

test("secret cuts, .env lines: a quoted value, and an export whose name holds a secret's word", () => {
  plantedIn("singleQuotedSECRET4", { command: "export MY_CONN='singleQuotedSECRET4'", bash: "MY_CONN='singleQuotedSECRET4'", edit: "export MY_CONN='singleQuotedSECRET4'" });
  plantedIn("dblQuotedSECRET", { bash: 'DATABASE_URL="dblQuotedSECRET"', edit: 'DATABASE_URL="dblQuotedSECRET"' });
  plantedIn("svcRoleSECRET42", { command: "export service_role=svcRoleSECRET42", bash: "service_role=svcRoleSECRET42", edit: "export service_role=svcRoleSECRET42" });
  assert.equal(cutSecrets("MY_CONN='x y'"), "MY_CONN='[hidden]'", "the quotes stay, the value goes whole");
});

test("secret cuts, keys: a bare AWS secret key, a PGP private key block, a key body with no BEGIN line", () => {
  const AWS = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  plantedIn(AWS, { command: `aws configure set aws_secret_access_key ${AWS}`, bash: AWS, edit: `secrets:\n  - ${AWS}`, read: "     1\t" + AWS });
  const PGP = "-----BEGIN PGP PRIV" + "ATE KEY BLOCK-----\n\nlQOYBGplantedPGPbody/abc+def\n=Ab1c\n-----END PGP PRIV" + "ATE KEY BLOCK-----";
  plantedIn(["lQOYBGplantedPGPbody", "abc+def"], { bash: PGP, edit: PGP });
  const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7/plantedBODY+xyz";
  assert.ok(BODY.length >= 60);
  plantedIn(["plantedBODY", BODY.slice(0, 30)], { bash: BODY + "\nAoIBAQC7/rest\n-----END PRIV" + "ATE KEY-----", edit: BODY, read: "    12\t" + BODY });
  // the same shapes of ordinary text stay: hashes, SHAs, paths, a long lowercase run
  unchanged(["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "C:/Users/me/AppData/Local/Temp/claude/C--work/abc/scratchpad/page-1.png", "src/features/catalog/product-list/ProductListSortMenu.tsx", "a".repeat(80)]);
});

test("secret cuts, page fields: every textbox's value goes, labeled or not; its label stays", () => {
  const out = plantedIn(["unlabeledFieldSECRET21", "4242 4242 4242 4242", "me@example.com"], {
    pageText: '- textbox [ref=e12]: unlabeledFieldSECRET21\n- textbox "Card number" [ref=e5]: 4242 4242 4242 4242\n  - textbox "Email: work" [active] [ref=e6]: me@example.com',
  });
  const j = cutSecrets('- textbox "Card number" [ref=e5]: 4242 4242 4242 4242' + "\n" + '  - textbox "Email: work" [active] [ref=e6]: me@example.com');
  assert.ok(j.includes("Card number") && j.includes("Email: work"), "the value cut keeps the labels: " + j);
  assert.ok(out.page.lines.filter(isBar).length >= 3, "the field lines are bars: " + JSON.stringify(out.page.lines));
  plantedIn("e2eUnlabeledPwSECRET", { pageText: "- textbox [ref=e3]: e2eUnlabeledPwSECRET" });
});

test("secret cuts, an OAuth code and a Slack webhook's path", () => {
  const O = "http://localhost:3000/callback?code=4/0AfgeXvOauthCODEsecret&state=abc";
  const o = plantedIn("0AfgeXvOauthCODEsecret", { command: `curl "${O}"`, bash: O, edit: `const cb = "${O}";`, url: O, pageText: `- text: ${O}` });
  assert.ok(isBar(o.url.head) && cutSecrets(O).includes("state=abc"), "a bar; the value cut keeps the rest");
  const S = "https://hooks.slack.com/services/T0ABCDEF1/B0ABCDEF2/slackHookSECRETabc25";
  const s = plantedIn(["slackHookSECRETabc25", "T0ABCDEF1/B0ABCDEF2"], { command: `curl -X POST ${S}`, bash: S, edit: `const hook = "${S}";`, url: S });
  assert.ok(isBar(s.url.head) && cutSecrets(S).includes("hooks.slack.com/services/[hidden]"));
});

test("secret files: a base name holding secret, .pgpass, key and certificate files, ssh keys anywhere", () => {
  for (const f of ["C:/work/app/secrets.json", "/w/client_secret.json", "/home/me/.pgpass", "/w/certs/server.pem", "/w/certs/server.key",
    "/w/certs/store.p12", "/w/certs/store.pfx", "C:/Users/me/keys/id_rsa", "/w/id_ed25519.pub", "/w/backup/id_rsa_old"]) {
    const r = call(0, "Read", { file_path: f });
    const s = screen([r.row, result(1, r.b.id, '     1\t{"stripe": "e2eNotNamedSECRET"}')]);
    assert.deepEqual([s.secret, s.lines], [true, []], f);
  }
  for (const f of ["/w/keyboard.ts", "/w/monkey.js", "/w/keys.ts", "/w/pem-notes.md"]) {
    const r = call(0, "Read", { file_path: f });
    assert.equal(screen([r.row, result(1, r.b.id, "     1\tx")]).secret, undefined, f);
  }
});

test("lowercase hex runs stay: git SHAs and hashes are everywhere on these screens", () => {
  unchanged(["app auth 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]);
});

// The bounds kept for speed must not narrow what is masked: aligned config lines and wide spacing stay masked.
test("secret cuts, wide spacing: aligned config lines, spaced separators, a bearer and a flag with many spaces, a JWT glued to a flag", () => {
  for (const [v, s] of [
    ["alignedYamlSECRET31", "password:" + sp(12) + "alignedYamlSECRET31"],
    ["alignedIniSECRET32", "api_key =" + sp(10) + "alignedIniSECRET32"],
    ["spacedSECRET33", "token" + sp(6) + "=  spacedSECRET33"],
    ["manySpacesSECRET34abc", "Bearer" + sp(10) + "manySpacesSECRET34abc"],
    [["dashJwtSECRET38", "ey" + "JzdWIiOiIxMjM0In0"], "--token-ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiIxMjM0In0.dashJwtSECRET38"],
    ["flagManySpacesSECRET46", "--api-key" + sp(6) + "flagManySpacesSECRET46"],
  ]) plantedIn(v, { command: "app " + s, bash: s, edit: s });
});

// Every input here stays masked, so no later bound can quietly undo a mask. Each entry: the input, then what must not
// show.
const ESC = String.fromCharCode(27), sp = (n) => " ".repeat(n);
const MASKED = [
  ["curl -H 'Authorization: Bearer AbCdSECRET123xyz' https://api.x.com", "AbCdSECRET123xyz"],
  ['{"authorization":"token zzSECRETzz999"}', "zzSECRETzz999"],
  ["Cookie: sid=cookieSECRET777; theme=dark", "cookieSECRET777"],
  ["Set-Cookie: sid=setcookieSECRET88; Path=/", "setcookieSECRET88"],
  ["https://api.x.com/cb?token=tokSECRETvalue1", "tokSECRETvalue1"],
  ["https://api.x.com/v1?api_key=apikeySECRET22&x=1", "apikeySECRET22"],
  ["git clone https://admin:hunter2SECRET@git.example.com/r.git", "hunter2SECRET"],
  ["sent Bearer bearerSECRETabc123", "bearerSECRETabc123"],
  ["AK" + "IAIOSFODNN7EXAMPLE", "AK" + "IAIOSFODNN7EXAMPLE"],
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI", "EXAMPLEKEY"],
  ["ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ["-----BEGIN RSA PRIV" + "ATE KEY-----\nMIIEpAIBAAKCAQEA7SECRETbody\n-----END RSA PRIV" + "ATE KEY-----", "MIIEpAIBAAKCAQEA7SECRETbody"],
  ["-----BEGIN OPENSSH PRIV" + "ATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUSECRETbody\n-----END OPENSSH PRIV" + "ATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUSECRETbody"],
  ["export db_password=lowerPwSECRET1", "lowerPwSECRET1"],
  ["MY_CONN=plainEnvSECRET5", "plainEnvSECRET5"],
  ['$env:API_KEY = "psEnvSECRET6"', "psEnvSECRET6"],
  ["app --password=flagEqSECRET13", "flagEqSECRET13"],
  ['{"client_secret": "clientSecretSECRET16"}', "clientSecretSECRET16"],
  ["X-API-Key: xapikeySECRET17", "xapikeySECRET17"],
  ['const client = new X({ apiKey: "editApiKeySECRET18" });', "editApiKeySECRET18"],
  ['const apiKey =\n  "nextLineSECRET19";', "nextLineSECRET19"],
  ['- textbox "Password" [ref=e12]: pageFieldSECRET20', "pageFieldSECRET20"],
  ['- code: "sk-proj-pageTextOpenAIkeySECRET22abc"', "pageTextOpenAIkeySECRET22abc"],
  ["is sk-" + "ant-api03-searchQuerySECRET23xyz leaked", "searchQuerySECRET23xyz"],
  ["gh" + "p_searchQueryGhTokenSECRET24abcdEF", "searchQueryGhTokenSECRET24abcdEF"],
  ["GOCSPX-gOcSpXplanted0123456789abcd", "gOcSpXplanted0123456789abcd"],
  ["//registry.npmjs.org/:_authToken=npmrcTokSECRET26", "npmrcTokSECRET26"],
  ["Server=db;User Id=sa;Password=connStrSECRET27;", "connStrSECRET27"],
  ["...?X-Amz-Signature=amzSigSECRET28&X-Amz-Credential=AK" + "IAxx", "amzSigSECRET28"],
  ["sk_" + "live_51HstripeSECRET29abcdef", "51HstripeSECRET29abcdef"],
  ["sb_secret_supabaseSECRET30abcdef", "supabaseSECRET30abcdef"],
  ["Authorization:" + sp(10) + "Basic YWxhZGRpbjpvcGVuSECRET35", "YWxhZGRpbjpvcGVuSECRET35"],
  ["x-sk-proj-dashPrefixedOpenAIkeySECRET36abc", "dashPrefixedOpenAIkeySECRET36abc"],
  ["key-sk-" + "ant-api03-afterDashSECRET37xyz", "afterDashSECRET37xyz"],
  ["foo-gh" + "p_afterDashGhTokenSECRET39abcdEFgh", "afterDashGhTokenSECRET39abcdEFgh"],
  ["x-xo" + "xb-1234567890-afterDashSlackSECRET40", "afterDashSlackSECRET40"],
  ["my.config.password=dottedNameSECRET41", "dottedNameSECRET41"],
  ["a.b-c_d.client-secret: mixedNameSECRET42", "mixedNameSECRET42"],
  ["DATABASE_URL=postgres://u:pgSECRET43@db:5432/x", "pgSECRET43"],
  ["git+ssh://git:sshUrlSECRET44@host/r", "sshUrlSECRET44"],
  ["-----BEGIN ENCRYPTED PRIV" + "ATE KEY-----\nMIIFHzBJBgkqSECRETenc\n-----END ENCRYPTED PRIV" + "ATE KEY-----", "MIIFHzBJBgkqSECRETenc"],
  ["--api-key flagSpaceSECRET45", "flagSpaceSECRET45"],
  ['- textbox  "Password" [ref=e1]:  twoSpaceSECRET47', "twoSpaceSECRET47"],
  [ESC + "[32mexport API_TOKEN=ansiColoredSECRET48" + ESC + "[0m", "ansiColoredSECRET48"],
  ["PASSWORD=" + "a".repeat(10) + "longEnvSECRET49", "longEnvSECRET49"],
  ["X".repeat(130) + "_TOKEN=longNameSECRET50", "longNameSECRET50"],
];
test("secret cuts, every listed input stays masked", () => {
  for (const [s, ...parts] of MASKED) {
    const out = cutSecrets(s);
    for (const p of parts) assert.ok(!out.includes(p), `${p} leaked: ${JSON.stringify(out)}`);
    assert.ok(out.includes("[hidden]"), JSON.stringify(out));
  }
  // end to end: a web search's query, a Playwright navigate's URL (its password and its token), a secrets file
  const q = call(0, "WebSearch", { query: "error with key sk-" + "ant-api03-e2eSearchKeySECRETabc" });
  assert.ok(!JSON.stringify(screen([q.row])).includes("e2eSearchKeySECRETabc"));
  const nav = call(0, PW("navigate"), { url: "https://user:e2eUrlPwSECRET@app.example.com/?token=e2eTok" });
  const j = JSON.stringify(screen([nav.row]));
  assert.ok(!j.includes("e2eUrlPwSECRET") && !j.includes("e2eTok"), j);
  const r = call(0, "Read", { file_path: "C:/Users/me/.aws/credentials" });
  assert.deepEqual(screen([r.row, result(1, r.b.id, "     1\t[default]")]).secret, true);
});

// A MultiEdit whose first change fills 29 lines, then a small change with context either side
test("an edit screen holds at most 30 lines, however its changes add up", () => {
  const first = { old_string: "", new_string: Array.from({ length: 29 }, (_, i) => "added line " + i).join("\n") };
  const second = { old_string: "a\nb\nc\nd\ne", new_string: "a\nb\nX\nd\ne" };
  const sc = screen([call(0, "MultiEdit", { file_path: "/w/cart.js", edits: [first, second] }).row]);
  assert.equal(sc.lines.length, SCREEN.lines, sc.lines.length + " lines");
  assert.equal(sc.lines[0], "+added line 0");
});

// A hidden character inside a token keeps it from matching any shape, so hidden characters go before the cuts, not
// after them (a zero-width space rejoined a GitHub token on screen)
test("a token split by a hidden character is cut, not rejoined whole", () => {
  const T = "token is gh" + "p_AbCdEfGhIj" + String.fromCharCode(0x200b) + "KlMnOpQrStUvWxYz0123456789";
  plantedIn(["KlMnOpQrStUvWxYz0123456789", "gh" + "p_AbCdEfGhIjKlMn"], { command: "echo " + T, bash: T, edit: T, read: "     1\t" + T });
  assert.equal(cutSecrets(T), "token is [hidden]");
  const sh = call(0, "Bash", { command: "printf" });
  assert.deepEqual(screen([sh.row, result(1, sh.b.id, "a\tb\r\nc\rd")]).lines, ["a  b", "d"], "tabs, newlines and carriage returns still read as before");
});

// values that try to pass as already hidden, each a must-mask input
test("secret cuts, a value is already hidden only when it is exactly [hidden]: anything after it is masked too", () => {
  plantedIn("realSECRET1", { command: "app password=[hidden]realSECRET1", bash: "password=[hidden]realSECRET1", edit: "password=[hidden]realSECRET1" });
  plantedIn("realSECRET2", { command: "export API_TOKEN=[hidden]realSECRET2", bash: "API_TOKEN=[hidden]realSECRET2", edit: "API_TOKEN=[hidden]realSECRET2" });
  plantedIn("realQuotedSECRET", { bash: 'password: "[hidden]realQuotedSECRET"', edit: "SMTP_PW='[hidden]realQuotedSECRET'" });
  plantedIn("bearerAfterSECRET1", { bash: "sent Bearer [hidden]bearerAfterSECRET1", edit: "sent Bearer [hidden]bearerAfterSECRET1" });
  for (const s of ["password=[hidden]", "API_TOKEN=[hidden]", 'password: "[hidden]"', "Bearer [hidden]"]) assert.equal(cutSecrets(s), s, "a value that is [hidden] stays as it is: " + s);
});

test("secret cuts, URL-encoded named values: an encoded colon or equals, encoded quotes either side, the value to %22, %27, %26, & or a space", () => {
  const J = "https://x.com/?data=%7B%22password%22%3A%22urlEncSECRET9%22%7D", E = "https://x.com/?q=api_key%3DurlEqSECRET10";
  for (const [v, u] of [["urlEncSECRET9", J], ["urlEqSECRET10", E], ["lowerEncSECRET", "https://x.com/?q=token%3dlowerEncSECRET&page=2"], ["sqEncSECRET", "https://x.com/?d=%27secret%27%3a%27sqEncSECRET%27"]])
    plantedIn(v, { command: `curl "${u}"`, bash: u, edit: `const u = "${u}";`, url: u, pageText: `- text: ${u}` });
  assert.equal(cutSecrets(J), "https://x.com/?data=%7B%22password%22%3A%22[hidden]%22%7D", "the value stops at %22");
  assert.equal(cutSecrets("https://x.com/?q=token%3dlowerEncSECRET&page=2"), "https://x.com/?q=token%3d[hidden]&page=2", "and at &");
});

test("secret cuts, hidden characters inside a name are dropped before the cuts: a soft hyphen, a BOM, a Mongolian vowel separator", () => {
  for (const c of [0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x2064, 0x206a, 0x206f, 0xfeff]) {
    const s = "pass" + String.fromCharCode(c) + "word=shyKeywordSECRET4";
    plantedIn("shyKeywordSECRET4", { command: "app " + s, bash: s, edit: s });
    assert.equal(cutSecrets(s), "password=[hidden]", "U+" + c.toString(16));
  }
  assert.equal(cutSecrets("a\tb\r\nc"), "a\tb\r\nc", "tab, newline and carriage return stay");
});

test("secret cuts, more separators: an HTML entity, a JSON unicode escape, a full-width colon or equals", () => {
  for (const [v, s] of [["htmlEntSECRET11", "password&#61;htmlEntSECRET11"], ["htmlColonSECRET", "password&#58; htmlColonSECRET"], ["jsonColonSECRET13", '{"password"\\u003a"jsonColonSECRET13"}'],
    ["jsonEqSECRET", "password\\u003DjsonEqSECRET"], ["fullwidthSECRET14", "password" + String.fromCharCode(0xff1a) + " fullwidthSECRET14"], ["fullwidthEqSECRET", "token" + String.fromCharCode(0xff1d) + "fullwidthEqSECRET"]])
    plantedIn(v, { command: "app " + s, bash: s, edit: s, pageText: "- text: " + s });
});

test("secret cuts, a triple-quoted value and a lowercase private key block", () => {
  plantedIn("tomlTripleSECRET21", { bash: 'password = """tomlTripleSECRET21"""', edit: 'password = """tomlTripleSECRET21"""' });
  plantedIn("pyTripleSECRET", { edit: "api_key = '''pyTripleSECRET'''" });
  assert.equal(cutSecrets('password = """tomlTripleSECRET21"""'), 'password = """[hidden]"""');
  const K = "-----begin private key-----\nlowerKeySECRET24\n-----end private key-----";
  plantedIn("lowerKeySECRET24", { bash: K, edit: K, read: "     1\t-----begin private key-----\n     2\tlowerKeySECRET24" });
});

test("the earlier known limits are hidden now: no separator, more than 64 spaces after one, a -pwd glued flag", () => {
  for (const [v, s] of [["tabSECRET18", "password\t\ttabSECRET18"], ["gluedSECRET27", "app -pwdgluedSECRET27"], ["farSECRET17", "password:" + " ".repeat(70) + "farSECRET17"]])
    plantedIn(v, { command: s, bash: s, edit: s, read: "     1\t" + s });
  // the value cuts alone still leave them, and prose, as written (a file name or a step label)
  unchanged(["password\t\ttabSECRET18", "app -pwdgluedSECRET27", "password reset link sent", "the password is required"]);
});

// Each result parser on the real formats Playwright MCP and WebSearch write, in their exact shapes
const X_URL = "https://x.example/path";
const NAV_RESULT = "### Ran Playwright code\n```js\nawait page.goto('https://x.example/path');\n```\n### Page\n- Page URL: https://x.example/path\n- Page Title: Title\n- Console: 0 errors, 1 warnings\n### Snapshot\n- [Snapshot](.playwright-mcp\\page-2025-01-06T10-00-00-000Z.yml)";
const SHOT_FILE = (name) => "AppData\\Local\\Temp\\claude\\C--work-app\\0a1b2c3d-0000-4000-8000-0000000000c2\\scratchpad\\" + name;
const SHOT_RESULT = (label, file) => [
  { type: "text", text: `### Result\n- [${label}](${file})\n### Ran Playwright code\n\`\`\`js\n// Screenshot ${label.slice(14)} and save it as ${file}\nawait page.screenshot({\n  scale: 'css',\n  type: '${file.endsWith(".jpg") ? "jpeg" : "png"}'\n});\n\`\`\`` },
  { type: "image", source: { type: "base64", media_type: file.endsWith(".jpg") ? "image/jpeg" : "image/png", data: "iVBORw0KGgo=" } },
];
test("real formats, browser_take_screenshot: a viewport or full page screenshot, .png or .jpg, is learned", () => {
  for (const [label, file] of [["Screenshot of viewport", SHOT_FILE("name.png")], ["Screenshot of full page", SHOT_FILE("full.png")], ["Screenshot of viewport", SHOT_FILE("name.jpg")]]) {
    const nav = call(0, PW("navigate"), { url: X_URL }), shot = call(2, PW("take_screenshot"), { type: "png" });
    const v = fold([nav.row, result(1, nav.b.id, NAV_RESULT), shot.row, result(3, shot.b.id, SHOT_RESULT(label, file))]);
    assert.deepEqual([shotOf(v) && shotOf(v).rel, shotOf(v) && shotOf(v).url], [file, X_URL], label + " " + file);
    const s = screenOf(v);
    assert.deepEqual([s.kind, s.head, s.title, s.done], ["shot", X_URL, "Title", true]);
  }
});

test("real formats, navigate and click: the page's URL and title, a screenshot taken on that page, and the snapshot file is never read", () => {
  const fs = require("node:fs"), seen = [], spied = ["readFileSync", "openSync", "readFile", "open", "createReadStream", "statSync", "existsSync"], was = {};
  for (const k of spied) { was[k] = fs[k]; fs[k] = (...a) => { seen.push(k + " " + a[0]); return was[k](...a); }; }
  let during;
  try {
    const nav = call(0, PW("navigate"), { url: X_URL });
    const n = screen([nav.row, result(1, nav.b.id, NAV_RESULT)]);
    assert.deepEqual([n.kind, n.head, n.title, n.lines], ["browser", X_URL, "Title", []]);
    const shot = call(2, PW("take_screenshot"), {}), click = call(4, PW("click"), { element: "Buy", ref: "e7" });
    const CLICK_RESULT = NAV_RESULT.replace("await page.goto('https://x.example/path');", "await page.getByRole('button', { name: 'Buy' }).click();");
    const v = fold([nav.row, result(1, nav.b.id, NAV_RESULT), shot.row, result(3, shot.b.id, SHOT_RESULT("Screenshot of viewport", SHOT_FILE("name.png"))), click.row, result(5, click.b.id, CLICK_RESULT)]);
    const c = screenOf(v);
    assert.deepEqual([c.kind, c.head, c.title, c.lines], ["browser", X_URL, "Title", []]);
    assert.equal(shotOf(v).rel, SHOT_FILE("name.png"), "the screenshot taken on that page");
    during = seen.slice();
    fs.existsSync(__filename);
  } finally {
    for (const k of spied) fs[k] = was[k];
  }
  assert.deepEqual(during, [], "no file is read while the screens are built");
  assert.equal(seen.length, 1, "control: the spy sees a read");
});

test("real formats, browser_snapshot: the inline snapshot's text is the page text", () => {
  const SNAP_RESULT = "### Page\n- Page URL: https://x.example/path\n- Page Title: Title\n- Console: 10 errors, 31 warnings\n### Snapshot\n```yaml\n- generic [ref=e2]:\n  - button \"Text (e3)\":\n    - img [ref=e4]\n  - link \"Home\" [ref=e5] [cursor=pointer]:\n    - /url: /\n```";
  const snap = call(0, PW("snapshot"), {});
  const s = screen([snap.row, result(1, snap.b.id, SNAP_RESULT)]);
  assert.deepEqual([s.kind, s.head, s.title], ["browser", X_URL, "Title"]);
  assert.deepEqual(s.lines, ["- generic [ref=e2]:", '  - button "Text (e3)":', "    - img [ref=e4]", '  - link "Home" [ref=e5] [cursor=pointer]:', "    - /url: /"]);
});

test("real formats, WebSearch: the result titles, its text given as a string or as text blocks", () => {
  const OUT = 'Web search results for query: "q"\n\nLinks: [{"title":"T1","url":"https://a"},{"title":"T2","url":"https://b"}]';
  for (const content of [OUT, [{ type: "text", text: OUT }], OUT + "\n\nBased on the results, T1 is the guide."]) {
    const { b, row } = call(0, "WebSearch", { query: "q" });
    const s = screen([row, result(1, b.id, content)]);
    assert.deepEqual([s.kind, s.head, s.lines], ["web", "q", ["T1", "T2"]], JSON.stringify(content).slice(0, 60));
  }
});

test("real formats, an error: the error shows, nothing is learned, nothing throws", () => {
  const ERR = '### Error\nError: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/\nCall log:\n  - navigating to "http://localhost:5173/", waiting until "domcontentloaded"';
  for (const [verb, input] of [["navigate", { url: "http://localhost:5173/" }], ["click", { element: "Buy", ref: "e7" }], ["snapshot", {}], ["take_screenshot", {}]]) {
    for (const extra of [{}, { is_error: true }]) {
      const c = call(0, PW(verb), input), v = fold([c.row, result(1, c.b.id, ERR, extra)]), s = screenOf(v);
      const what = verb + (extra.is_error ? " (is_error)" : "");
      assert.ok(s.lines.some((l) => l.includes("net::ERR_CONNECTION_REFUSED")), what + ": " + JSON.stringify(s.lines));
      assert.ok(!s.lines.some((l) => l.includes("### Error")), what + ": the heading is not page text");
      assert.equal(s.error, true, what);
      assert.equal(shotOf(v), null, what);
    }
  }
});

test("a built screen is kept until its fold, its newest event or its screenshot id changes, so no text is cut twice", () => {
  const sh = call(0, "Bash", { command: "npm test" });
  const v = fold([sh.row]);
  const events = [{ at: 1, tool: "Bash", label: "Run the tests" }];
  const a = screenOf(v, events);
  assert.equal(screenOf(v, events), a, "nothing changed: the same screen");
  foldScreen(v, result(2, sh.b.id, "ok"));
  const b = screenOf(v, events);
  assert.notEqual(b, a, "a row folded in: built again");
  assert.deepEqual([b.done, b.lines], [true, ["ok"]]);
  events.push({ at: 3, tool: "Read", label: "Reading a.js" });
  const c = screenOf(v, events);
  assert.notEqual(c, b, "a newer event: built again");
  assert.equal(c.steps[0].label, "Reading a.js");
  const ID = "0123456789abcdef0123456789abcdef";
  assert.notEqual(screenOf(v, events, ID), c, "another screenshot id: built again");
  assert.equal(screenOf(v, events, ID), screenOf(v, events, ID));
  // a row that is not the figure's own (a sidechain, a title) changes nothing
  foldScreen(v, { type: "ai-title", aiTitle: "x" });
  assert.equal(screenOf(v, events, ID), screenOf(v, events, ID));
});
