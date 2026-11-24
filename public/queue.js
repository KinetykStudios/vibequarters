// The Queue panel on the Dashboard: what every session waits on, in plain words. It reads /api/queue (lib/queue.js)
// every 10 s while the Dashboard shows and the page is visible, and only reads: nothing here can change the
// coordination files. Names, tasks and file paths go through Streamer mode's mask. With no coordination folder (the
// system pack is not installed, or no session has registered) the panel stays hidden.
import { el } from "./dom.js";
import { shown, onStreaming } from "./streamer.js";

const EVERY_MS = 10e3;
const ACTIVE_MS = 15 * 60e3; // seen this recently counts as working now; the rest fold under "more"
const FREE = { merge: "No merge running", "db-migration": "No database change running", "edge-deploy": "No server function deploy running", "prod-deploy": "No live site deploy running" };

export function age(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export function gateLines(g, now) {
  const cpu = g.cpu == null ? "PC load being measured" : `PC load ${g.cpu}%`;
  let head;
  if (g.state === "busy") head = `Busy: ${g.holder.job} for ${shown(g.holder.session)}, ${g.holder.starting ? "starting" : age(now - g.holder.since)}${g.holder.background ? " (in the background)" : ""}`;
  else if (g.state === "cpu") head = g.waiting.length ? `Waiting for the PC (CPU ${g.cpu}%)` : `PC is busy (CPU ${g.cpu}%): a new heavy job would wait`;
  else if (g.state === "measuring") head = "Checking the PC load";
  else head = "Free: a heavy job can start now";
  const sub = g.state === "cpu" ? `Heavy jobs start only under ${g.startMax}% CPU.` : g.state === "measuring" ? "Ready at the next update, in about 10 s." : `${cpu}.`;
  const wait = g.waiting.length ? `Waiting: ${g.waiting.map((w) => `${shown(w.session)} (${age(now - w.at)})`).join(", ")}` : "Nobody is waiting.";
  return { head, note: LIVE_NOTE[g.liveCheck] || null, sub: g.others ? `${sub} ${g.others} more heavy ${g.others === 1 ? "job" : "jobs"} also holding.` : sub, wait };
}

// what the gate can and cannot know about a claim past its start (lib/queue.js liveCheck); null when it checks them
export const LIVE_NOTE = {
  on: null,
  "no-hooks": "Which heavy jobs still run is not checked: the system pack is not installed. A job holds the gate until its time limit.",
  unavailable: "Which heavy jobs still run is not available on this OS. A job holds the gate until its time limit.",
};

export function lockLine(l, now) {
  if (!l.holder) return FREE[l.name] || `${l.words}: free`;
  if (l.stale) return `${FREE[l.name] || l.words}. ${shown(l.holder)} left a lock ${age(now - l.since)} ago that no longer blocks.`;
  return `${l.words}: ${shown(l.holder)}, ${age(now - l.since)}`;
}

// the words name the one check a batch needs to land (lib/queue.js ciState)
const CI = { passed: "checks passed", failed: "checks failed", running: "checks running", skipped: "checks skipped, so it cannot land", none: "no checks yet" };

// a member's review as the land gate reads it (lib/queue.js reviewState) why merge-batch would refuse to land a batch
// (lib/queue.js queueView, merge-batch.js planLand)
const REBUILD = { batch: "the batch PR changed", main: "the main branch has moved on", member: "a PR in it changed", nothing: "it stopped before any PR landed" };
// A batch's headline: landing progress once landing started, else why it must be rebuilt, else its checks.
// "merged or closed": a member that left the open list may have been closed without merging.
export function batchWords(b) {
  const l = b.landing;
  if (l) return `${l.partial ? "stopped partway" : "landing"}, ${l.merged} of ${l.total} merged or closed${l.moved ? "; a PR in it changed, so it cannot land as planned" : ""}${l.partial ? "; check what the merge tool said before anything else lands" : ""}`;
  if (b.rebuild) return `needs a rebuild before it can land (${REBUILD[b.rebuild]})`;
  return CI[b.ci] || b.ci;
}
const REVIEW = { clean: "reviewed, clean", unproven: "reviewed clean, but it needs a new review before it can merge", problems: "review found problems", none: "not reviewed yet" };

// The asker may take a file over after 15 min, or at once when its owner has closed (coord-requests.js).
export function requestFlag(r) {
  if (r.ownerClosed) return ". The owner has closed: the asker may take the file over now, with your yes";
  if (r.overdue) return ". Over 15 min: the asker may take the file over, with your yes";
  return "";
}

const block = (title, ...kids) => el("section", { class: "q-block" }, el("h3", { text: title }), ...kids);
const line = (text, cls) => el("p", { class: cls ? `q-line ${cls}` : "q-line", text });

let moreOpen = false;
function sessionsBlock(list, now) {
  const active = list.filter((s) => s.live && now - (s.lastSeen || 0) < ACTIVE_MS);
  const rest = list.filter((s) => !active.includes(s));
  const row = (s) =>
    el("li", {},
      el("p", { class: "q-name", text: shown(s.name) }),
      s.task ? el("p", { class: "q-sub", text: shown(s.task) }) : null,
      el("p", { class: "q-meta", text: `${s.live ? `Seen ${age(now - (s.lastSeen || now))} ago` : "Closed"}, ${s.files} ${s.files === 1 ? "file" : "files"} claimed` }));
  const closed = list.filter((s) => !s.live).length;
  const summary = `${active.length} working now, ${rest.length - closed} quiet, ${closed} closed today`;
  const more = rest.length
    ? el("details", { class: "q-more", open: moreOpen, ontoggle: (e) => { moreOpen = e.target.open; } }, el("summary", { text: `Show ${rest.length} more` }), el("ul", { class: "q-list" }, rest.map(row)))
    : null;
  return block("Sessions", line(summary, "q-muted"), active.length ? el("ul", { class: "q-list" }, active.map(row)) : null, more);
}

export function renderQueue(root, q, now = Date.now(), note = "") {
  root.hidden = q.present === false; // no coordination folder: nothing to show
  if (root.hidden) return;
  const g = gateLines(q.gate, now);
  const reqs = q.requests.length
    ? el("ul", { class: "q-list" }, q.requests.map((r) =>
        el("li", {},
          el("p", { class: "q-name", text: `${shown(r.from)} asks ${shown(r.to)}` }),
          el("p", { class: "q-sub", text: shown(r.path) }),
          el("p", { class: "q-meta" + (r.overdue || r.ownerClosed ? " q-flag" : ""), text: `${r.id}, ${age(now - r.at)}${requestFlag(r)}` }))))
    : line("No open requests.", "q-muted");
  let batches;
  if (!q.batches) batches = line(q.github === "off" ? "Batches are not shown: list your repositories under queue.repos in the config." : q.github === "loading" ? "Checking GitHub." : "GitHub could not be read just now.", "q-muted");
  else if (!q.batches.length) batches = line("No batches in flight.", "q-muted");
  else batches = el("ul", { class: "q-list" }, q.batches.map((b) =>
    el("li", {},
      el("p", { class: "q-name" + (b.ci === "failed" || b.rebuild || (b.landing && (b.landing.partial || b.landing.moved)) ? " q-flag" : ""), text: `Batch PR #${b.batchPr}: ${batchWords(b)}` }),
      el("p", { class: "q-meta", text: `${shown(b.repo)}, batch ${b.id}${b.otherFailed ? `; ${b.otherFailed} optional ${b.otherFailed === 1 ? "check" : "checks"} failed, which does not block it` : ""}` }),
      b.members.map((m) => el("p", { class: "q-sub", text: `#${m.pr} ${shown(m.title)}, ${m.moved ? "changed since the batch was built" : REVIEW[m.review] || REVIEW.none}` })))));
  // each list that scrolls inside its block keeps its place across the 10 s redraw, keyed by its block and order
  const keyOf = (n) => { const s = n.closest(".q-block"); return `${s ? s.firstChild.textContent : ""}#${s ? [...s.querySelectorAll(".q-list")].indexOf(n) : 0}`; };
  const scrolled = new Map([...root.querySelectorAll(".q-list")].filter((n) => n.scrollTop).map((n) => [keyOf(n), n.scrollTop]));
  root.replaceChildren(
    el("div", { class: "nh" }, el("h2", { text: "Queue" }), el("p", { class: "q-muted q-when", text: note || "Updates every 10 s" })),
    block("Heavy jobs", line(g.head, "q-name"), line(g.sub, "q-muted"), line(g.wait), g.note ? line(g.note, "q-muted") : null),
    block("Locks", el("ul", { class: "q-list" }, q.locks.map((l) => el("li", {}, el("p", { class: l.holder && !l.stale ? "q-name" : "q-muted", text: lockLine(l, now) }))))),
    block("Requests", reqs),
    block("Batches in flight", batches,
      q.unreadBatches ? line("Some batches are in a project GitHub could not be read just now, so they are not shown.", "q-muted") : null,
      q.leftoverBatches ? line(`${q.leftoverBatches} older batch ${q.leftoverBatches === 1 ? "PR is" : "PRs are"} still open on GitHub, replaced by newer batches or already merged.`, "q-muted") : null),
    sessionsBlock(q.sessions, now),
  );
  if (scrolled.size) for (const n of root.querySelectorAll(".q-list")) if (scrolled.has(keyOf(n))) n.scrollTop = scrolled.get(keyOf(n));
}

// The poll: every 10 s while the Dashboard shows and the page is visible. A failed read leaves the last view up,
// its header saying how old it is, so a lock or a busy gate never looks current when it is not.
export function staleNote(at, now) {
  return `Could not refresh; showing the queue from ${age(now - at)} ago`;
}
export function startQueue(root, { visible }) {
  let last = null, failed = false;
  const draw = () => { if (last) renderQueue(root, last, Date.now(), failed ? staleNote(last.at, Date.now()) : ""); };
  async function tick() {
    if (document.visibilityState !== "visible" || !visible()) return;
    try {
      const r = await fetch("/api/queue", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      last = await r.json();
      failed = false;
    } catch {
      failed = true;
      if (!last) root.replaceChildren(el("div", { class: "nh" }, el("h2", { text: "Queue" })), line("The queue could not be read just now.", "q-muted"));
    }
    draw();
  }
  onStreaming(draw); // a Streamer toggle masks the names now, not at the next read
  setInterval(tick, EVERY_MS);
  document.addEventListener("visibilitychange", tick);
  tick();
  return { tick };
}
