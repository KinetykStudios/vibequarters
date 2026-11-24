// The 30-second reminder. When an approval has waited 30 seconds and HQ will not approve it itself, HQ says one short
// line. Each approval is said once; one HQ will approve itself (an approve window covering it, by the levels or the
// judge) is not said while that holds. Questions, notices and finished turns are not approvals. Memory only.
"use strict";

function createReminder({ delayMs = 30e3 } = {}) {
  const said = new Set();
  return {
    // The line to say now for the approvals newly due among items (the payload's decisions), or null
    next(items, isAuto, now) {
      const open = new Set(items.map((d) => d.id));
      for (const id of said) if (!open.has(id)) said.delete(id);
      const due = items.filter((d) => d.kind === "permission" && !d.notice && Number.isFinite(d.askedAt) && now - d.askedAt >= delayMs && !said.has(d.id) && !isAuto(d));
      for (const d of due) said.add(d.id);
      if (!due.length) return null;
      return due.length === 1 ? "You have something to approve." : `You have ${due.length} things to approve.`;
    },
  };
}

module.exports = { createReminder };
