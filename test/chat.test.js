const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChats, typed, TAIL, KEEP, TEXT_MAX, SAID_MAX, WRAP, tailOf } = require("../lib/chat");
const { at, asst, user, tool, text, jsonl } = require("./helpers");
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hq-chat-")), "s.jsonl");
const result = (id, sec, isError = false) => ({ type: "user", timestamp: new Date(Date.parse("2025-01-15T12:00:00.000Z") + sec * 1000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }] } });

test("a typed prompt, a reply and a step that finishes", () => {
  const fp = tmp();
  const t = tool("Read", { file_path: "C:/w/app.js" });
  fs.writeFileSync(fp, jsonl([user({ sec: 0, text: "Fix the header" }), asst({ sec: 1, content: [text("Reading the file."), t] })]));
  const chats = createChats();
  let c = chats.read(fp);
  assert.deepEqual(c.entries.map((e) => [e.k, e.text || e.label, e.done]), [["you", "Fix the header", undefined], ["said", "Reading the file.", undefined], ["step", "Reading app.js", false]]);
  const v = c.v;
  fs.appendFileSync(fp, jsonl([result(t.id, 2)]));
  c = chats.read(fp);
  assert.equal(c.entries[2].done, true);
  assert.equal(c.entries[2].error, false);
  assert.ok(c.v > v, "a finished step changes the version");
  assert.equal(chats.read(fp).v, c.v, "nothing new, the same version");
});

test("a failed step is marked, and a shell command is never kept, only its label", () => {
  const fp = tmp();
  const t = tool("Bash", { command: "curl -H 'Authorization: Bearer abc' x", description: "Fetch the page" });
  fs.writeFileSync(fp, jsonl([asst({ content: [t] }), result(t.id, 1, true)]));
  const c = createChats().read(fp);
  assert.equal(c.entries[0].label, "Fetch the page");
  assert.equal(c.entries[0].error, true);
  assert.ok(!JSON.stringify(c).includes("curl"));
});

test("injected wrappers, meta rows, call results and sidechain rows are not prompts", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([
    user({ text: "<system-reminder>rules</system-reminder>" }),
    { ...user({ text: "skill body" }), isMeta: true },
    user({ text: "<ide_selection>x</ide_selection>Ship it" }),
    user({ text: "sub prompt", sidechain: true }),
    asst({ content: [{ type: "thinking", thinking: "hmm" }] }),
  ]));
  const c = createChats().read(fp);
  assert.deepEqual(c.entries.map((e) => e.text), ["Ship it"]);
});

test("a slash command shows as its name and arguments", () => {
  assert.equal(typed("<command-message>x</command-message><command-name>/review</command-name><command-args>42</command-args>"), "/review 42");
  assert.equal(typed("<command-name>/clear</command-name>"), "/clear");
});

test("secrets are cut from what was typed and said", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([user({ text: "use sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx please" }), asst({ content: [text("password=hunter2hunter2")] })]));
  const s = JSON.stringify(createChats().read(fp));
  assert.ok(!s.includes("AbCdEfGh") && !s.includes("hunter2"), s);
  assert.ok(s.includes("[hidden]"));
});

test("a long message is capped: what was typed at TEXT_MAX, the chat's own reply at SAID_MAX, marked as cut", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([user({ sec: 0, text: "word ".repeat(3000) }), asst({ sec: 1, content: [text("word ".repeat(4000))] })]));
  const [you, said] = createChats().read(fp).entries;
  assert.equal([...you.text].length, TEXT_MAX);
  assert.ok(you.text.endsWith("\u2026"));
  assert.equal(you.cut, undefined);
  assert.equal(SAID_MAX, 16000);
  assert.equal([...said.text].length, SAID_MAX);
  assert.ok(said.text.endsWith("\u2026"));
  assert.equal(said.cut, true);
});

