#!/usr/bin/env node
// VibeQuarters installer. Copies the system into ~/.claude/vibequarters, the commands and skills into ~/.claude, and adds its
// hooks to ~/.claude/settings.json without touching anything already there. Nothing is downloaded and nothing is sent.
//
//   node install/install.js                                        asks what to turn on
//   node install/install.js --dry-run                              shows what would change, writes nothing
//   node install/install.js --yes --preset full                    every pack that fits this system
//   node install/install.js --yes --preset custom --packs core,coordination --approvals routine
//
// Options: --home <dir> (instead of the home folder), --dir <dir> (the system folder), --app-dir <dir> (the VibeQuarters app,
// this clone by default), --approvals ask-all|safe-reads|routine|routine-judge|none, --no-rules (no CLAUDE.md line),
// --app-config yes|no (write the app's hq.config.json with answering and the assistant on, when there is none; yes with
// full), --replace-statusline (with --yes: replace a status line you already have), --auto-evolve yes|no,
// --skip-version-check.
// Run it again to change packs or update. node install/uninstall.js takes it all out.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const L = require('./lib');

const FLAGS = {
  yes: 'flag', 'dry-run': 'flag', 'no-rules': 'flag', 'replace-statusline': 'flag', 'skip-version-check': 'flag', help: 'flag',
  preset: 'value', packs: 'value', approvals: 'value', home: 'value', dir: 'value', 'app-dir': 'value', 'app-config': 'value', 'auto-evolve': 'value',
};

// Asks on stdin; a closed stdin ends the install with nothing written.
function prompter() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [], waiting = [];
  let closed = false;
  rl.on('line', (l) => (waiting.length ? waiting.shift().resolve(l) : lines.push(l)));
  rl.on('close', () => { closed = true; for (const w of waiting) w.reject(new Error('no answer; nothing was installed')); });
  const ask = (q) => {
    process.stdout.write(q);
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.reject(new Error('no answer; nothing was installed'));
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return {
    close: () => rl.close(),
    async yes(q, def) {
      const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
      return a ? /^y(es)?$/.test(a) : def;
    },
    async pick(q, rows, def) {
      console.log(`\n${q}`);
      rows.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      for (;;) {
        const a = (await ask(`Choose 1-${rows.length} [${def + 1}] `)).trim();
        if (!a) return def;
        if (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= rows.length) return Number(a) - 1;
      }
    },
  };
}

