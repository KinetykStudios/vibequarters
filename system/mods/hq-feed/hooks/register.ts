import type { EngineInterface, Register } from 'claude-code'

// Reports this chat to HQ in ~/.claude/hq-feed/<session id>.json and reads HQ's keep-warm switch from
// ~/.claude/hq-feed/control/<session id>.json. With the switch on, an idle chat whose prompt cache is about to lapse
// gets one tool-less fork over its own transcript, which reads the cached prefix and so restarts its hour; nothing
// reaches the conversation. A turn that starts more than brakeFree Opus subagents asks first (the spend brake).

// The defaults; hqFeed.* in ~/.claude/vibequarters.config.json changes any of them (read when the chat starts).
const cfg = {
  cacheMinutes: 60, // the subscription's one-hour prompt cache
  pingAtMinutes: 50, // a cache this old gets its ping
  tickSeconds: 120, // how often the switch and the cache's age are checked
  maxPings: 24, // about 20 hours kept warm, then it stops by itself
  brakeModel: 'opus', // subagents on a model matching this count toward the brake
  brakeFree: 3, // that many of them a turn starts before the brake asks
  pingText: 'Keep-alive ping from VibeQuarters to hold the prompt cache. Reply with the single word: ok',
}
const DEFAULTS = { ...cfg }
const ALLOW = 'Allow this turn'

// A number in range or a non-empty string from the settings replaces its default; anything else leaves it alone.
async function settings($: EngineInterface, home: string) {
  Object.assign(cfg, DEFAULTS)
  let c: any = null
  try {
    c = JSON.parse(await $.fs.read(`${home}/.claude/vibequarters.config.json`))?.hqFeed
  } catch {}
  if (!c || typeof c !== 'object') return
  const num = (k: 'cacheMinutes' | 'pingAtMinutes' | 'tickSeconds' | 'maxPings' | 'brakeFree', min: number) => {
    if (Number.isFinite(c[k]) && c[k] >= min) cfg[k] = c[k]
  }
  num('cacheMinutes', 1)
  num('pingAtMinutes', 1)
  num('tickSeconds', 10)
  num('maxPings', 0)
  num('brakeFree', 0)
  for (const k of ['brakeModel', 'pingText'] as const) if (typeof c[k] === 'string' && c[k].trim()) cfg[k] = c[k]
}

function brakeRe(): RegExp {
  try {
    return new RegExp(cfg.brakeModel, 'i')
  } catch {
    return new RegExp(DEFAULTS.brakeModel, 'i')
  }
}

type Warm = { on: boolean; pings: number; lastPingAt: number | null; stopped: string | null; since: number | null }
type Brake = { asks: number; lastAt: number | null; opusThisTurn: number }

// This chat's state; a reload of the module starts it over, and session.start reads the last report back.
const st = {
  dir: '',
  id: '',
  lastRequestAt: null as number | null,
  busy: false, // a main-loop turn is running
  pinging: false,
  allowed: false, // the user let this turn past the brake
  flushing: false,
  warm: { on: false, pings: 0, lastPingAt: null, stopped: null, since: null } as Warm,
  brake: { asks: 0, lastAt: null, opusThisTurn: 0 } as Brake,
}

async function readJson($: EngineInterface, p: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(p))
  } catch {
    return null
  }
}

async function write($: EngineInterface) {
  st.flushing = false
  if (!st.dir || !st.id) return
  const updatedAt = await $.clock.now()
  const { id, lastRequestAt, warm, brake } = st
  await $.fs.write(`${st.dir}/${id}.json`, JSON.stringify({ v: 1, sessionId: id, updatedAt, lastRequestAt, warm, brake }))
}

// at most one write a second
function flush($: EngineInterface) {
  if (st.flushing) return
  st.flushing = true
  $.clock.after(1000, () => void write($).catch(() => {}))
}

// A /clear gives the chat a new id: the old report stays behind, the new one starts clean.
async function follow($: EngineInterface) {
  const now = await $.session.id()
  if (now === st.id) return
  st.id = now
  st.lastRequestAt = null
  st.warm = { on: false, pings: 0, lastPingAt: null, stopped: null, since: null }
  st.brake = { asks: 0, lastAt: null, opusThisTurn: 0 }
}

