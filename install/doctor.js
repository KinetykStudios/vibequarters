#!/usr/bin/env node
// Says what is installed and whether it is in order: versions, packs, hooks, files, config. Changes nothing.
//
//   node "$HOME/.claude/vibequarters/install/doctor.js" [--home <dir>] [--dir <system folder>]
//
// Exit 0 = in order, 1 = a problem was found.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const runs = (cmd) => L.runs(`${cmd} --version`);

function main(argv) {
  const args = L.parseArgs(argv, { home: 'value', dir: 'value' });
  const here = path.resolve(__dirname, '..');
  const p = L.paths({ home: args.home, dir: args.dir || (fs.existsSync(path.join(here, L.MANIFEST)) ? here : undefined) });
  let problems = 0;
  const ok = (t) => console.log(`ok       ${t}`);
  const note = (t) => console.log(`note     ${t}`);
  const bad = (t) => { problems++; console.log(`PROBLEM  ${t}`); };

  Number(process.versions.node.split('.')[0]) >= L.MIN_NODE ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node}; ${L.MIN_NODE} or newer is needed`);
  const v = L.claudeVersion();
  if (!v) note(`Claude Code is not on the PATH; ${L.MIN_CLAUDE} or newer is needed`);
  else if (L.versionOk(v)) ok(`Claude Code ${v}`);
  else bad(`Claude Code ${v}; ${L.MIN_CLAUDE} or newer is needed`);
  runs('git') ? ok('git') : bad('git is not on the PATH');

  const m = L.readManifest(p);
  if (!m) { bad(`no install found in ${p.systemDir}`); return 1; }
  m.pending ? bad('the last install stopped partway (run install.js again, or uninstall.js)') : ok(`VibeQuarters ${m.version} in ${p.systemDir}`);
  for (const x of L.PACKS) console.log(`${m.packs.includes(x.id) ? 'on      ' : 'off     '} ${x.title} (${x.id})`);
  if (m.packs.includes('merge-gate') && !runs('gh')) note('the gh CLI is not on the PATH; /land and the merge gate need it');

  let config = null;
  try { config = JSON.parse(fs.readFileSync(p.config, 'utf8')); } catch (e) { e.code === 'ENOENT' ? bad(`no ${p.config}; the defaults are used`) : bad(`${p.config} is not valid JSON, so the defaults are used`); }
  if (config) ok(`config ${p.config}`);
  if (process.env.VIBEQUARTERS_CONFIG) note(`VIBEQUARTERS_CONFIG is set, so hooks read ${process.env.VIBEQUARTERS_CONFIG}`);
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') note('VIBEQUARTERS_GUARD=off: every guard is off');
  if (fs.existsSync(path.join(p.claude, 'HALT'))) note(`${path.join(p.claude, 'HALT')} exists: every acting tool is blocked until you delete it`);

  let settings = null;
  try { settings = L.parseSettings(L.readBytes(p.settings)).json; } catch (e) { bad(`${p.settings}: ${e.message}`); }
  if (settings) {
    const missing = m.settings.added.groups.filter(({ event, group }) => !((settings.hooks || {})[event] || []).some((g) => L.isPlain(g) && Array.isArray(g.hooks) && g.hooks.some((h) => L.equal(h, group.hooks[0]))));
    missing.length ? bad(`${missing.length} hook entries are no longer in settings.json (run install.js again): ${missing.map((x) => `${x.event} ${path.basename((x.group.hooks[0].args || [x.group.hooks[0].command.split('"')[1]])[0])}`).join(', ')}`) : ok(`${m.settings.added.groups.length} hook entries in settings.json`);
    if (settings.disableAllHooks === true) bad('settings.json has disableAllHooks: true, so no hook runs');
    const dirs = String((settings.env || {})[L.PLUGIN_DIRS] || '').split(L.sep()).map((d) => L.slash(d).toLowerCase());
    for (const d of m.settings.added.pluginDirs) dirs.includes(d.toLowerCase()) ? ok(`mod ${path.basename(d)}`) : bad(`mod ${path.basename(d)} is not in ${L.PLUGIN_DIRS}`);
  }
  let edited = 0, gone = 0;
  for (const [f, h] of Object.entries(m.files)) { const b = L.readBytes(f); if (!b) gone++; else if (L.sha(b) !== h) edited++; }
  gone ? bad(`${gone} installed files are missing (run install.js again)`) : ok(`${Object.keys(m.files).length} installed files`);
  if (edited) note(`${edited} installed files were edited`);
  if (m.packs.includes('companions') && !fs.existsSync(p.salt)) bad(`no ${p.salt}; the usage line records nothing (run install.js again)`);
  if (m.appDir) {
    if (!fs.existsSync(path.join(m.appDir, 'server.js'))) bad(`the app is no longer in ${m.appDir}`);
    else {
      let control = false;
      try { control = JSON.parse(fs.readFileSync(path.join(m.appDir, 'hq.config.json'), 'utf8')).control === true; } catch (_e) { /* the example config: read-only */ }
      ok(`app in ${m.appDir}, answering from the page is ${control ? 'on' : 'off ("control": true in hq.config.json turns it on)'}`);
    }
  }
  console.log(problems ? `\n${problems} problem(s).` : '\nIn order.');
  return problems ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`doctor: ${e.message}`); process.exitCode = 1; }
}
module.exports = { main };