async function choices(args, p, ctx) {
  const io = args.yes ? null : prompter();
  try {
    let preset = args.preset;
    if (preset && !L.PRESETS.includes(preset)) throw new Error(`--preset is one of ${L.PRESETS.join(', ')}`);
    if (!preset) preset = args.packs ? 'custom' : io ? L.PRESETS[await io.pick('What to install?', ['Full (recommended): every pack that fits this system', 'Custom: choose the packs'], 0)] : (ctx.old && ctx.old.preset) || 'full';
    let packs;
    if (preset === 'full') {
      if (args.packs) throw new Error('--packs goes with --preset custom');
      packs = L.fullPacks();
    } else if (args.packs) packs = args.packs.split(',').map((s) => s.trim()).filter(Boolean);
    else if (!io && !args.preset && ctx.old) packs = (ctx.old.packs || []).filter((id) => L.packById(id));
    else if (io) {
      packs = [];
      console.log('');
      for (const x of L.PACKS) if (L.fitsOs(x) && await io.yes(`${x.title}: ${x.what}.\n  Turn on?`, true)) packs.push(x.id);
    } else throw new Error('--preset custom needs --packs (or run it without --yes)');
    packs = L.resolvePacks(packs);
    if (packs.includes('app') && !ctx.appDir) {
      packs = packs.filter((x) => x !== 'app');
      ctx.notes.push('The app hooks were left out: no VibeQuarters app (server.js) next to this installer. Name its folder with --app-dir.');
    }

    let approvals = args.approvals || null;
    if (approvals && approvals !== 'none' && !L.APPROVALS.some((a) => a.id === approvals)) throw new Error(`--approvals is one of ${L.APPROVALS.map((a) => a.id).join(', ')}, none`);
    if (!approvals && io && ctx.appDir) approvals = L.APPROVALS[await io.pick('When the VibeQuarters page approves for you (only inside a window you open there), how much may it approve? Deletes, force pushes, deploys, publishing and money ask you, when the command itself says so.', L.APPROVALS.map((a) => a.title), 2)].id;
    // Full without questions takes the recommended one, unless one was picked already
    if (!approvals && preset === 'full' && packs.includes('app') && !fs.existsSync(ctx.choiceFile)) approvals = L.RECOMMENDED;
    if (approvals === 'none' || !ctx.appDir) approvals = null;

    // The app's own config, only when it has none: an existing one is never touched.
    let appConfig = false;
    if (args['app-config'] && !/^(yes|no)$/.test(args['app-config'])) throw new Error('--app-config is yes or no');
    if (packs.includes('app')) {
      const asked = args['app-config'] === 'yes' || (!args['app-config'] && preset === 'full');
      if (ctx.appConfig.there) {
        if (asked && !ctx.appConfig.mine) ctx.notes.push(`hq.config.json in ${ctx.appDir} stays as it is; answering from the page needs "control": true there, the assistant "assistant": {}.`);
      } else if (!ctx.appConfig.example) {
        if (asked) ctx.notes.push(`no hq.config.example.json in ${ctx.appDir}, so hq.config.json was not written.`);
      } else if (args['app-config']) appConfig = asked;
      else appConfig = io ? await io.yes('\nAnswer permission prompts from the page, and turn on its assistant (on your own Claude login)?', true) : asked;
    }

    let autoEvolve = false;
    if (packs.includes('learning-loop')) {
      if (args['auto-evolve']) autoEvolve = args['auto-evolve'] === 'yes';
      else autoEvolve = io && preset === 'custom' ? await io.yes('Learning loop: may a session run /evolve by itself at a quiet moment?', true) : preset === 'full';
    }

    let statusLine = false;
    if (packs.includes('statusline')) {
      if (!ctx.statusLine) statusLine = true;
      else if (io) statusLine = await io.yes('You already have a status line. Replace it with VibeQuarters\'s (uninstall puts yours back)?', false);
      else statusLine = !!args['replace-statusline'];
      if (!statusLine) { packs = packs.filter((x) => x !== 'statusline'); ctx.notes.push('Your status line was left as it is.'); }
    }

    let rules = !args['no-rules'];
    if (rules && io) rules = await io.yes(`\nAdd one line to ${L.tilde(p.claudeMd, p.home)} so every session reads the VibeQuarters rules?\n  ${ctx.importLine}\n`, true);
    return { preset, packs, approvals, appConfig, autoEvolve, rules, proceed: async () => !io || args['dry-run'] || io.yes('\nGo ahead?', true), close: () => io && io.close() };
  } catch (e) { if (io) io.close(); throw e; }
}

// The settings object for vibequarters.config.json: only the installer's own keys change.
function nextConfig(base, p, c, appDir) {
  const out = structuredClone(base);
  out.systemDir = L.tilde(p.systemDir, p.home);
  if (appDir) out.appDir = L.tilde(appDir, p.home);
  const set = (group, key, value, dflt) => {
    if (value === dflt) { if (L.isPlain(out[group])) { delete out[group][key]; if (!Object.keys(out[group]).length) delete out[group]; } return; }
    out[group] = { ...(L.isPlain(out[group]) ? out[group] : {}), [key]: value };
  };
  set('mergeGate', 'requireReview', c.packs.includes('merge-gate'), true);
  set('loop', 'autoEvolve', c.autoEvolve, false);
  return out;
}

