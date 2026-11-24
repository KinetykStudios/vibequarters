// What a figure's desk screens show, drawn on a 2D canvas. The center screen is the figure's newest step drawn
// like the app it ran in (an editor, a terminal, a search view, a browser, a search page, a reply), the left screen its
// newest steps and the right screen the files it touched; a one-line status strip (setStatus) sits under the
// center screen's content. The text types in at the room's typing pace (revealStep, called on each keystroke step), and
// a step whose result has not landed shows its input with a blinking cursor. With Streamer on, or with no step to show,
// every screen paints the stand-in content instead (the caller's `fake` painter), and no screenshot is asked for.
// Pure: no three.js and no DOM, so the checks run it on a recording context (test/screens.test.mjs). Every paint returns
// what it painted, { source: 'live' | 'fake', kind, text, shot, cursor }, which the caller keeps as the texture's
// userData.painted.
import { streaming, shown } from '../streamer.js';

export const STATUS_MAX = 40;
const W = 640, H = 400; // the center screen's drawing space; its canvas is scaled to it
const FW = 384, FH = 240; // the stand-in terminal's drawing space, and the side screens'
const chr = (n) => String.fromCharCode(n);
const ELLIPSIS = chr(0x2026), DOT = chr(0x25cf), BULLET = chr(0x2022), ARROW = chr(0x2192);
const MONO = (px, w = 400) => `${w} ${px}px ui-monospace,SFMono-Regular,Consolas,monospace`;
const SANS = (px, w = 400) => `${w} ${px}px -apple-system,"Segoe UI",Inter,sans-serif`;
const SHOT_ID = /^[0-9a-f]{32}$/, SPACE = /\s+/g;
const STRIP = 26; // the status strip's height
let reduced = false; // reduced motion: everything shows at once and the cursor holds still
export const setReduced = (v) => { reduced = !!v; };

// ---------- state ----------
export function newScreen(title = '') {
  return { title, screen: null, key: '', sig: '', reveal: { chars: 0, lines: 0 }, status: '', dirty: true, blink: true, img: null, imgId: null };
}
const keyOf = (sc) => (sc ? [sc.kind, sc.tool, sc.at, sc.head].join('|') : '');
const totals = (sc) => (sc.kind === 'reply' ? { chars: sc.lines.join('\n').length, lines: 0 } : { chars: sc.kind === 'shell' ? String(sc.head || '').length : 0, lines: sc.lines.length });
// A new screen from the payload (or null): true when it changed. The same step whose result lands keeps what it typed; a
// new step starts over; a new step or a new screenshot drops the loaded picture.
export function setScreen(T, sc) {
  sc = sc || null;
  const sig = sc ? JSON.stringify(sc) : '';
  if (sig === T.sig) return false;
  const key = keyOf(sc);
  if (key !== T.key) T.reveal = { chars: 0, lines: 0 };
  if (key !== T.key || !sc || T.imgId !== sc.shot) { T.img = null; T.imgId = null; }
  Object.assign(T, { screen: sc, sig, key, dirty: true });
  if (sc && reduced) T.reveal = totals(sc);
  return true;
}
// The status strip's one line (for example "Waiting for you"): white space squeezed, at most STATUS_MAX
// characters; empty or null clears it. True when it changed.
export function setStatus(T, text) {
  const c = [...String(text ?? '').replace(SPACE, ' ').trim()];
  const s = c.length > STATUS_MAX ? c.slice(0, STATUS_MAX - 1).join('') + ELLIPSIS : c.join('');
  if (s === T.status) return false;
  T.status = s; T.dirty = true;
  return true;
}
export const isLive = (T) => !streaming() && !!T.screen && !!PAINT[T.screen.kind];
export const pending = (T) => isLive(T) && !T.screen.done;
// One keystroke step: a reply types 4 characters, a command 6, then an edit or a terminal shows a line, a result 3 lines.
// True when it showed more.
export function revealStep(T) {
  const sc = T.screen;
  if (!sc) return false;
  const all = totals(sc), r = T.reveal;
  if (r.chars < all.chars) { r.chars = Math.min(all.chars, r.chars + (sc.kind === 'reply' ? 4 : 6)); return true; }
  if (r.lines < all.lines) { r.lines = Math.min(all.lines, r.lines + (sc.kind === 'edit' || sc.kind === 'shell' ? 1 : 3)); return true; }
  return false;
}
// The route of the screenshot the screen shows, by the id the server issued, while Streamer is off and it is not loaded
// yet; else null. Never a path: an id that is not the server's 32 hex characters asks for nothing.
export function wantShot(T) {
  const sc = T.screen;
  if (streaming() || !sc || (sc.kind !== 'shot' && sc.kind !== 'browser') || typeof sc.shot !== 'string' || !SHOT_ID.test(sc.shot) || T.imgId === sc.shot) return null;
  return '/api/screen/' + sc.shot;
}
// A desk's screenshot loader: the screenshot the screen names, once; it shows from the next paint. `get` gives the
// screen (T), `make` a new image. Returns load(), which the screen calls on every paint. Only the newest load counts:
// a newer id drops the older load, and when the screen wants none (Streamer pressed, whose repaint calls
// load, or a step away) the load in flight is dropped too, its src emptied so no more bytes arrive.
export function shotLoader(get, make = () => new Image()) {
  let loading = null, failed = null, img = null;
  const drop = () => { const i = img; img = loading = null; if (i) { i.onload = i.onerror = null; i.src = ''; } };
  return () => {
    const T = get(), url = wantShot(T);
    if (!url) return drop();
    if (url === loading || url === failed) return;
    drop();
    const id = T.screen.shot, i = img = make(); loading = url;
    i.onload = () => { if (img !== i) return; img = loading = null; if (T.gone || streaming() || !T.screen || T.screen.shot !== id) return; T.img = i; T.imgId = id; T.dirty = true; };
    i.onerror = () => { if (img !== i) return; img = loading = null; failed = url; };
    i.src = url;
  };
}

