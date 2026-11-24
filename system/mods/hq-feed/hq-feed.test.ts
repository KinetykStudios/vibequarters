import { expect, mock, test } from 'claude-code/testing'

const SID = '11111111-2222-3333-4444-555555555555'
const DIR = 'C:/Users/t/.claude/hq-feed'
const MIN = 60e3
const norm = (p: string) => p.replace(/[\\/]+/g, '/') // the engine hands a Windows path over with backslashes

// The engine beneath the mod: a home folder, a session id, files in memory, and forks it counts.
function world(on: any, seed: Record<string, string> = {}) {
  const files: Record<string, string> = {}
  const put = (p: string, text: string) => void (files[norm(p)] = text)
  for (const [p, text] of Object.entries(seed)) put(p, text)
  const clock = mock.clock(on, { now: 1_000_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('session.id', () => ({ value: SID }))
  on('fs.read', (_: any, e: any) => {
    if (!(norm(e.path) in files)) return { deny: 'ENOENT' }
    return { value: files[norm(e.path)] }
  })
  on('fs.write', (_: any, e: any) => (put(e.path, e.text), { value: undefined }))
  const forks: string[] = []
  on('model.fork', (_: any, e: any) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const report = () => JSON.parse(files[norm(`${DIR}/${SID}.json`)])
  return { clock, put, forks, report }
}
const measure = { context: { window: 1e6 }, rateLimits: [], changed: ['context'] } as const
const spawn = (n: number, model?: string) => ({
  tool_use_id: 'tu' + n, prompt: 'p', description: 'Review part ' + n, subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, model, parentModel: 'claude-opus-5-5', background: false, fork: false,
})

test('the chat reports in at start', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await w.clock.advance(1500)
  expect(w.report().sessionId).toBe(SID)
  expect(w.report().warm.on).toBe(false)
})

test('with the switch on, an idle chat gets one ping at 50 minutes and none before', async ($, on) => {
  const w = world(on, { [`${DIR}/control/${SID}.json`]: JSON.stringify({ keepWarm: true, at: 5 }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure as any) // the last request: now
  await w.clock.advance(48 * MIN)
  expect(w.forks.length).toBe(0)
  await w.clock.advance(4 * MIN) // past 50 minutes, at a 2-minute check
  expect(w.forks.length).toBe(1)
  await w.clock.advance(1500)
  expect(w.report().warm.pings).toBe(1)
  expect(w.report().warm.on).toBe(true)
  await w.clock.advance(20 * MIN) // the ping restarted the hour: no second ping yet
  expect(w.forks.length).toBe(1)
})

test('with the switch off, nothing is ever pinged', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure as any)
  await w.clock.advance(58 * MIN)
  expect(w.forks.length).toBe(0)
})

test('a cache that already lapsed gets no ping, since that would pay the full rewrite', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure as any)
  await w.clock.advance(62 * MIN) // switched on only after the hour ran out
  w.put(`${DIR}/control/${SID}.json`, JSON.stringify({ keepWarm: true, at: 9 }))
  await w.clock.advance(3 * MIN)
  expect(w.forks.length).toBe(0)
  await w.clock.advance(1500)
  expect(w.report().warm.stopped).toMatch(/already expired/)
})

test('the brake lets three Opus agents through, asks at the fourth, and stops it on "Stop it"', async ($, on) => {
  world(on)
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asked.push(e.questions[0].question)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Stop it' } } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const n of [1, 2, 3]) expect((await $.agent.spawn(spawn(n) as any)).deny).toBe(undefined)
  expect(asked.length).toBe(0)
  const fourth = await $.agent.spawn(spawn(4) as any)
  expect(asked.length).toBe(1)
  expect(fourth.deny).toMatch(/Spend brake/)
})

test('"Allow this turn" lets the rest of the turn through, and a new turn starts the count over', async ($, on) => {
  world(on)
  let asks = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asks++
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Allow this turn' } } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const n of [1, 2, 3, 4, 5, 6]) expect((await $.agent.spawn(spawn(n) as any)).deny).toBe(undefined)
  expect(asks).toBe(1)
  await $.turn.start({ text: 'again', turnId: 't2' })
  for (const n of [1, 2, 3]) await $.agent.spawn(spawn(n) as any)
  expect(asks).toBe(1)
})

test('the settings file moves the ping time and the brake', async ($, on) => {
  const w = world(on, {
    [`${DIR}/control/${SID}.json`]: JSON.stringify({ keepWarm: true, at: 5 }),
    'C:/Users/t/.claude/vibequarters.config.json': JSON.stringify({ hqFeed: { pingAtMinutes: 20, pingText: 'ping now', brakeFree: 0 } }),
  })
  let asks = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asks++
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Allow this turn' } } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure as any)
  await w.clock.advance(22 * MIN)
  expect(w.forks).toEqual(['ping now'])
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawn(1) as any)
  expect(asks).toBe(1)
})

test('Sonnet agents and a workflow\'s agents are never held', async ($, on) => {
  world(on)
  let asks = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => (asks++, { result: { questions: e.questions, answers: {} } }))
  on('agent.spawn', () => ({ model: 'x', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const n of [1, 2, 3, 4, 5]) await $.agent.spawn(spawn(n, 'sonnet') as any)
  for (const n of [6, 7, 8, 9, 10]) await $.agent.spawn({ ...spawn(n), workflow: { runId: 'wf_1', index: n } } as any)
  expect(asks).toBe(0)
})
