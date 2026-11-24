import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Shows how much of the plan's rate-limit windows is used as a status line under the prompt, and saves the weekly
// reading to ~/.claude/vibequarters-usage/ for the VibeQuarters app's plan and accounts line.

const LABEL: Record<string, string> = { seven_day: 'Week', five_hour: '5h', spend_limit: 'Spend' }
const ORDER = ['seven_day', 'five_hour']
const WEEK_MS = 7 * 24 * 3600e3
const WARN_FROM = 50 // default percent of the week used before the run-out time shows (usageLine.warnFrom)
const RECENT_MS = 12 * 3600e3 // pace is measured over about this much of the latest readings
const POINT_MS = 15 * 60e3 // one saved reading per this long

type Point = { p: number; at: number }

function span(ms: number): string {
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3600e3)
  const m = Math.floor((ms % 3600e3) / 60e3)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

function left(resetsAt: string | undefined, now: number): string {
  return span(resetsAt ? Date.parse(resetsAt) - now : NaN)
}

// How long until the week hits 100% at the current pace, when that is before its reset.
// Pace is the last ~12 hours of saved readings, or the whole week so far without one that old.
function runOut(r: SessionRateLimit, history: Point[], now: number, warnFrom: number): string {
  const reset = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  if (r.kind !== 'seven_day' || r.percentUsed < warnFrom || r.percentUsed >= 100 || !(reset > now)) return ''
  const old = history.find(h => h.at >= now - RECENT_MS && h.at <= now - 3600e3 && h.p < r.percentUsed)
  const perMs = old ? (r.percentUsed - old.p) / (now - old.at) : r.percentUsed / (now - (reset - WEEK_MS))
  const ms = (100 - r.percentUsed) / perMs
  return perMs > 0 && now + ms < reset ? span(ms) : ''
}

function line(limits: SessionRateLimit[], now: number, history: Point[] = [], warnFrom = WARN_FROM): string | undefined {
  if (!limits.length) return undefined
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)
  return [...limits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(r => {
      const t = left(r.resetsAt, now)
      const out = runOut(r, history, now, warnFrom)
      const notes = [t && `resets in ${t}`, out && `runs out in ~${out} at this pace`].filter(Boolean)
      return `${LABEL[r.kind] ?? r.kind} ${r.percentUsed}%` + (notes.length ? ` (${notes.join(', ')})` : '')
    })
    .join(' | ')
}

async function homeDir($: EngineInterface): Promise<string | null> {
  const raw = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return raw ? raw.replace(/\\/g, '/') : null
}

// usageLine.warnFrom from ~/.claude/vibequarters.config.json, else the default.
async function warnFrom($: EngineInterface, home: string | null): Promise<number> {
  if (!home) return WARN_FROM
  try {
    const v = Number(JSON.parse(await $.fs.read(`${home}/.claude/vibequarters.config.json`))?.usageLine?.warnFrom)
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : WARN_FROM
  } catch {
    return WARN_FROM
  }
}

// A stable, private key for the Claude account this machine is signed into: the first 16 hex characters of
// SHA-256(salt + ":" + account id). The salt is ~/.claude/vibequarters.salt, made by the installer, so the key means
// nothing off this machine. The account id itself is never stored. null when anything is missing.
async function accountKey($: EngineInterface, home: string): Promise<string | null> {
  try {
    const uuid = JSON.parse(await $.fs.read(`${home}/.claude.json`))?.oauthAccount?.accountUuid
    const salt = (await $.fs.read(`${home}/.claude/vibequarters.salt`)).trim()
    const subtle = (globalThis as { crypto?: { subtle?: { digest: (a: string, d: Uint8Array) => Promise<ArrayBuffer> } } }).crypto?.subtle
    if (typeof uuid !== 'string' || !uuid || salt.length < 16 || !subtle) return null
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${uuid}`))
    return 'acct-' + [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

// This week's saved readings, oldest first, with the new one added every POINT_MS;
// an unreadable file starts a fresh list.
async function remember($: EngineInterface, home: string, week: SessionRateLimit, now: number): Promise<Point[]> {
  const file = `${home}/.claude/vibequarters-usage/plan-usage-history.json`
  const start = (week.resetsAt ? Date.parse(week.resetsAt) : now) - WEEK_MS
  let points: Point[] = []
  try {
    points = JSON.parse(await $.fs.read(file))
  } catch {}
  points = (Array.isArray(points) ? points : []).filter(h => h.at > start && h.at > now - 2 * RECENT_MS && h.at <= now)
  if (!points.length || now - points[points.length - 1].at >= POINT_MS) {
    points.push({ p: week.percentUsed, at: now })
    await $.fs.write(file, JSON.stringify(points))
  }
  return points
}

// Saves the weekly and 5-hour percent, and the hashed key of the account it belongs to, to
// ~/.claude/vibequarters-usage/plan-usage.json. Returns this week's readings.
async function save($: EngineInterface, home: string | null, limits: SessionRateLimit[], now: number): Promise<Point[]> {
  const week = limits.find(r => r.kind === 'seven_day')
  if (!week || !home) return []
  const five = limits.find(r => r.kind === 'five_hour')
  const reading = { v: 1, accountKey: await accountKey($, home), seven_day: week.percentUsed, five_hour: five ? five.percentUsed : null, resetsAt: week.resetsAt, at: now }
  await $.fs.write(`${home}/.claude/vibequarters-usage/plan-usage.json`, JSON.stringify(reading))
  return remember($, home, week, now)
}

async function show($: EngineInterface, limits: SessionRateLimit[]): Promise<void> {
  const now = await $.clock.now()
  const home = await homeDir($)
  // a failed save never stops the turn
  const history = await save($, home, limits, now).catch(() => [])
  $.ui.status(line(limits, now, history, await warnFrom($, home)))
}

export const register: Register = on => {
  // Runs again on every hot reload, so the line shows as soon as the mod is turned on.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const { rateLimits } = await $.session.usage()
      await show($, rateLimits)
    } catch {
      // cosmetic: a failed read leaves the line off and the session starts as normal
    }
    return started
  })

  // After every turn, so "resets in" stays current too.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await show($, e.rateLimits)
    return measured
  })
}