async function main(argv) {
  const args = L.parseArgs(argv, FLAGS);
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (Number(process.versions.node.split('.')[0]) < L.MIN_NODE) throw new Error(`Node.js ${L.MIN_NODE} or newer is needed (this is ${process.versions.node})`);
  const ctx = { notes: [] };
  const version = args['skip-version-check'] ? null : L.claudeVersion();
  if (version && L.versionOk(version) === false) throw new Error(`Claude Code ${L.MIN_CLAUDE} or newer is needed (this is ${version}). Update it, or pass --skip-version-check.`);
  if (!version && !args['skip-version-check']) ctx.notes.push(`Claude Code was not found on the PATH; it must be ${L.MIN_CLAUDE} or newer.`);

  const p = L.paths({ home: args.home, dir: args.dir });
  if (path.resolve(p.systemDir) === path.resolve(p.claude) || path.resolve(p.systemDir) === path.resolve(p.home)) throw new Error('--dir must be a folder of its own');
  const there = L.paths({ home: args.home });
  if (!L.sameDir(there.systemDir, p.systemDir) && L.readManifest(there)) {
    throw new Error(`VibeQuarters is already installed in ${there.systemDir}, and a second copy would run every hook twice. Run this without --dir to update it, or take it out first: node "${L.slash(there.systemDir)}/install/uninstall.js"${args.home ? ` --home "${p.home}"` : ''}`);
  }
  const old = L.readManifest(p);
  ctx.old = old;
  if (!old && fs.existsSync(p.systemDir) && fs.readdirSync(p.systemDir).length) throw new Error(`${p.systemDir} already holds files the installer did not put there. Pick another folder with --dir.`);
  ctx.appDir = args['app-dir'] ? path.resolve(args['app-dir']) : fs.existsSync(path.join(L.REPO, 'server.js')) ? L.REPO : null;
  if (ctx.appDir && !fs.existsSync(path.join(ctx.appDir, 'server.js'))) throw new Error(`no server.js in ${ctx.appDir}`);
  const appConfigFile = ctx.appDir && path.join(ctx.appDir, 'hq.config.json');
  ctx.appConfig = {
    there: !!appConfigFile && fs.existsSync(appConfigFile),
    example: !!appConfigFile && fs.existsSync(path.join(ctx.appDir, 'hq.config.example.json')),
    mine: !!(old && old.appConfig && L.slash(appConfigFile) === old.appConfig.file), // written by an earlier install
  };
  ctx.importLine = `@${L.tilde(path.join(p.systemDir, 'rules', 'RULES.md'), p.home)}`;

  // What settings.json and the config held before VibeQuarters. After an earlier install that nobody edited since, that is
  // the saved copy; after an edit, it is what is there now with VibeQuarters' entries taken out.
  const settingsNow = L.readBytes(p.settings);
  const parsedNow = parse(settingsNow, p.settings);
  let settingsBefore = settingsNow;
  const saved = (rec, f) => !rec.existed || fs.existsSync(f);
  if (old && settingsNow && L.ourBytes(old, 'settings', L.sha(settingsNow)) && saved(old.settings, p.settingsBefore)) settingsBefore = L.readBytes(p.settingsBefore);
  else if (old && settingsNow) {
    const without = L.removeFrom(parsedNow.json, old.settings.added, p.systemDir);
    if (!L.equal(without, parsedNow.json)) settingsBefore = L.printSettings(without, parsedNow.style);
  }
  const base = parse(settingsBefore, p.settings);
  ctx.statusLine = base.json.statusLine;
  const configNow = L.readBytes(p.config);
  const configBefore = old && configNow && L.ourBytes(old, 'config', L.sha(configNow)) && saved(old.config, p.configBefore) ? L.readBytes(p.configBefore) : configNow;

  const state = String(parse(configBefore, p.config).json.appStateDir || '');
  ctx.choiceFile = ctx.appDir && path.join(state ? path.resolve(state.replace(/^~(?=$|[\\/])/, p.home)) : ctx.appDir, 'approvals-choice.json');

  const c = await choices(args, p, ctx);
  try {
    const groups = L.hookGroups(c.packs, { systemDir: p.systemDir, appDir: ctx.appDir });
    const mods = c.packs.flatMap((id) => L.packById(id).mods || []).map((m) => `${L.slash(p.systemDir)}/mods/${m}`);
    const statusLine = c.packs.includes('statusline') ? { type: 'command', command: `node "${L.slash(p.systemDir)}/statusline/statusline.js"` } : null;
    const { next, added } = L.addTo(base.json, { groups, pluginDirs: mods, statusLine });
    const settingsBytes = L.equal(next, base.json) && settingsBefore ? settingsBefore : L.printSettings(next, base.style);
    if (!L.equal(parse(settingsBytes, p.settings).json, next)) throw new Error('the new settings.json does not read back; nothing was written');

    const config = parse(configBefore, p.config);
    const configBytes = L.printSettings(nextConfig(config.json, p, c, ctx.appDir), config.style);
    const ownSystemDir = path.resolve(p.systemDir) !== path.join(p.claude, 'vibequarters');
    const appConfigBytes = c.appConfig ? Buffer.from(`${JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(ctx.appDir, 'hq.config.example.json'), 'utf8')),
      control: true, assistant: {}, ...(ownSystemDir ? { systemDir: L.tilde(p.systemDir, p.home) } : {}),
    }, null, 2)}\n`) : null;
    const files = plan(p, c, old, ctx);
    const claudeMd = c.rules ? withImport(L.readBytes(p.claudeMd), ctx.importLine) : null;

    const say = (s) => console.log(s);
    say(`\n${args['dry-run'] ? 'Dry run. This would' : 'This will'}:`);
    say(`  turn on: ${c.packs.map((id) => L.packById(id).title).join(', ') || 'no pack'}`);
    say(`  copy ${files.copies.length} files to ${p.systemDir}`);
    say(`  add ${added.groups.length} hook entries${mods.length ? ` and ${added.pluginDirs.length} mods` : ''}${added.statusLine ? ' and the status line' : ''} to ${p.settings}`);
    if (files.commands.length) say(`  add the commands ${files.commands.map((x) => `/${path.basename(x, '.md')}`).join(' ')}`);
    if (files.skills.length) say(`  add the skills ${files.skills.join(', ')}`);
    say(`  write its settings to ${p.config}`);
    if (c.approvals) say(`  set what the page may approve: ${L.APPROVALS.find((a) => a.id === c.approvals).title}`);
    if (appConfigBytes) say(`  turn on answering from the page and the assistant: ${appConfigFile}`);
    if (c.autoEvolve) say('  let a session run /evolve by itself at a quiet moment ("loop": { "autoEvolve": false } in the config turns it off)');
    if (claudeMd) say(`  add to ${p.claudeMd}: ${ctx.importLine}`);
    for (const n of [...ctx.notes, ...files.notes]) say(`  note: ${n}`);
    if (args['dry-run']) return 0;
    if (!(await c.proceed())) { say('Nothing was installed.'); return 1; }

    const manifest = {
      v: 1,
      version: JSON.parse(fs.readFileSync(path.join(L.REPO, 'package.json'), 'utf8')).version,
      preset: c.preset, packs: c.packs, approvals: c.approvals || (old && old.approvals) || null, appDir: ctx.appDir ? L.slash(ctx.appDir) : null,
      files: Object.fromEntries(files.copies.map(({ to, bytes }) => [L.slash(to), L.sha(bytes)])),
      settings: { existed: settingsBefore !== null, afterSha: L.sha(settingsBytes), added },
      config: { existed: configBefore !== null, afterSha: L.sha(configBytes) },
      claudeMd: claudeMd ? { line: ctx.importLine, existed: (old && old.claudeMd ? old.claudeMd.existed : fs.existsSync(p.claudeMd)), added: claudeMd.added || !!(old && old.claudeMd && old.claudeMd.added), joint: claudeMd.joint || (old && old.claudeMd && old.claudeMd.joint) || '' } : null,
      salt: (old && old.salt) || false,
      approvalsFile: (old && old.approvalsFile) || null,
      appConfig: appConfigBytes ? { file: L.slash(appConfigFile), sha: L.sha(appConfigBytes) } : (old && old.appConfig) || null,
    };
    if (c.approvals) manifest.approvalsFile = L.slash(ctx.choiceFile);
    const newSalt = c.packs.includes('companions') && !fs.existsSync(p.salt);
    if (newSalt) manifest.salt = true;

    // The manifest first (with what the version before left), then the files, settings.json last: at any point this
    // installer or uninstall.js can finish or take back what was written.
    const prior = old ? { ...added, groups: [...added.groups, ...old.settings.added.groups], pluginDirs: [...new Set([...added.pluginDirs, ...old.settings.added.pluginDirs])], statusLine: added.statusLine || old.settings.added.statusLine } : added;
    saveManifest(p, { ...manifest, settings: { ...manifest.settings, added: prior }, pending: L.pendingOf(old) });
    ctx.started = true;
    fs.mkdirSync(path.dirname(p.settingsBefore), { recursive: true });
    for (const [f, bytes] of [[p.settingsBefore, settingsBefore], [p.configBefore, configBefore]]) {
      if (bytes) fs.writeFileSync(f, bytes, { mode: 0o600 });
      else try { fs.unlinkSync(f); } catch (_e) { /* none */ }
    }
    for (const { to, bytes } of files.copies) {
      const cur = L.readBytes(to);
      if (cur && !cur.equals(bytes) && !L.ourSha(old, L.slash(to), L.sha(cur))) fs.writeFileSync(`${to}.edited-${L.stamp()}`, cur);
      if (!cur || !cur.equals(bytes)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes); }
    }
    if (newSalt) {
      fs.writeFileSync(p.salt, `${crypto.randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
    }
    if (!claudeMd && old && old.claudeMd && old.claudeMd.added) dropImport(p, old.claudeMd);
    if (c.approvals) {
      fs.mkdirSync(path.dirname(ctx.choiceFile), { recursive: true });
      fs.writeFileSync(manifest.approvalsFile, `${JSON.stringify({ v: 1, preset: c.approvals, at: Date.now() })}\n`);
    }
    if (appConfigBytes) L.writeGuarded(appConfigFile, appConfigBytes, null);
    L.writeGuarded(p.config, configBytes, configNow);
    if (claudeMd && claudeMd.added) L.writeGuarded(p.claudeMd, claudeMd.bytes, claudeMd.was);
    const bak = settingsNow && settingsNow.equals(settingsBytes) ? null : L.writeGuarded(p.settings, settingsBytes, settingsNow);

    for (const f of files.stale) { try { fs.unlinkSync(f); } catch (_e) { /* gone */ } L.pruneUp(path.dirname(f), [p.systemDir, p.claude]); }
    saveManifest(p, manifest);
    ctx.started = false;

    say(`\nInstalled. ${bak ? `The settings.json from before is ${bak}.` : ''}`);
    const todo = [`Restart your Claude Code sessions.${c.packs.includes('app') ? ' The VibeQuarters page opens with the first one.' : ''}`];
    if (appConfigBytes && fs.existsSync(path.join(ctx.appDir, '.runtime.json'))) todo.push('A VibeQuarters server that is already running reads the new hq.config.json once it is restarted.');
    if (c.packs.includes('app') && !appConfigBytes && !ctx.appConfig.there) todo.push(`The page is read-only. To answer prompts from it, copy hq.config.example.json to hq.config.json in ${ctx.appDir} and set "control" to true.`);
    if (ctx.appDir && ownSystemDir && !appConfigBytes && !ctx.appConfig.mine) todo.push(`Set "systemDir": "${L.tilde(p.systemDir, p.home)}" in the app's hq.config.json so it finds the presets.`);
    if (c.packs.includes('merge-gate') && !L.runs('gh auth token')) todo.push(`For /land and the merge gate: ${L.runs('gh --version') ? '' : 'install the GitHub CLI (https://cli.github.com), then '}run gh auth login.`);
    if (c.packs.includes('learning-loop')) todo.push('In each project that should keep its own lessons: run /loop-init once.');
    say('Still to do:');
    todo.forEach((t, i) => say(`  ${i + 1}. ${t}`));
    const preset = c.packs.includes('app') && L.APPROVALS.find((a) => a.id === manifest.approvals);
    if (preset) say(`"${preset.title}" acts only inside an approve window, which you open by asking the page's assistant and confirming its read-back. Until then every prompt waits for your click.`);
    say('Optional:');
    say(`  node "${L.slash(p.systemDir)}/install/verify.js"${args.home ? ` --home "${p.home}"` : ''}   runs every installed hook on a test payload`);
    say('  Worth adding from the official plugin marketplace (not installed here):');
    for (const x of L.PLUGINS) say(`    claude plugin install ${x}@claude-plugins-official`);
    return 0;
  } catch (e) {
    if (ctx.started) e.message += `\nThe install stopped partway. Fix that and run it again, or take it back with: node "${L.slash(path.join(__dirname, 'uninstall.js'))}" --home "${p.home}" --dir "${p.systemDir}"`;
    throw e;
  } finally { c.close(); }
}

function saveManifest(p, manifest) {
  fs.mkdirSync(p.systemDir, { recursive: true });
  const tmp = `${p.manifest}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p.manifest);
}

function parse(bytes, file) {
  try { return L.parseSettings(bytes); } catch (e) { throw new Error(`${file} cannot be read (${e.message}); nothing was written. Fix it first.`); }
}

// The CLAUDE.md bytes with the import line added at the end; added is false when it is already there.
function withImport(was, line) {
  const text = was ? was.toString('utf8') : '';
  if (text.split(/\r?\n/).includes(line)) return { bytes: was, was, added: false, joint: '' };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const joint = text && !text.endsWith('\n') ? eol : '';
  return { bytes: Buffer.from(`${text}${joint}${line}${eol}`, 'utf8'), was, added: true, joint };
}
function dropImport(p, rec) {
  const was = L.readBytes(p.claudeMd);
  if (!was) return;
  const bytes = L.withoutImport(was, rec);
  if (!bytes.equals(was)) L.writeGuarded(p.claudeMd, bytes, was);
}

// Every file the install writes: what to copy, what an earlier install left that this one drops, and what stays the user's.
function plan(p, c, old, ctx) {
  const copies = [], notes = [], commands = [], skills = [];
  const ours = new Set(L.ourFiles(old));
  const mine = (f) => ours.has(L.slash(f));
  for (const [from, rel] of L.systemFiles()) {
    let bytes = fs.readFileSync(from);
    if (rel === 'rules/RULES.md' && c.packs.includes('style')) bytes = Buffer.from(`${bytes.toString('utf8').replace(/\s*$/, '\n')}\n@REPLY-SHAPE.md\n`);
    copies.push({ to: path.join(p.systemDir, ...rel.split('/')), bytes });
  }
  for (const id of c.packs) {
    for (const name of L.packById(id).commands || []) {
      const to = path.join(p.claude, 'commands', `${name}.md`);
      const bytes = fs.readFileSync(path.join(L.REPO, 'system', 'commands', `${name}.md`));
      const cur = L.readBytes(to);
      if (cur && !mine(to) && !cur.equals(bytes)) { notes.push(`you already have a /${name} command; yours stays (VibeQuarters' is ${p.systemDir}/commands/${name}.md)`); continue; }
      if (cur && !mine(to)) continue;
      copies.push({ to, bytes });
      commands.push(to);
    }
    for (const name of L.packById(id).skills || []) {
      const dir = path.join(p.claude, 'skills', name);
      if (fs.existsSync(dir) && !mine(path.join(dir, 'SKILL.md'))) { notes.push(`you already have a ${name} skill; yours stays`); continue; }
      for (const [from, rel] of L.systemFiles()) if (rel.startsWith(`skills/${name}/`)) copies.push({ to: path.join(p.claude, ...rel.split('/')), bytes: fs.readFileSync(from) });
      skills.push(name);
    }
  }
  const keep = new Set(copies.map((x) => L.slash(x.to)));
  const stale = [];
  for (const f of ours) {
    if (keep.has(f)) continue;
    const cur = L.readBytes(f);
    if (cur && L.ourSha(old, f, L.sha(cur))) stale.push(f);
  }
  return { copies, notes, commands, skills, stale };
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`install: ${e.message}`); process.exitCode = 1; });
}
module.exports = { main };