// ---------- drawing helpers ----------
const fit = (g, s, w) => {
  s = String(s);
  if (g.measureText(s).width <= w) return s;
  const c = [...s];
  while (c.length > 1 && g.measureText(c.join('') + ELLIPSIS).width > w) c.pop();
  return c.join('') + ELLIPSIS;
};
// words wrapped to a width, a word too long for it cut where it must
function wrap(g, s, w) {
  const out = [];
  let line = '';
  for (const word of String(s).split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (!line || g.measureText(next).width <= w) { line = next; continue; }
    out.push(line); line = word;
  }
  out.push(line);
  return out;
}
const round = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.fill(); };
// A hidden line: the server sends a secret line, and each line that belongs to it, as its indent in spaces,
// a NUL and its length (at most the screen's 160 characters), never its text (lib/describe.js barLine). The painters draw
// a dim bar that long where the text would be, so the code keeps its shape. No text can hold a NUL, the server drops
// every control first.
const BAR_LINE = new RegExp('^( {0,80})' + chr(0) + '(\\d{1,3})$'), BAR_FILL = 'rgba(128,128,128,.42)';
export const barOf = (s) => { const m = typeof s === 'string' ? BAR_LINE.exec(s) : null; return m ? { indent: m[1].length, len: Math.min(160, +m[2]) } : null; };
// the bar at the text's baseline y, from x past its indent, at most maxW wide; returns where it ends
function bar(g, rec, b, x, y, maxW) {
  const cw = g.measureText('0').width || 7, x0 = x + b.indent * cw, w = Math.min(b.len * cw, x + maxW - x0);
  if (w <= 0) return x0;
  g.fillStyle = BAR_FILL; g.fillRect(x0, y - 10, w, 12); rec.bars++;
  return x0 + w;
}
function cursor(g, T, rec, x, y, color) {
  if (!reduced && !T.blink) return;
  g.fillStyle = color; g.fillRect(x + 1, y - 12, 8, 15); rec.cursor = true;
}

