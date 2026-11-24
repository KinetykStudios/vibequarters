// How much VibeQuarters approves for the user: one of four presets, picked on the page's first run (the chooser) and
// changeable later from the header's Approvals button. The choice is saved in the app's state folder
// (<stateDir>/approvals-choice.json: { v: 1, preset, at }). Each preset's lists are a file the system pack installs,
// <systemDir>/presets/approvals/<id>.json, in the shape of approval-levels.json; when the system pack is not installed
// (or a preset file cannot be read) the app falls back to its own approval-levels.json, so it never breaks and never
// approves more than that file does; "ask me everything" then approves nothing at all. With no choice saved, the app's own approval-levels.json is used.
//
// The never-auto list (approval-levels.json "yours": deletes, force pushes, hard resets, skipped hooks, deploys,
// publishing, money tools) is a floor no preset can lower: every preset's "yours" lists are joined with the app's own.
// The page can only pick a preset by id; it can never write a list, and nothing here writes approval-levels.json or a
// preset file.
//
// Approvals still happen only inside an approve window the user opens (lib/window.js); outside one, every prompt waits
// for a click whatever the preset.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadLevels } = require("./levels");

const PRESETS = [
  { id: "ask-all", title: "Ask me everything", line: "Nothing is approved for you. Every permission prompt waits for your click." },
  { id: "safe-reads", title: "Approve safe reads", line: "Reading and searching files and looking at git history go through on their own. Anything that changes something asks you." },
  { id: "routine", title: "Approve routine coding work", line: "Everyday coding steps such as tests, lint and commits go through. File edits and anything risky ask you.", recommended: true },
  { id: "routine-judge", title: "Routine plus an AI judge for the rest", line: "Routine work goes through, and a quick AI check on your own Claude login looks at the rest. Anything risky or unclear still asks you." },
];
const IDS = new Set(PRESETS.map((p) => p.id));
const NEVER_AUTO = "Deletes, force pushes, hard resets, skipped commit hooks, deploys, publishing and money tools ask you, whichever you pick, when the command itself says so.";
const CHOICE_MAX = 4 * 1024;

function createApprovals({ stateDir, systemDir, levelsFile }) {
  const choiceFile = path.join(stateDir, "approvals-choice.json");
  const presetFile = (id) => (systemDir ? path.join(systemDir, "presets", "approvals", id + ".json") : null);

  // The saved preset id, or null when none is saved (first run) or the file is not one VibeQuarters wrote
  function chosen() {
    try {
      if (fs.statSync(choiceFile).size > CHOICE_MAX) return null;
      const j = JSON.parse(fs.readFileSync(choiceFile, "utf8"));
      return j && j.v === 1 && IDS.has(j.preset) ? j.preset : null;
    } catch {
      return null;
    }
  }

  // Saves a preset by id: { ok: true } or { ok: false, error }. Temp plus rename, so a reader never sees half a file.
  function choose(body, now = Date.now()) {
    if (!body || typeof body.preset !== "string" || !IDS.has(body.preset)) return { ok: false, error: "preset must be one of " + [...IDS].join(", ") };
    const tmp = choiceFile + ".tmp" + process.pid;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, preset: body.preset, at: now }) + "\n");
      fs.renameSync(tmp, choiceFile);
      return { ok: true };
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: "could not save the choice" };
    }
  }

  // The lists an approve window uses now, { levels, preset, fromSystem, judge }: the chosen preset's lists with the
  // app's never-auto list joined in, or the app's own lists (no choice, or the preset file is missing or unreadable).
  // levels is null only when the app's own file cannot be read, which makes everything "yours".
  function current() {
    const base = loadLevels(levelsFile);
    const id = chosen();
    const file = id ? presetFile(id) : null;
    const own = file ? loadLevels(file) : null;
    if (!own || !base) return { levels: base && id === "ask-all" ? { routine: { tools: [], commands: [], hooks: [] }, yours: base.yours } : base, preset: id, fromSystem: false, judge: false };
    const yours = {};
    for (const k of Object.keys(base.yours)) yours[k] = [...new Set([...base.yours[k], ...own.yours[k]])];
    return { levels: { routine: own.routine, yours }, preset: id, fromSystem: true, judge: id === "routine-judge" };
  }

  // What the page shows: the four presets with whether the system pack holds each one's file, the saved choice (null on
  // first run), and the never-auto sentence
  function view() {
    const id = chosen();
    return {
      chosen: id,
      presets: PRESETS.map((p) => ({ ...p, recommended: !!p.recommended, installed: !!(presetFile(p.id) && loadLevels(presetFile(p.id))) })),
      neverAuto: NEVER_AUTO,
    };
  }

  return { chosen, choose, current, view };
}

module.exports = { createApprovals, PRESETS, NEVER_AUTO };
