import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2037-03-27T09:00:00Z')
const LIMITS = [
  { kind: 'five_hour', percentUsed: 40, resetsAt: '2037-03-27T12:10:00Z' },
  { kind: 'seven_day', percentUsed: 3, resetsAt: '2037-04-02T13:00:00Z' },
]

test('session start pins both windows, the week first', async ($, on) => {
  const status: (string | undefined)[] = []
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1e6 }, rateLimits: LIMITS },
  }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  expect(status.at(-1)).toBe(
    'Week 3% (resets in 6d 4h) | 5h 40% (resets in 3h 10m)',
  )
})

test('a new measurement replaces the line', async ($, on) => {
  const status: (string | undefined)[] = []
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1e6 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: '2037-03-28T09:00:00Z' }],
    changed: ['rateLimits'],
  })

  // 97% in 6 days is ~16% a day, so the last 3% lasts ~4h 27m
  expect(status.at(-1)).toBe('Week 97% (resets in 1d 0h, runs out in ~4h 27m at this pace)')
})

test('no reading yet leaves the line off', async ($, on) => {
  const status: (string | undefined)[] = ['stale']
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1e6 }, rateLimits: [] },
  }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  expect(status.at(-1)).toBe(undefined)
})

const CLAUDE_JSON = 'C:/Users/T/.claude.json'
const SALT_FILE = 'C:/Users/T/.claude/vibequarters.salt'
const CONFIG = 'C:/Users/T/.claude/vibequarters.config.json'
const SALT = 'test-salt-0123456789abcdef'
// acct- + the first 16 hex characters of SHA-256(SALT + ':acc-1')
const KEY = 'acct-3904eb6441202e03'

function files(map: Record<string, string | null>) {
  return (_: unknown, e: { path: string }) => {
    const v = map[e.path.replace(/\\/g, '/')]
    if (v === undefined || v === null) throw new Error('ENOENT')
    return { value: v }
  }
}

function saved($: any, on: any, rateLimits: unknown[], claudeJson: string | null = '{"oauthAccount":{"accountUuid":"acc-1"}}', salt: string | null = SALT) {
  const writes: { path: string; text: string }[] = []
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\T' : undefined }))
  on('fs.read', files({ [CLAUDE_JSON]: claudeJson, [SALT_FILE]: salt }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (writes.push(e), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  return $.session
    .measure({ context: { window: 1e6 }, rateLimits, changed: ['rateLimits'] })
    .then(() => writes)
}

const PLAN = 'C:/Users/T/.claude/vibequarters-usage/plan-usage.json'
const HISTORY = 'C:/Users/T/.claude/vibequarters-usage/plan-usage-history.json'
const at = (writes: { path: string; text: string }[], p: string) => writes.filter(w => w.path.replace(/\\/g, '/') === p)

test('a measurement saves the weekly percent and the hashed account key', async ($, on) => {
  const writes = await saved($, on, LIMITS)

  expect(at(writes, PLAN).length).toBe(1)
  expect(JSON.parse(at(writes, PLAN)[0].text)).toEqual({
    v: 1,
    accountKey: KEY,
    seven_day: 3,
    five_hour: 40,
    resetsAt: '2037-04-02T13:00:00Z',
    at: NOW,
  })
})

test('the account id itself is never written', async ($, on) => {
  const writes = await saved($, on, LIMITS)

  expect(writes.some(w => w.text.includes('acc-1'))).toBe(false)
})

test('without the install salt the reading names no account', async ($, on) => {
  const writes = await saved($, on, LIMITS, '{"oauthAccount":{"accountUuid":"acc-1"}}', null)

  expect(JSON.parse(at(writes, PLAN)[0].text).accountKey).toBe(null)
})

test('the reading names no account when the signed-in account cannot be read', async ($, on) => {
  const writes = await saved($, on, LIMITS, null)

  expect(at(writes, PLAN).length).toBe(1)
  expect(JSON.parse(at(writes, PLAN)[0].text).accountKey).toBe(null)
})

test('no weekly window saves nothing', async ($, on) => {
  const writes = await saved($, on, [LIMITS[0]])

  expect(writes).toEqual([])
})

// The week below started 2037-03-22T09:00Z and resets in 2 days.
const WEEK80 = [{ kind: 'seven_day', percentUsed: 80, resetsAt: '2037-03-29T09:00:00Z' }]

function measured($: any, on: any, rateLimits: unknown[], history: string | null, config: string | null = null) {
  const status: (string | undefined)[] = []
  const writes: { path: string; text: string }[] = []
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\T' : undefined }))
  on('fs.read', files({ [HISTORY]: history, [CONFIG]: config }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (writes.push(e), { value: undefined }))
  on('ui.status', (_: unknown, e: { text?: string }) => (status.push(e.text), { value: undefined }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  return $.session
    .measure({ context: { window: 1e6 }, rateLimits, changed: ['rateLimits'] })
    .then(() => ({ status: status.at(-1), writes }))
}

test('past half the week, the line says when it runs out at the week-so-far pace', async ($, on) => {
  // 80% in 5 days is 16% a day, so the last 20% lasts 1d 6h, before the reset in 2d
  const { status } = await measured($, on, WEEK80, null)

  expect(status).toBe('Week 80% (resets in 2d 0h, runs out in ~1d 6h at this pace)')
})

test('a reading from the last 12 hours sets the pace instead', async ($, on) => {
  // 70% ten hours ago is 1% an hour, so the last 20% lasts 20h
  const { status } = await measured($, on, WEEK80, JSON.stringify([{ p: 70, at: NOW - 10 * 3600e3 }]))

  expect(status).toBe('Week 80% (resets in 2d 0h, runs out in ~20h 0m at this pace)')
})

test('a pace that lasts past the reset adds nothing', async ($, on) => {
  const { status } = await measured($, on, WEEK80, JSON.stringify([{ p: 79, at: NOW - 10 * 3600e3 }]))

  expect(status).toBe('Week 80% (resets in 2d 0h)')
})

test('usageLine.warnFrom moves where the run-out time starts',  async ($, on) => {
  const { status } = await measured($, on, WEEK80, null, '{"usageLine":{"warnFrom":90}}')

  expect(status).toBe('Week 80% (resets in 2d 0h)')
})

test('under half the week adds nothing', async ($, on) => {
  const { status } = await measured($, on, [{ ...WEEK80[0], percentUsed: 40 }], null)

  expect(status).toBe('Week 40% (resets in 2d 0h)')
})

test('a reading under 15 minutes old means nothing new is saved', async ($, on) => {
  const { writes } = await measured($, on, WEEK80, JSON.stringify([{ p: 75, at: NOW - 5 * 60e3 }]))

  expect(at(writes, HISTORY)).toEqual([])
})

test('readings from before this week are dropped when a new one is saved', async ($, on) => {
  const { writes } = await measured($, on, WEEK80, JSON.stringify([{ p: 1, at: Date.parse('2037-03-21T09:00:00Z') }]))

  expect(JSON.parse(at(writes, HISTORY)[0].text)).toEqual([{ p: 80, at: NOW }])
})