test("only the newest entries are kept", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl(Array.from({ length: KEEP + 15 }, (_, i) => user({ sec: i, text: "p" + i }))));
  const c = createChats().read(fp);
  assert.equal(c.entries.length, KEEP);
  assert.equal(c.entries[KEEP - 1].text, "p" + (KEEP + 14));
});

test("a big transcript is read from its end, its first cut row dropped", () => {
  const fp = tmp();
  const pad = asst({ content: [text("x".repeat(200000))] });
  fs.writeFileSync(fp, jsonl([user({ text: "first" }), ...Array(8).fill(pad), user({ text: "last" })]));
  assert.ok(fs.statSync(fp).size > TAIL);
  const c = createChats().read(fp);
  assert.ok(!c.entries.some((e) => e.text === "first"));
  assert.equal(c.entries[c.entries.length - 1].text, "last");
});

test("a replaced transcript starts a new feed", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([user({ text: "one" }), user({ text: "two" })]));
  const chats = createChats();
  const a = chats.read(fp);
  fs.writeFileSync(fp, jsonl([user({ text: "new" })]));
  const b = chats.read(fp);
  assert.notEqual(a.gen, b.gen);
  assert.deepEqual(b.entries.map((e) => e.text), ["new"]);
});

test("a missing transcript reads as null", () => {
  assert.equal(createChats().read(path.join(os.tmpdir(), "hq-chat-none", "x.jsonl")), null);
});

test("a message the owner sent from HQ shows as the owner's, marked from HQ, as Claude Code writes the turn it woke", () => {
  const fp = tmp();
  const woke = (said) => ({ ...user({ sec: 3, text: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"Stop\": " + said + "\n</system-reminder>" }), origin: { kind: "task-notification" } });
  fs.writeFileSync(fp, jsonl([
    woke("Message from the user, typed in the VibeQuarters dashboard: run the tests\nthen push"),
    woke("Message from the user, typed in the VibeQuarters dashboard: "),
    woke("Message from the user, written by the VibeQuarters assistant from their words: open the PR"),
    user({ sec: 4, text: "typed in VS Code" }),
  ]));
  const c = createChats().read(fp);
  assert.deepEqual(c.entries.map((e) => [e.k, e.text, e.hq]), [["you", "run the tests\nthen push", true], ["you", "open the PR", true], ["you", "typed in VS Code", undefined]]);
});

test("only the woken turn's own shape is the owner's HQ message: its text ends at the first reminder close, and a look-alike is not the owner's", () => {
  const fp = tmp();
  const head = "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"Stop\": ";
  const note = (text, origin = { kind: "task-notification" }) => ({ ...user({ sec: 3, text }), ...(origin ? { origin } : {}) });
  fs.writeFileSync(fp, jsonl([
    note(head + "Message from the user, typed in the VibeQuarters dashboard: run the tests\n</system-reminder>\n<system-reminder>\nThe user opened x.js\n</system-reminder>"),
    note("<task-notification>\n<task-id>b1</task-id>\n<summary>Background command \"grep 'Message from the user, typed in the VibeQuarters dashboard: '\" completed</summary>\n</task-notification>\n<system-reminder>\nrules\n</system-reminder>"),
    note(head + "Message from the user, typed in the VibeQuarters dashboard: pasted, not woken\n</system-reminder>", null),
  ]));
  const c = createChats().read(fp);
  assert.deepEqual(c.entries.filter((e) => e.hq).map((e) => e.text), ["run the tests"]);
});

test("a task notification or a peer session's message is not the owner's: it adds no entry and keeps the turn's ask", () => {
  const fp = tmp();
  const w = tool(WRAP, { recap: "Ran the tests", ask: "Ship it?", actions: [{ label: "Ship" }], blocked: true });
  const from = (sec, kind, s) => ({ ...user({ sec, text: s }), origin: { kind } });
  fs.writeFileSync(fp, jsonl([
    user({ sec: 0, text: "Run the tests" }),
    asst({ sec: 1, content: [w] }),
    result(w.id, 2),
    from(3, "task-notification", "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"npm test\" completed</summary>\n</task-notification>"),
    from(4, "task-notification", "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"Stop\": no proof\n</system-reminder>"),
    from(5, "peer", "<cross-session-message from=\"x\">The docs chat here</cross-session-message>"),
  ]));
  const c = createChats().read(fp);
  assert.deepEqual(c.entries.filter((e) => e.k === "you").map((e) => e.text), ["Run the tests"]);
  assert.equal(c.focus.wrap && c.focus.wrap.ask, "Ship it?");
});