// ---------- the center screen, one painter per kind; `bottom` is where the status strip begins ----------
function editorChrome(g, sc, put, dirty) {
  g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#252526'; g.fillRect(0, 0, W, 34);
  g.font = SANS(13);
  const name = sc.head || 'untitled', tw = Math.min(320, g.measureText(name).width + 48);
  g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, tw, 34);
  g.fillStyle = '#0078d4'; g.fillRect(0, 0, tw, 2);
  g.fillStyle = '#ffffff'; put(fit(g, name, tw - 40), 16, 22);
  if (dirty) { g.fillStyle = '#c5c5c5'; put(DOT, tw - 22, 22); }
  g.fillStyle = '#2b2b2b'; g.fillRect(0, 34, W, 1);
}
const ROW = 17, TOP = 44;
function paintEdit(g, T, sc, put, rec, bottom) {
  editorChrome(g, sc, put, !sc.done);
  g.font = MONO(13);
  if (sc.secret) { g.fillStyle = '#8b8b8b'; g.font = SANS(14); put('Hidden: this is a secrets file', 48, TOP + 30); return; }
  const max = Math.floor((bottom - TOP - 4) / ROW), shownLines = sc.lines.slice(0, Math.min(T.reveal.lines, max));
  let endX = 48, endY = TOP + 13;
  shownLines.forEach((l, i) => {
    const y = TOP + i * ROW, mark = l[0], body = l.slice(1), b = barOf(body);
    if (mark === '-' || mark === '+') {
      g.fillStyle = mark === '-' ? 'rgba(244,71,71,.16)' : 'rgba(80,200,120,.14)'; g.fillRect(0, y, W, ROW);
      g.fillStyle = mark === '-' ? '#f48771' : '#89d185'; put(mark, 26, y + 13);
    }
    if (b) { endX = bar(g, rec, b, 48, y + 13, W - 60); endY = y + 13; return; } // hidden: the row keeps its color, the bar on it
    g.fillStyle = mark === '-' ? '#f48771' : mark === '+' ? '#89d185' : '#d4d4d4';
    if (body) put(body, 48, y + 13);
    const w = g.measureText(body).width;
    if (mark === '-' && body) g.fillRect(48, y + 8, w, 1.5); // struck through
    endX = 48 + w; endY = y + 13;
  });
  if (!sc.done && shownLines.length === Math.min(sc.lines.length, max)) cursor(g, T, rec, endX, endY, '#aeafad');
}
// a Read result's numbered lines ("     1  code", or "1" and an arrow): the number in the gutter, the code beside it
const NUMBERED = new RegExp('^\\s*(\\d+)(?: {2}|' + ARROW + ')(.*)$');
function paintRead(g, T, sc, put, rec, bottom) {
  editorChrome(g, sc, put, false);
  g.font = MONO(13);
  if (sc.secret) { g.fillStyle = '#8b8b8b'; g.font = SANS(14); put('Hidden: this is a secrets file', 48, TOP + 30); return; }
  if (!sc.done) return cursor(g, T, rec, 48, TOP + 13, '#aeafad');
  const max = Math.floor((bottom - TOP - 4) / ROW);
  sc.lines.slice(0, Math.min(T.reveal.lines, max)).forEach((l, i) => {
    const y = TOP + i * ROW + 13, b = barOf(l), m = b ? null : NUMBERED.exec(l);
    if (b) bar(g, rec, b, 12, y, W - 24);
    else if (m) {
      g.fillStyle = '#6e7681'; g.textAlign = 'right'; put(m[1], 40, y); g.textAlign = 'left';
      g.fillStyle = '#d4d4d4'; if (m[2]) put(m[2], 52, y);
    } else if (l) { g.fillStyle = '#d4d4d4'; put(l, 52, y); }
  });
}
const MATCH = /^([^:\n]+?):(\d+):(.*)$/;
function paintSearch(g, T, sc, put, rec, bottom) {
  g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#bbbbbb'; g.font = SANS(11, 600); put(String(sc.title || 'Search'), 16, 22);
  g.fillStyle = '#3c3c3c'; g.fillRect(12, 32, W - 24, 28);
  g.strokeStyle = '#007fd4'; g.lineWidth = 1; g.strokeRect(12.5, 32.5, W - 25, 27);
  g.font = MONO(13); g.fillStyle = '#cccccc';
  const hb = barOf(sc.head), pat = hb ? '' : fit(g, sc.head || '', W - 48);
  const patEnd = hb ? bar(g, rec, hb, 20, 51, W - 48) : 20 + g.measureText(pat).width;
  if (pat) put(pat, 20, 51);
  if (!sc.done) return cursor(g, T, rec, patEnd, 51, '#cccccc');
  const max = Math.floor((bottom - 76) / 19);
  sc.lines.slice(0, Math.min(T.reveal.lines, max)).forEach((l, i) => {
    const y = 88 + i * 19, b = barOf(l), m = b ? null : MATCH.exec(l);
    let x = 16;
    const part = (s, color) => { if (!s) return; g.fillStyle = color; put(s, x, y); x += g.measureText(s).width + 8; };
    if (b) bar(g, rec, b, 16, y, W - 32);
    else if (m) { part(m[1], '#4fc1ff'); part(m[2], '#8b8b8b'); part(m[3].trim(), '#d4d4d4'); } else part(l, '#cccccc');
  });
}
function paintShell(g, T, sc, put, rec, bottom) {
  const ps = sc.tool === 'PowerShell';
  g.fillStyle = '#0c0c0c'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1f1f1f'; g.fillRect(0, 0, W, 32);
  g.fillStyle = '#0c0c0c'; g.fillRect(0, 0, 170, 32);
  g.font = SANS(12); g.fillStyle = '#cccccc'; put(ps ? 'PowerShell' : 'bash', 16, 21);
  g.font = MONO(13);
  // a hidden command shows whole from its first keystroke: the prompt, then its bar
  const full = String(sc.head || ''), hb = barOf(full);
  const prompt = ps ? 'PS> ' : '$ ', head = hb ? full : full.slice(0, T.reveal.chars), typed = T.reveal.chars >= full.length;
  const rows = [{ cmd: head }, ...(typed ? sc.lines.slice(0, T.reveal.lines) : []).map((l) => ({ out: l }))];
  const ended = sc.done && typed && T.reveal.lines >= sc.lines.length;
  if (ended) rows.push({ cmd: '', end: true });
  const max = Math.floor((bottom - 42) / ROW), from = Math.max(0, rows.length - max);
  rows.slice(from).forEach((r, i) => {
    const y = 56 + i * ROW;
    if (r.out !== undefined) {
      const b = barOf(r.out);
      if (b) bar(g, rec, b, 14, y, W - 28); else if (r.out) { g.fillStyle = '#cccccc'; put(r.out, 14, y); }
      return;
    }
    g.fillStyle = r.end && sc.error ? '#e74856' : ps ? '#cccccc' : '#16c60c'; put(prompt, 14, y);
    const x = 14 + g.measureText(prompt).width, b = barOf(r.cmd);
    g.fillStyle = '#f2f2f2';
    let end = x;
    if (b) end = bar(g, rec, b, x, y, W - 14 - x);
    else { if (r.cmd) put(r.cmd, x, y); end = x + g.measureText(r.cmd).width; }
    if (r.end || (!sc.done && typed)) cursor(g, T, rec, end, y, '#cccccc');
  });
}
// A browser window: the tab with the page's title, the address bar with its URL (or a search's query), the page below
function browserChrome(g, T, rec, put, tab, addr, search, caret) {
  g.fillStyle = '#dee1e6'; g.fillRect(0, 0, W, 36);
  g.fillStyle = '#ffffff'; round(g, 8, 6, 260, 34, 8);
  g.fillStyle = '#9aa0a6'; g.beginPath(); g.arc(24, 23, 6, 0, Math.PI * 2); g.fill();
  g.font = SANS(12); g.fillStyle = '#3c4043';
  const tb = barOf(tab);
  if (tb) bar(g, rec, { indent: 0, len: tb.len }, 38, 27, 220); else if (tab) put(fit(g, tab, 220), 38, 27);
  g.fillStyle = '#ffffff'; g.fillRect(0, 36, W, 38);
  g.strokeStyle = '#5f6368'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(26, 55); g.lineTo(14, 55); g.moveTo(19, 50); g.lineTo(14, 55); g.lineTo(19, 60); g.stroke(); // back
  g.beginPath(); g.moveTo(40, 55); g.lineTo(52, 55); g.moveTo(47, 50); g.lineTo(52, 55); g.lineTo(47, 60); g.stroke(); // forward
  g.beginPath(); g.arc(74, 55, 6, 0.4, Math.PI * 1.8); g.stroke(); // reload
  g.fillStyle = '#f1f3f4'; round(g, 96, 42, W - 108, 26, 13);
  g.strokeStyle = '#5f6368'; g.lineWidth = 1.5;
  if (search) { g.beginPath(); g.arc(114, 54, 4.5, 0, Math.PI * 2); g.moveTo(117.5, 57.5); g.lineTo(121, 61); g.stroke(); }
  else { g.fillStyle = '#5f6368'; g.fillRect(110, 54, 9, 7); g.beginPath(); g.arc(114.5, 54, 3, Math.PI, 0); g.stroke(); }
  g.font = SANS(13); g.fillStyle = '#202124';
  const ab = barOf(addr), a = ab ? '' : fit(g, addr || '', W - 160);
  const aEnd = ab ? bar(g, rec, { indent: 0, len: ab.len }, 130, 60, W - 160) : 130 + g.measureText(a).width;
  if (a) put(a, 130, 60);
  if (caret) cursor(g, T, rec, aEnd, 60, '#202124');
  g.fillStyle = '#dadce0'; g.fillRect(0, 74, W, 1);
}
// A page's text: an accessibility snapshot (yaml lines like `- heading "Title" [level=1] [ref=e3]`) laid out as the page
// it describes, or plain text (a fetched page) with its markdown headings and list items.
const SNAP = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s*(.*))?$/;
const REF = /\[ref=[a-z0-9]+\]/, HEADING = /^(#{1,6})\s+(.*)$/, LIST_ITEM = /^[-*]\s+(.*)$/, QUOTE = /\\"/g, LEVEL = /level=(\d)/;
const NAMED = new Set(['link', 'button', 'img', 'tab', 'checkbox', 'radio', 'menuitem', 'option', 'switch']);
const FIELDS = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);
export function pageItems(lines) {
  const snap = lines.some((l) => REF.test(l)), out = [];
  for (const l of lines) {
    const b = barOf(l);
    if (b) { out.push({ role: 'hidden', len: b.len }); continue; } // a hidden line is a bar on the page too
    if (!snap) {
      const t = l.trim(), h = HEADING.exec(t), li = LIST_ITEM.exec(t);
      if (!t) continue;
      out.push(h ? { role: 'heading', level: h[1].length, text: h[2] } : li ? { role: 'listitem', text: li[1] } : { role: 'paragraph', text: t });
      continue;
    }
    const m = SNAP.exec(l);
    if (!m) continue;
    const [, , role, name0, attrs, text0] = m, name = (name0 || '').replace(QUOTE, '"'), text = (text0 || '').trim();
    if (role === 'heading') { if (name || text) out.push({ role, level: +((LEVEL.exec(attrs) || [])[1] || 2), text: name || text }); }
    else if (FIELDS.has(role)) out.push({ role: 'field', label: name, text });
    else if (NAMED.has(role)) { if (name || text) out.push({ role, text: name || text }); }
    else if (text) out.push({ role: role === 'listitem' ? 'listitem' : 'paragraph', text });
  }
  return out;
}
// every regex the painters run on a screen's text, by name, for the timing test (test/screen-time.test.mjs)
export const PAGE_RES = { shotId: SHOT_ID, space: SPACE, match: MATCH, numbered: NUMBERED, snapLine: SNAP, heading: HEADING, listItem: LIST_ITEM, quote: QUOTE, level: LEVEL, ref: REF, bar: BAR_LINE };
function paintPage(g, put, items, bottom, rec) {
  let y = 98;
  const X = 28, WIDTH = W - 56;
  for (let i = 0; i < items.length && y < bottom - 8; i++) {
    const it = items[i];
    if (it.role === 'hidden') { g.font = SANS(14); bar(g, rec, { indent: 0, len: it.len }, X, y + 10, WIDTH); y += 26; continue; }
    if (it.role === 'link') { // a run of links reads as a menu bar
      g.font = SANS(14); g.fillStyle = '#1a0dab';
      let x = X;
      for (; i < items.length && items[i].role === 'link'; i++) { const s = fit(g, items[i].text, WIDTH); if (x + g.measureText(s).width > X + WIDTH && x > X) break; put(s, x, y + 4); x += g.measureText(s).width + 20; }
      i--; y += 30; continue;
    }
    if (it.role === 'heading') {
      const px = it.level <= 1 ? 24 : it.level === 2 ? 18 : 15;
      g.font = SANS(px, 700); g.fillStyle = '#202124';
      for (const s of wrap(g, it.text, WIDTH)) { if (y >= bottom - 8) break; put(s, X, y + px * 0.75); y += px + 8; }
      y += 4; continue;
    }
    if (it.role === 'button') {
      g.font = SANS(13, 600); const s = fit(g, it.text, WIDTH - 28), w = g.measureText(s).width + 28;
      g.fillStyle = '#1a73e8'; round(g, X, y - 4, w, 28, 6); g.fillStyle = '#ffffff'; put(s, X + 14, y + 14); y += 36; continue;
    }
    if (it.role === 'img') {
      g.fillStyle = '#e8eaed'; g.fillRect(X, y - 4, 220, 104);
      g.font = SANS(12); g.fillStyle = '#5f6368'; put(fit(g, it.text, 200), X + 10, y + 52); y += 112; continue;
    }
    if (it.role === 'field') {
      g.font = SANS(12); g.fillStyle = '#5f6368'; if (it.label) put(fit(g, it.label, WIDTH), X, y + 6);
      g.strokeStyle = '#dadce0'; g.lineWidth = 1; g.strokeRect(X + 0.5, y + 12.5, 240, 28);
      g.font = SANS(13); g.fillStyle = '#202124'; if (it.text) put(fit(g, it.text, 224), X + 10, y + 31); y += 50; continue;
    }
    g.font = SANS(14); g.fillStyle = '#3c4043';
    const lead = it.role === 'listitem' ? BULLET + ' ' : '';
    for (const s of wrap(g, lead + it.text, WIDTH)) { if (y >= bottom - 8) break; put(s, X, y + 10); y += 20; }
    y += 6;
  }
}
function paintBrowser(g, T, sc, put, rec, bottom) {
  const caret = !sc.done;
  browserChrome(g, T, rec, put, sc.title || sc.head, sc.head, false, caret);
  g.fillStyle = '#ffffff'; g.fillRect(0, 75, W, bottom - 75);
  if (T.img && sc.shot && T.imgId === sc.shot) {
    const im = T.img, h = im.height * (W / im.width);
    g.save(); g.beginPath(); g.rect(0, 75, W, bottom - 75); g.clip(); g.drawImage(im, 0, 75, W, h); g.restore();
    rec.shot = sc.shot;
    return;
  }
  if (caret) { g.fillStyle = '#1a73e8'; g.fillRect(0, 75, W * 0.35, 3); return; }
  const items = pageItems(sc.lines.slice(0, T.reveal.lines));
  if (items.length) return paintPage(g, put, items, bottom, rec);
  if (sc.title && !sc.shot) {
    g.font = SANS(16); g.fillStyle = '#5f6368';
    const tb = barOf(sc.title);
    if (tb) { const w = Math.min(W - 80, tb.len * (g.measureText('0').width || 7)); bar(g, rec, { indent: 0, len: tb.len }, (W - w) / 2, (75 + bottom) / 2, W - 80); }
    else { g.textAlign = 'center'; put(fit(g, sc.title, W - 80), W / 2, (75 + bottom) / 2); g.textAlign = 'left'; }
  }
}
function paintWeb(g, T, sc, put, rec, bottom) {
  browserChrome(g, T, rec, put, sc.head, sc.head, true, false);
  g.fillStyle = '#ffffff'; g.fillRect(0, 75, W, bottom - 75);
  g.strokeStyle = '#dfe1e5'; g.lineWidth = 1; g.beginPath(); if (g.roundRect) g.roundRect(28.5, 92.5, W - 57, 40, 20); else g.rect(28.5, 92.5, W - 57, 40); g.stroke();
  g.font = SANS(15); g.fillStyle = '#202124';
  const qb = barOf(sc.head), q = qb ? '' : fit(g, sc.head || '', W - 110);
  const qEnd = qb ? bar(g, rec, { indent: 0, len: qb.len }, 52, 118, W - 110) : 52 + g.measureText(q).width;
  if (q) put(q, 52, 118);
  if (!sc.done) return cursor(g, T, rec, qEnd, 118, '#202124');
  g.font = SANS(17);
  const max = Math.floor((bottom - 150) / 36);
  sc.lines.slice(0, Math.min(T.reveal.lines, max)).forEach((l, i) => {
    const b = barOf(l);
    if (b) bar(g, rec, { indent: 0, len: b.len }, 30, 170 + i * 36, W - 60); else { g.fillStyle = '#1a0dab'; put(fit(g, l, W - 60), 30, 170 + i * 36); }
    g.fillStyle = '#dadce0'; g.fillRect(30, 180 + i * 36, 80, 1);
  });
}
function paintReply(g, T, sc, put, rec, bottom) {
  g.fillStyle = '#262624'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1f1e1d'; g.fillRect(0, 0, W, 30);
  for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) { g.fillStyle = c; g.beginPath(); g.arc(18 + i * 18, 15, 5, 0, Math.PI * 2); g.fill(); }
  g.font = SANS(15);
  const all = sc.lines.join('\n'), typed = all.slice(0, T.reveal.chars), rows = [];
  for (const para of typed.split('\n')) {
    if (!para) { rows.push(null); continue; }
    // a hidden line is a bar once its length has typed in; a bar still typing draws nothing yet
    if (para.includes(chr(0))) { const b = barOf(para); if (b) rows.push(b); continue; }
    rows.push(...wrap(g, para, W - 56));
  }
  // the newest rows that fit, as a chat scrolls while it types
  const height = (r) => (r === null ? 10 : 21);
  let used = 0, from = rows.length;
  while (from > 0 && used + height(rows[from - 1]) <= bottom - 58) used += height(rows[--from]);
  let y = 56, last = null;
  for (const r of rows.slice(from)) {
    if (r === null) { y += 10; continue; }
    if (typeof r === 'object') { last = [bar(g, rec, r, 28, y, W - 56), y]; y += 21; continue; }
    g.fillStyle = '#ece9e4'; put(r, 28, y); last = [28 + g.measureText(r).width, y]; y += 21;
  }
  if (typed.length < all.length && last) cursor(g, T, rec, last[0] + 2, last[1], '#d97757');
}
const PAINT = { edit: paintEdit, read: paintRead, search: paintSearch, shell: paintShell, browser: paintBrowser, shot: paintBrowser, web: paintWeb, reply: paintReply };
const LIGHT = new Set(['browser', 'shot', 'web']);