async function tick($: EngineInterface) {
  await follow($)
  const ctl = await readJson($, `${st.dir}/control/${st.id}.json`)
  const isOn = !!ctl && ctl.keepWarm === true
  const since = ctl && Number.isFinite(ctl.at) ? ctl.at : null
  if (isOn !== st.warm.on || since !== st.warm.since) st.warm = { ...st.warm, on: isOn, since, stopped: null, pings: isOn ? 0 : st.warm.pings } // a new switch starts over
  flush($)
  if (!st.warm.on || st.warm.stopped || st.busy || st.pinging || st.lastRequestAt === null) return
  const now = await $.clock.now()
  const age = now - st.lastRequestAt
  if (age < cfg.pingAtMinutes * 60e3) return
  if (age >= cfg.cacheMinutes * 60e3) {
    st.warm.stopped = 'The cache had already expired, so no ping: it would pay the full rewrite'
    return flush($)
  }
  if (st.warm.pings >= cfg.maxPings) {
    st.warm.stopped = `Kept warm for ${Math.round((cfg.maxPings * cfg.pingAtMinutes) / 60)} hours, then stopped`
    return flush($)
  }
  st.pinging = true
  try {
    const r = await $.model.fork({ prompt: cfg.pingText })
    if (r.isAnswered) {
      st.lastRequestAt = now // the cache's hour runs from the request's start
      st.warm.pings++
      st.warm.lastPingAt = now
      if (!(r.usage.cache_read_input_tokens > 0)) st.warm.stopped = 'The ping found the cache cold'
    } else st.warm.stopped = `The ping failed: ${r.reason}`
  } finally {
    st.pinging = false
    flush($)
  }
}

async function start($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return
  st.dir = `${home.replace(/\\/g, '/')}/.claude/hq-feed`
  await settings($, home.replace(/\\/g, '/'))
  await follow($)
  // a reload starts the module over: pick up what this chat's report already says
  const was = await readJson($, `${st.dir}/${st.id}.json`)
  if (was && was.sessionId === st.id) {
    if (Number.isFinite(was.lastRequestAt)) st.lastRequestAt = was.lastRequestAt
    if (was.warm) st.warm = { ...st.warm, ...was.warm }
    if (was.brake) st.brake = { ...st.brake, asks: was.brake.asks || 0, lastAt: was.brake.lastAt ?? null }
  }
  $.clock.every(cfg.tickSeconds * 1000, () => void tick($).catch(() => {}))
  flush($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($).catch(() => {})
    return started
  })

  // every response of the main loop moves the context; its time is when the prompt cache was last read
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    st.lastRequestAt = await $.clock.now()
    flush($)
    return measured
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      st.busy = true
      st.allowed = false
      st.brake.opusThisTurn = 0
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      st.busy = false
      flush($)
    }
    return done
  })

  // The spend brake: past brakeFree Opus subagents in one turn it asks once; "Allow this turn" lets the rest of the
  // turn through. A workflow's agents are never held (the user asked for the workflow). A brake that fails lets the agent go.
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow || e.fork) return next(e)
    const model = e.model && e.model !== 'inherit' ? e.model : e.parentModel
    if (!brakeRe().test(model || '')) return next(e)
    st.brake.opusThisTurn++
    flush($)
    if (st.brake.opusThisTurn <= cfg.brakeFree || st.allowed) return next(e)
    st.brake.asks++
    st.brake.lastAt = await $.clock.now()
    const pick = await $.ui
      .ask(`Spend brake: this turn is starting ${cfg.brakeModel === 'opus' ? 'Opus' : cfg.brakeModel} agent number ${st.brake.opusThisTurn} ("${e.description}"). Let it run?`, { options: [ALLOW, 'Stop it'], header: 'Spend' })
      .catch(() => 'Stop it')
    if (pick === ALLOW) {
      st.allowed = true
      return next(e)
    }
    return { deny: 'Spend brake: the user stopped this agent. Go on with the agents already running, or ask them before starting more.' }
  }).catch(($, e, next) => next(e))
}