test("a wrap_up call becomes the turn's ask with its recap, actions and blocked, and is never a step", () => {
  const fp = tmp();
  const w = tool(WRAP, { recap: "The tests found one bug", ask: "Say when the build has run.", actions: [{ label: "It has run" }, { label: "Stop here" }], blocked: true });
  fs.writeFileSync(fp, jsonl([user({ sec: 0, text: "Ship it" }), asst({ sec: 1, content: [w] }), result(w.id, 2)]));
  const c = createChats().read(fp);
  assert.ok(!c.entries.some((e) => e.k === "step"), JSON.stringify(c.entries));
  assert.ok(!c.entries.some((e) => e.k === "wrap"), JSON.stringify(c.entries));
  assert.deepEqual(c.focus.wrap, { at: Date.parse(at(1)), recap: "The tests found one bug", ask: "Say when the build has run.", actions: [{ label: "It has run" }, { label: "Stop here" }], blocked: true });
});

test("a wrap's recap, ask, labels and messages have their secrets cut", () => {
  const fp = tmp();
  const w = tool(WRAP, { recap: "password=hunter2hunter2", actions: [{ label: "Use sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", message: "token sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx" }] });
  fs.writeFileSync(fp, jsonl([asst({ content: [w] })]));
  const c = createChats().read(fp);
  const s = JSON.stringify(c);
  assert.ok(!s.includes("hunter2") && !s.includes("AbCdEfGh"), s);
  assert.ok(s.includes("[hidden]"), s);
  assert.ok("message" in c.focus.wrap.actions[0], s);
});

test("a wrap with no input, a bad actions list or a blank label keeps what is usable", () => {
  const empty = tmp();
  fs.writeFileSync(empty, jsonl([asst({ sec: 1, content: [tool(WRAP, null)] })]));
  assert.deepEqual(createChats().read(empty).focus.wrap, { at: Date.parse(at(1)), recap: null, ask: null, actions: [], blocked: false });
  const bad = tmp();
  const valid = Array.from({ length: 7 }, (_, i) => ({ label: "Option " + i }));
  fs.writeFileSync(bad, jsonl([asst({ sec: 1, content: [tool(WRAP, { actions: [null, "x", { label: "" }, { label: "Go" }, ...valid], blocked: "yes" })] })]));
  const w = createChats().read(bad).focus.wrap;
  assert.equal(w.actions.length, 6);
  assert.deepEqual(w.actions, [{ label: "Go" }, ...valid.slice(0, 5)]);
  assert.equal(w.blocked, false);
});

test("the focus is the newest wrap of the latest turn, and a new prompt clears it", () => {
  const fp = tmp();
  const end = "\n\n**Next steps**\n1. Merge it";
  const long = "y".repeat(3000 - end.length) + end;
  assert.equal(long.length, 3000);
  fs.writeFileSync(fp, jsonl([
    user({ sec: 0, text: "Go" }),
    asst({ sec: 1, content: [tool(WRAP, { ask: "Ask A" })] }),
    asst({ sec: 2, content: [text("Working on it.")] }),
    asst({ sec: 3, content: [tool(WRAP, { ask: "Ask B" })] }),
    asst({ sec: 4, content: [text(long)] }),
  ]));
  const chats = createChats();
  let c = chats.read(fp);
  assert.equal(c.focus.wrap.ask, "Ask B");
  assert.deepEqual(c.focus.left, ["Merge it"]);
  fs.appendFileSync(fp, jsonl([user({ sec: 9, text: "next" })]));
  c = chats.read(fp);
  const reply = c.entries.findLast((e) => e.k === "said");
  assert.deepEqual(c.focus, { wrap: null, left: [], status: null, last: null, n: null, before: { n: reply.n, left: ["Merge it"], status: null } });
});