// The center screen on a canvas of cw x ch: the newest step drawn like its app, or the stand-in terminal (fake(title), in
// its own 384 x 240 space) while Streamer is on, with no step, or for a step of any other kind (titled with its label),
// then the status strip. Returns what it painted.
export function paintCenter(g, T, cw, ch, fake) {
  const sc = T.screen, rec = { source: 'fake', kind: sc ? sc.kind : null, text: [], shot: null, cursor: false, light: false, bars: 0 };
  const put = (s, x, y) => { s = String(s); g.fillText(s, x, y); rec.text.push(s); };
  const bottom = T.status ? H - STRIP : H;
  if (isLive(T)) {
    rec.source = 'live';
    rec.light = LIGHT.has(sc.kind); // a white page: the caller dims its screen so it does not glare
    g.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    PAINT[sc.kind](g, T, sc, put, rec, bottom);
  } else {
    g.setTransform(cw / FW, 0, 0, ch / FH, 0, 0);
    const title = shown(sc && sc.kind === 'other' && sc.head ? sc.head : T.title || '').toUpperCase();
    rec.text.push(title);
    fake(title);
  }
  if (T.status) {
    g.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    g.fillStyle = '#ff9f0a'; g.fillRect(0, H - STRIP, W, STRIP);
    g.save(); if (streaming()) g.filter = 'blur(5px)';
    g.font = SANS(14, 600); g.fillStyle = '#1b1c1f'; g.textAlign = 'left'; put(shown(T.status), 14, H - 8);
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return rec;
}

// ---------- the side screens: the newest steps (left) and the files touched (right) ----------
export function newSide(which) { return { which, screen: null, data: '', sig: '' }; }
// True when the part of the screen this side shows changed.
export function setSide(S, sc) {
  const data = sc ? JSON.stringify(S.which === 'steps' ? sc.steps : sc.files) : '';
  if (data === S.data) return false;
  S.data = data; S.screen = sc || null;
  return true;
}
export function ago(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const rowsOf = (S, now) => (S.which === 'steps' ? (S.screen.steps || []).map((s) => [ago(now - s.at), s.label]) : (S.screen.files || []).map((f) => [f.edit ? 'edit' : 'read', f.name]));
// What paintSide would draw now, so a repaint happens only when it would differ (a time ago changes once a minute)
export function sideSig(S, now) { return !S.screen || streaming() ? 'fake' : JSON.stringify(rowsOf(S, now)); }
export function paintSide(g, S, cw, ch, fake, now) {
  const rec = { source: 'fake', kind: S.which, text: [], shot: null, cursor: false };
  g.setTransform(cw / FW, 0, 0, ch / FH, 0, 0);
  if (!S.screen || streaming()) { fake(); g.setTransform(1, 0, 0, 1, 0, 0); return rec; }
  rec.source = 'live';
  const put = (s, x, y) => { s = String(s); g.fillText(s, x, y); rec.text.push(s); };
  g.textAlign = 'left';
  g.fillStyle = '#020605'; g.fillRect(0, 0, FW, FH);
  g.fillStyle = '#30d158'; g.font = MONO(16, 700); put(S.which === 'steps' ? 'STEPS' : 'FILES', 18, 30);
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(18, 40, FW - 36, 1);
  const rows = rowsOf(S, now);
  if (S.which === 'steps') {
    rows.slice(0, 6).forEach(([when, label], i) => {
      const y = 70 + i * 28;
      g.font = MONO(13); g.fillStyle = '#8e8e93'; put(when, 18, y);
      g.font = SANS(15); g.fillStyle = i ? '#c7c7cc' : '#ffffff'; put(fit(g, label, FW - 78), 62, y);
    });
  } else {
    rows.slice(0, 8).forEach(([how, name], i) => {
      const y = 66 + i * 22;
      g.fillStyle = how === 'edit' ? '#30d158' : '#636366'; g.fillRect(18, y - 9, 8, 8);
      g.font = MONO(14); g.fillStyle = how === 'edit' ? '#ffffff' : '#aeaeb2'; put(fit(g, name, FW - 54), 36, y);
    });
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return rec;
}
