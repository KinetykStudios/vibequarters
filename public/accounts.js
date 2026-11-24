// The accounts strip's words (lib/accounts.js sends vitals.accounts): one part per account, soonest reset first, as
// "Work Mon 9am"; the signed-in one is marked, the next to reset reads "next", and each part's tooltip carries the last
// % seen and the exact reset. Labels are the ones the user sets in the config (accountLabels), else "Account 1" and so
// on; no email is ever shown. tz is for tests; the page uses the browser's own time zone.
function when(t, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).formatToParts(new Date(t));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const min = get("minute") === "00" ? "" : ":" + get("minute");
  return `${get("weekday")} ${get("hour")}${min}${String(get("dayPeriod")).toLowerCase()}`;
}

export function accountsLine(view, tz) {
  if (!view || !Array.isArray(view.rows) || !view.rows.length) return [];
  const rows = view.rows.slice().sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));
  return rows.map((r) => {
    const label = String(r.label || "Account");
    const reset = r.resetsAt == null ? null : new Date(r.resetsAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
    const seen = r.lastSeenPct == null ? "Last % not seen yet: use it once and it records itself." : `Last seen ${r.lastSeenPct}% used${r.seenAt ? " on " + new Date(r.seenAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz }) : ""}.`;
    const tip = [`${label}${r.current ? ", signed in now" : ""}${r.next ? ", the next to reset" : ""}.`, seen, reset ? `Weekly limit resets ${reset}.` : "Reset time not known yet."].join(" ");
    const text = `${r.next ? "next " : ""}${label} ${r.resetsAt == null ? "?" : when(r.resetsAt, tz)}`;
    return { text, current: !!r.current, next: !!r.next, tip };
  });
}

// The plan meter's words: "Plan 62%" and, when the usage-line mod reports it, the 5-hour window too
export function planText(plan) {
  if (!plan || plan.pct == null) return null;
  return { short: `Plan ${plan.pct}%`, long: plan.fiveHour == null ? " this week" : ` this week · 5h ${plan.fiveHour}%` };
}