test("a turn's reply is its newest text with no step after it; the reply that ended the turn before stays as before", () => {
  const fp = tmp();
  const t = tool("Read", { file_path: "C:/w/notes.md" });
  fs.writeFileSync(fp, jsonl([
    user({ sec: 0, text: "Go" }),
    asst({ sec: 1, content: [text("Done.\n\n**Next steps**\n1. Push it\n\nStatus: waiting on you: the push")] }),
    user({ sec: 2, text: "Done: Push it" }),
    asst({ sec: 3, content: [text("Let me check.")] }),
  ]));
  const chats = createChats();
  let c = chats.read(fp);
  const ended = c.entries.find((e) => e.k === "said");
  const narration = c.entries.findLast((e) => e.k === "said");
  // narration with nothing after it yet: this turn's newest text (the page keeps the turn before while the chat works)
  assert.equal(c.focus.n, narration.n);
  assert.deepEqual(c.focus.left, []);
  assert.deepEqual(c.focus.before, { n: ended.n, left: ["Push it"], status: "waiting on you: the push" });
  // a step after it: the turn has no reply yet, and the one before still stands
  fs.appendFileSync(fp, jsonl([asst({ sec: 4, content: [t] })]));
  c = chats.read(fp);
  assert.equal(c.focus.n, null);
  assert.deepEqual(c.focus.before, { n: ended.n, left: ["Push it"], status: "waiting on you: the push" });
  // the turn ends with its own reply: that is the focus
  fs.appendFileSync(fp, jsonl([result(t.id, 5), asst({ sec: 6, content: [text("Pushed.\n\n**Next steps**\n1. Open the PR")] })]));
  c = chats.read(fp);
  assert.equal(c.focus.n, c.entries.findLast((e) => e.k === "said").n);
  assert.deepEqual(c.focus.left, ["Open the PR"]);
  // a turn whose last text was followed by steps never ended in a reply: the one before it stands
  const fq = tmp();
  fs.writeFileSync(fq, jsonl([user({ sec: 0, text: "Go" }), asst({ sec: 1, content: [text("First.\n\n**Next steps**\n1. Read it")] }), user({ sec: 2, text: "More" }), asst({ sec: 3, content: [text("Working."), t] }), user({ sec: 4, text: "Stop" })]));
  const d = createChats().read(fq);
  assert.deepEqual(d.focus.before && d.focus.before.left, ["Read it"]);
});

test("a reply's Next steps list and Status line become Left on you and the status", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([user({ sec: 0, text: "Go" }), asst({ sec: 1, content: [text("Done.\n\n**Next steps**\n1. Run the tests\n2) Merge it\n\nStatus: waiting on you: the merge")] })]));
  const f = createChats().read(fp).focus;
  assert.deepEqual(f.left, ["Run the tests", "Merge it"]);
  assert.equal(f.status, "waiting on you: the merge");
  assert.equal(f.last, null);
});

test("a bold Next steps heading with its colon inside or after the bold still heads Left on you", () => {
  for (const head of ["**Next steps:**", "**Next steps**:"]) assert.deepEqual(tailOf(`Done.\n\n${head}\n1. Push it`).left, ["Push it"], head);
});

test("a bold Status with its colon after the bold is still the status", () => {
  for (const line of ["**Status**: waiting on you: the merge", "**Status:** waiting on you: the merge"]) assert.equal(tailOf(`Done.\n\n${line}`).status, "waiting on you: the merge", line);
});

