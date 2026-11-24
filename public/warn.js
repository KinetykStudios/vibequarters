// The warning colors, one rule for every place HQ shows them. Amber ("warn") is a heads-up to plan for; red ("bad") is
// act now. A warned item's words say what is wrong, and its title says what the color means and what to do.
import { dur, usd } from "./format.js";

// context, % of the point where the chat auto-compacts: amber is time to compact, red time to hand off to a fresh chat
// (HQ says the same out loud, lib/heads-up.js)
export const CTX = [75, 90];
export const CACHE = [10 * 60e3, 2 * 60e3]; // a warm prompt cache's time left
export const STUCK = [10 * 60e3, 20 * 60e3]; // working with no new step (a tool call with no result past 30 min reads as idle)
export const PLAN = [75, 90]; // the weekly plan limit used, %

const up = (v, [a, b]) => (v >= b ? "bad" : v >= a ? "warn" : null);
const down = (v, [a, b]) => (v <= b ? "bad" : v <= a ? "warn" : null);
const COLOR = { warn: "Amber", bad: "Red" };

// How full the chat's context is
export function ctxWarn(s) {
  const pct = s && s.context ? s.context.pct : null;
  const level = pct == null ? null : up(pct, CTX);
  if (!level) return null;
  return {
    level,
    short: level === "bad" ? `context ${pct}%, hand off` : `context ${pct}%, compact`,
    tip: level === "bad"
      ? `${COLOR.bad}: context is ${pct}% full. Time to hand off to a fresh chat: ask it for a handoff prompt, then open a new chat with it. At 100% it auto-compacts and drops detail.`
      : `${COLOR.warn}: context is ${pct}% full. Time to compact: let it finish its step, then type /compact in the chat. It auto-compacts at 100% (red from ${CTX[1]}%: hand off).`,
  };
}
// A warm prompt cache about to go cold
export function cacheWarn(s, now) {
  const c = s && s.cache;
  if (!c || c.state !== "warm") return null;
  const left = c.expiresAt - now, level = down(left, CACHE);
  if (!level) return null;
  const wake = c.wakeCost != null ? `, and the next message pays about ${usd(c.wakeCost)} to rebuild it` : "";
  return {
    level,
    short: `cache ${dur(Math.max(0, left))} left`,
    tip: level === "bad"
      ? `${COLOR.bad}: the prompt cache goes cold in under ${dur(CACHE[1])}${wake}. Send the next message now if you want it cheap.`
      : `${COLOR.warn}: the prompt cache goes cold in under ${dur(CACHE[0])}${wake} (red from ${dur(CACHE[1])} left).`,
  };
}
// Working, not waiting on a helper, with no new step for a while: a tool call may be hung
export function stuckWarn(s, now) {
  if (!s || s.status !== "working" || s.waitsOn || !s.lastAt) return null;
  const quiet = now - s.lastAt, level = up(quiet, STUCK);
  if (!level) return null;
  return {
    level,
    short: `no new step in ${dur(quiet)}`,
    tip: `${COLOR[level]}: this chat says it is working but nothing new has happened for ${dur(quiet)}. A tool call may be hung; open the chat to check${level === "warn" ? ` (red from ${dur(STUCK[1])})` : ""}.`,
  };
}
// Every warning a session carries, worst first
export function warningsOf(s, now) {
  return [ctxWarn(s), cacheWarn(s, now), stuckWarn(s, now)].filter(Boolean).sort((a, b) => (a.level === "bad" ? 0 : 1) - (b.level === "bad" ? 0 : 1));
}
// The weekly plan limit, from the usage mod's last reading (lib/accounts.js planOf); null when unknown or past its reset
export function planWarn(p, now) {
  if (!p || p.pct == null || (p.resetsAt && p.resetsAt <= now)) return null;
  return { level: up(p.pct, PLAN), pct: p.pct };
}
