// How much VibeQuarters approves for the user: the chooser, a card over the page with the four presets (lib/approvals.js),
// each with one plain line. On a first run (no saved choice, and the page can save one) it opens by itself, once per tab; afterwards
// the header's Approvals button opens it. It posts a preset's id and nothing else: the lists themselves, and the list of
// what is never approved, cannot be edited from the page.
import { el } from "./dom.js";
import { post } from "./control.js";

export const TITLE = "How much should VibeQuarters approve for you?";
export const READ_ONLY = "VibeQuarters is read-only now, so this cannot be changed here. Set \"control\": true in hq.config.json and restart.";
export const NOT_INSTALLED = "Its list comes with the system pack, which is not installed. Until then only the short built-in list is used.";
export const ASK_NOT_INSTALLED = "Works without the system pack: nothing is approved for you.";
const NOT_SAVED = "The choice did not save. Try again in a moment.";

// The chooser's state from GET /api/approvals: whether it opens by itself, the rows, the one picked to start with (the
// saved one, else the recommended one), and the note. Pure, so the tests read it.
export function chooserOf(view) {
  if (!view || !Array.isArray(view.presets) || !view.presets.length) return null;
  const first = view.chosen == null;
  const rec = view.presets.find((p) => p.recommended) || view.presets[0];
  return {
    open: first && view.canChoose === true,
    canChoose: view.canChoose === true,
    picked: first ? rec.id : view.chosen,
    rows: view.presets.map((p) => ({
      id: p.id, title: p.title, line: p.line, recommended: !!p.recommended, current: p.id === view.chosen,
      note: p.installed ? null : p.id === "ask-all" ? ASK_NOT_INSTALLED : NOT_INSTALLED,
    })),
    neverAuto: view.neverAuto,
    note: view.canChoose === true ? null : READ_ONLY,
  };
}

let ui = null; // { scrim, card, list, say, save, note, never }
let state = null; // chooserOf's last answer
let opener = null;
let saving = false;

function build() {
  const list = el("div", { class: "ap-list", role: "radiogroup", "aria-labelledby": "ap-title" });
  const never = el("p", { class: "ap-never" });
  const note = el("p", { class: "ap-note", hidden: true });
  const say = el("p", { class: "ap-say", role: "status", hidden: true });
  const save = el("button", { type: "button", class: "ap-save", text: "Save", onclick: send });
  const later = el("button", { type: "button", class: "quiet", text: "Not now", onclick: close });
  const card = el("div", { class: "ask-card ap-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "ap-title" },
    el("div", { class: "ask-top" }, el("h2", { class: "ask-title", id: "ap-title", text: TITLE }), el("button", { type: "button", class: "ask-x", "aria-label": "Close", text: "×", onclick: close })),
    el("p", { class: "ap-lead", text: "VibeQuarters can answer Claude Code's permission prompts while you keep an approve window open. Pick how far it may go; change it any time from Approvals in the header." }),
    list, never, note, say, el("div", { class: "ap-foot" }, save, later));
  const scrim = el("div", { class: "ask-pop", hidden: true, onclick: (e) => { if (e.target === e.currentTarget) close(); } }, card);
  ui = { scrim, card, list, say, save, note, never, later };
  document.body.append(scrim);
}

function fill() {
  ui.list.replaceChildren(...state.rows.map((r) => el("label", { class: "ap-row" },
    el("input", { type: "radio", name: "approvals-preset", value: r.id, checked: r.id === state.picked, disabled: !state.canChoose }),
    el("span", { class: "ap-text" },
      el("span", { class: "ap-t" }, r.title, r.recommended ? el("span", { class: "ap-rec", text: "Recommended" }) : null, r.current ? el("span", { class: "ap-cur", text: "Current" }) : null),
      el("span", { class: "ap-l", text: r.line }),
      r.note ? el("span", { class: "ap-n", text: r.note }) : null))));
  ui.never.textContent = state.neverAuto || "";
  ui.note.textContent = state.note || "";
  ui.note.hidden = !state.note;
  ui.say.hidden = true;
  ui.save.hidden = !state.canChoose;
  ui.later.textContent = state.canChoose ? "Not now" : "Close";
}

function open() {
  if (!state) return;
  if (!ui) build();
  opener = document.activeElement;
  fill();
  ui.scrim.hidden = false;
  const on = ui.list.querySelector("input:checked:not([disabled])") || ui.later;
  on.focus();
}
const LATER = "hq-approvals-later"; // closed without a choice: it does not open by itself again in this tab
const later = () => { try { return sessionStorage.getItem(LATER) === "1"; } catch { return false; } };
function close() {
  if (!ui || ui.scrim.hidden) return;
  try { sessionStorage.setItem(LATER, "1"); } catch {} // no storage: it opens again on the next load
  ui.scrim.hidden = true;
  if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  opener = null;
}

async function send() {
  const on = ui.list.querySelector("input:checked");
  if (!on || saving) return;
  saving = ui.save.disabled = true;
  const ok = await post("/api/approvals", { preset: on.value });
  saving = ui.save.disabled = false;
  if (!ok) {
    ui.say.textContent = NOT_SAVED;
    ui.say.hidden = false;
    return;
  }
  await read();
  close();
}

async function read() {
  try {
    const r = await fetch("/api/approvals", { cache: "no-store" });
    if (r.ok) state = chooserOf(await r.json());
  } catch {} // the button stays as it was; the next page load reads again
}

export async function startApprovals(button) {
  button.addEventListener("click", async () => {
    await read(); // what another tab saved meanwhile
    open();
  });
  // Esc closes the chooser and Tab stays inside it
  addEventListener("keydown", (e) => {
    if (!ui || ui.scrim.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === "Tab") {
      // the checked radio stands for its group, as the browser's own Tab order has it
      const f = [...ui.card.querySelectorAll("button, input")].filter((n) => !n.disabled && !n.hidden && (n.type !== "radio" || n.checked));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) {
        e.preventDefault();
        f[e.shiftKey ? f.length - 1 : 0].focus();
      }
    }
  }, true);
  await read();
  button.hidden = !state;
  if (state && state.open && !later()) open();
}
