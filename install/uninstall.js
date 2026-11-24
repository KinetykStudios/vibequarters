#!/usr/bin/env node
// VibeQuarters uninstaller: takes out exactly what install.js put in.
//
//   node "$HOME/.claude/vibequarters/install/uninstall.js" [--dry-run] [--home <dir>] [--dir <system folder>]
//
// settings.json and vibequarters.config.json go back to their exact bytes when nothing changed them since the install;
// otherwise only VibeQuarters' own entries come out of settings.json and an edited config stays. Files you edited stay, and
// the app's hq.config.json goes only when the installer wrote it and nobody edited it.
// Your data stays too: the coordination board, memory, usage history, the salt and the backups; each is listed at the end.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

function main(argv) {
  const args = L.parseArgs(argv, { home: 'value', dir: 'value', 'dry-run': 'flag', help: 'flag' });
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  // Run from the installed copy, the system folder is the one this file sits in.
  const here = path.resolve(__dirname, '..');
  const p = L.paths({ home: args.home, dir: args.dir || (fs.existsSync(path.join(here, L.MANIFEST)) ? here : undefined) });
  const m = L.readManifest(p);
  if (!m) throw new Error(`no VibeQuarters install found in ${p.systemDir} (name the system folder with --dir)`);
  const dry = !!args['dry-run'];
  const say = (s) => console.log(s);
  const kept = [];
  say(dry ? 'Dry run. This would:' : 'Uninstalling:');

  // settings.json first, so no hook points at a file that is gone
  const now = L.readBytes(p.settings);
  if (now) {
    const saved = m.settings.existed ? L.readBytes(p.settingsBefore) : null;
    if (L.ourBytes(m, 'settings', L.sha(now)) && (saved || !m.settings.existed)) {
      say(`  ${m.settings.existed ? 'put back' : 'remove'} ${p.settings}${m.settings.existed ? ' exactly as it was' : ' (there was none before)'}`);
      if (!dry) {
        if (saved) L.writeGuarded(p.settings, saved, now);
        else fs.unlinkSync(p.settings);
      }
    } else {
      let cur;
      try { cur = L.parseSettings(now); } catch (e) { throw new Error(`${p.settings} cannot be read (${e.message}); nothing was removed. Fix it first.`); }
      const next = L.removeFrom(cur.json, m.settings.added, p.systemDir);
      if (L.equal(next, cur.json)) say(`  nothing of VibeQuarters' is in ${p.settings}`);
      else {
        say(`  take VibeQuarters' entries out of ${p.settings} (it changed since the install, so the rest stays as it is now)`);
        if (!dry) L.writeGuarded(p.settings, L.printSettings(next, cur.style), now);
      }
    }
  }

  if (m.claudeMd && m.claudeMd.added) {
    const was = L.readBytes(p.claudeMd);
    const bytes = was && L.withoutImport(was, m.claudeMd);
    if (bytes && !bytes.equals(was)) {
      const gone = !bytes.length && !m.claudeMd.existed;
      say(`  ${gone ? 'remove' : 'take the rules line out of'} ${p.claudeMd}`);
      if (!dry) { if (gone) fs.unlinkSync(p.claudeMd); else L.writeGuarded(p.claudeMd, bytes, was); }
    }
  }

  const conf = L.readBytes(p.config);
  if (conf) {
    const saved = m.config.existed ? L.readBytes(p.configBefore) : null;
    if (L.ourBytes(m, 'config', L.sha(conf)) && (saved || !m.config.existed)) {
      say(`  ${saved ? 'put back' : 'remove'} ${p.config}`);
      if (!dry) { if (saved) L.writeGuarded(p.config, saved, conf, { backup: false }); else fs.unlinkSync(p.config); }
    } else if (!saved || !saved.equals(conf)) kept.push(`${p.config} (you edited it)`);
  }

  const app = m.appConfig && L.readBytes(m.appConfig.file);
  if (app) {
    if (L.sha(app) === m.appConfig.sha) {
      say(`  remove ${m.appConfig.file}`);
      if (!dry) fs.unlinkSync(m.appConfig.file);
    } else kept.push(`${m.appConfig.file} (you edited it)`);
  }

  let removed = 0;
  const dirs = new Set();
  for (const f of L.ourFiles(m)) {
    const cur = L.readBytes(f);
    if (!cur) continue;
    if (!L.ourSha(m, f, L.sha(cur))) { kept.push(`${f} (you edited it)`); continue; }
    removed++;
    dirs.add(path.dirname(f));
    if (!dry) fs.unlinkSync(f);
  }
  say(`  remove ${removed} installed files`);
  if (!dry) {
    for (const f of [p.settingsBefore, p.configBefore, p.manifest]) try { fs.unlinkSync(f); } catch (_e) { /* none */ }
    dirs.add(path.dirname(p.settingsBefore));
    dirs.add(p.systemDir);
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) L.pruneUp(d, [p.claude, p.home]);
  }
  if (fs.existsSync(p.systemDir) && !dry) kept.push(`${p.systemDir} (it holds files the installer did not write)`);
  for (const [f, what] of [
    [path.join(p.claude, 'coordination'), 'the coordination board'],
    [p.usage, 'the usage history'],
    [path.join(p.claude, 'hq-feed'), 'what sessions told the app'],
    [p.salt, 'the salt that hides the account id in the usage history'],
    [m.approvalsFile, 'what the page may approve'],
  ]) if (f && fs.existsSync(f)) kept.push(`${f} (${what})`);
  // the copies kept beside the files this and the installer changed
  const homes = new Set([p.settings, p.config, p.claudeMd, ...L.ourFiles(m)].flatMap((f) => [path.dirname(f), path.dirname(L.landsOn(f))].map((d) => path.resolve(d))));
  for (const d of homes) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_e) { /* gone */ }
    for (const n of names) if (/\.(vibequarters-backup|edited)-\d{8}-\d{6}/.test(n)) kept.push(`${path.join(d, n)} (a backup)`);
  }
  if (kept.length) { say('\nLeft in place (yours; delete them yourself if you want):'); for (const k of kept) say(`  ${k}`); }
  say(dry ? '' : '\nDone. Restart your Claude Code sessions.');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`uninstall: ${e.message}`); process.exitCode = 1; }
}
module.exports = { main };