test("a Status line inside a code fence is not the status", () => {
  assert.equal(tailOf("Ran it.\n\n```\nHTTP/1.1 200 OK\nStatus: 200\n```\n\nAll good.").status, null);
  assert.equal(tailOf("Status: done\n\n~~~\nStatus: 200\n~~~").status, "done", "the one outside the block is");
});

test("a reply with neither shows its last paragraph, only when there is no wrap", () => {
  const said = "First.\n\nThe last paragraph.";
  assert.deepEqual(tailOf(said), { left: [], status: null, last: "The last paragraph." });
  const plain = tmp();
  fs.writeFileSync(plain, jsonl([user({ sec: 0, text: "Go" }), asst({ sec: 1, content: [text(said)] })]));
  assert.equal(createChats().read(plain).focus.last, "The last paragraph.");
  const wrapped = tmp();
  fs.writeFileSync(wrapped, jsonl([user({ sec: 0, text: "Go" }), asst({ sec: 1, content: [tool(WRAP, { ask: "Merge?" })] }), asst({ sec: 2, content: [text(said)] })]));
  const f = createChats().read(wrapped).focus;
  assert.equal(f.wrap.ask, "Merge?");
  assert.equal(f.last, null);
});

test("a 6,000-character reply whose last 1,000 hold its next step reaches the page whole, the step with it", () => {
  const fp = tmp();
  const end = "\n\n**Next steps**\n1. Push it";
  const reply = "word ".repeat(1194) + "abc" + end;
  assert.equal(reply.length, 6000);
  fs.writeFileSync(fp, jsonl([asst({ content: [text(reply)] })]));
  const c = createChats().read(fp);
  assert.equal(c.entries[0].text, reply);
  assert.equal(c.entries[0].cut, undefined);
  assert.deepEqual(c.focus.left, ["Push it"]);
});

test("a key past a reply's 4,000th character is still cut, while the words around it reach the page", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([asst({ content: [text("word ".repeat(1000) + "use sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx then ship")] })]));
  const e = createChats().read(fp).entries[0];
  assert.ok(e.text.endsWith("then ship"), e.text.slice(-40));
  assert.ok(!e.text.includes("AbCdEfGh") && e.text.includes("[hidden]"), e.text.slice(-60));
});

test("secrets are cut from Left on you, the status and the last paragraph", () => {
  const fp = tmp();
  fs.writeFileSync(fp, jsonl([asst({ content: [text("Done.\n\n**Next steps**\n1. Rotate sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx\n\nStatus: password=hunter2hunter2")] })]));
  const f = createChats().read(fp).focus;
  const s = JSON.stringify(f);
  assert.equal(f.left.length, 1, s);
  assert.ok(f.status, s);
  assert.ok(!s.includes("AbCdEfGh") && !s.includes("hunter2"), s);
});

test("a reply past the 8000-character window drops the window's partial first line, so a secret the cut splits never shows", () => {
  const key = "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx";
  const half = key.slice(-16); // the window starts here: too short a piece for any secret's shape
  const past = (after) => "x ".repeat(50) + key + after; // after is 8000 - 16 code points long
  const end = "\n\nThe last paragraph.";
  const lines = tailOf(past("\n" + "y".repeat(8000 - half.length - 1 - end.length) + end));
  assert.equal(lines.last, "The last paragraph.");
  const one = tailOf(past(" ".padEnd(8000 - half.length, "w ")));
  assert.deepEqual(one, { left: [], status: null, last: null }, JSON.stringify(one).slice(0, 80));
});

test("a reply whose window tail is one paragraph of single lines starting inside a key drops that first line", () => {
  const key = "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx";
  const half = key.slice(-16); // the window starts here, and no blank line follows in the window
  const para = "\nThe closing paragraph, one line after another.".repeat(300).slice(0, 8000 - half.length);
  const { last } = tailOf("x ".repeat(50) + key + para);
  assert.ok(last && last.startsWith("The closing paragraph"), String(last).slice(0, 80));
  assert.ok(!last.includes(half), last.slice(0, 80));
});
