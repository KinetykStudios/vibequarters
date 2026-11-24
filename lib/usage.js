// The usage test: the assistant's spend this week beside everything this week, split Sonnet and Opus. A week is the
// last 7 UTC days, the days the daily totals (computeStats' last30) are kept by, so both sides cover the same hours.
// The assistant's chats are transcripts, so they are already inside last30; the drafter runs with no transcript,
// so its rows are added to the total as well as to the assistant's share.
const DAY = 86400e3;
const dayOf = (at) => {
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

// sessions: the assistant's chats' cache states (lib/cache.js `spend`); drafter: { at, costUsd, model } rows.
function weekUsage({ sessions, drafter, last30, now }) {
  const week = new Set(Array.from({ length: 7 }, (_, i) => dayOf(now - i * DAY)));
  const byModel = { sonnet: 0, opus: 0 };
  let assistantUsd = 0;
  const add = (model, usd) => {
    assistantUsd += usd;
    if (/sonnet/i.test(model)) byModel.sonnet += usd;
    else if (/opus/i.test(model)) byModel.opus += usd;
  };
  for (const s of sessions || [])
    for (const day in (s && s.spend) || {}) if (week.has(day)) for (const model in s.spend[day]) add(model, s.spend[day][model]);
  let drafterUsd = 0;
  for (const r of drafter || []) {
    if (!r || !Number.isFinite(r.costUsd) || !week.has(dayOf(r.at))) continue;
    add(r.model, r.costUsd);
    drafterUsd += r.costUsd;
  }
  let totalUsd = drafterUsd;
  for (const d of last30 || []) if (week.has(d.date)) totalUsd += d.cost;
  return { assistantUsd, totalUsd, byModel, share: totalUsd > 0 ? assistantUsd / totalUsd : 0 };
}

module.exports = { weekUsage };
