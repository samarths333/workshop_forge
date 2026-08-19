/* THE CURSOR.

   ⌘K, type three letters, press enter. Every capability in the app reachable
   from one place without knowing where it lives — which is the actual
   complaint the toolbars were answering badly.

   Lifted from Jarvis's command palette and cut down to what this app needs:
   a hotkey that works from anywhere, a ranked list that never goes empty,
   recents at the top so the four things you do all day are one keystroke
   away, and a confirm step for the one action that destroys something.

   Two things it does that a plain menu cannot:

     · UNAVAILABLE ACTIONS ARE SHOWN, GREYED. A palette whose contents change
       depending on what the app is doing is a palette nobody learns, because
       the thing you looked for last time is missing this time and you cannot
       tell whether you misremembered it or it does not apply. Greying it and
       saying WHY teaches the shape of the app.
     · IT SAYS WHAT WILL HAPPEN. Every row carries its group, its shortcut if
       it has one, and a warning marker if it spends a key or destroys
       something. Authority is visible before you press enter, not after.

   This file owns the palette's DOM and nothing else. What an action DOES is
   bound in app.js by id. */

import { rankActions, actionById, AUTHORITY, isAvailable } from './actions.js';

const RECENT_KEY = 'forge:palette-recent';
const MAX_RECENT = 5;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Why an action cannot be run right now, in the words a person would use. */
const WHY_NOT = {
  idle: 'the floor is busy',
  building: 'nothing is being built',
  settled: 'nothing on the pedestal yet',
  bench: 'open the bench first',
  notbench: 'not while the bench is open'
};

export class Palette {
  /* onRun(id) → whatever running it means; the palette does not care.
     getState() → { building, settled, bench } — asked fresh on every open,
     because the shop moves and a palette showing last minute's state is
     worse than one showing none. */
  constructor({ root, onRun, getState }) {
    this.root = root;
    this.onRun = onRun || (() => {});
    this.getState = getState || (() => ({}));
    this.open = false;
    this.index = 0;
    this.rows = [];
    this.pending = null;                 // an action waiting to be confirmed

    this.el = {
      box: root.querySelector('.palBox'),
      input: root.querySelector('#palInput'),
      list: root.querySelector('#palList'),
      note: root.querySelector('#palNote')
    };

    this.el.input.addEventListener('input', () => this.render());
    this.el.input.addEventListener('keydown', e => this.onKey(e));
    root.addEventListener('pointerdown', e => { if (e.target === root) this.close(); });
    this.el.list.addEventListener('pointerdown', e => {
      const li = e.target.closest('li[data-id]');
      if (li) { e.preventDefault(); this.choose(li.dataset.id); }
    });
    this.el.list.addEventListener('pointermove', e => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const i = this.rows.findIndex(r => r.action.id === li.dataset.id);
      if (i >= 0 && i !== this.index) { this.index = i; this.paintCursor(); }
    });
  }

  /* ---------------- recents ---------------- */
  /* Kept on this machine and nowhere else. If storage is unavailable or full
     the palette still works — recents are a convenience, not state. */
  recent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(id => actionById(id)); }
    catch { return []; }
  }

  remember(id) {
    try {
      const list = [id, ...this.recent().filter(x => x !== id)].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch { /* private mode, quota, whatever — not worth a broken palette */ }
  }

  /* ---------------- opening and closing ---------------- */
  show(seed = '') {
    this.state = this.getState();
    this.pending = null;
    this.open = true;
    this.root.hidden = false;
    this.el.input.value = seed;
    this.el.input.placeholder = 'What do you want to do?';
    this.index = 0;
    this.render();
    this.el.input.focus();
    this.el.input.select();
  }

  close() {
    this.open = false;
    this.pending = null;
    this.root.hidden = true;
    this.el.input.value = '';
  }

  toggle() { this.open ? this.close() : this.show(); }

  /* ---------------- keys ---------------- */
  onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.pending ? this.cancelConfirm() : this.close(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); this.move(1); return; }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); this.move(-1); return; }
    if (e.key === 'Home') { e.preventDefault(); this.index = 0; this.paintCursor(); return; }
    if (e.key === 'End') { e.preventDefault(); this.index = this.rows.length - 1; this.paintCursor(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.pending) { this.confirmed(); return; }
      const row = this.rows[this.index];
      if (row) this.choose(row.action.id);
    }
  }

  move(d) {
    if (!this.rows.length) return;
    this.index = (this.index + d + this.rows.length) % this.rows.length;
    this.paintCursor();
  }

  /* ---------------- running one ---------------- */
  choose(id) {
    const action = actionById(id);
    if (!action) return;
    if (!isAvailable(action, this.state)) {
      this.el.note.textContent = `${action.label} — ${WHY_NOT[action.when] || 'not right now'}.`;
      this.el.note.className = 'palNote warn';
      return;
    }
    /* Destroying something asks every time. Not a checkbox, not a "don't ask
       again" — the whole value of the confirm is that it is still there on
       the day you meant to press something else. */
    if (action.confirm) { this.askConfirm(action); return; }
    this.remember(id);
    this.close();
    this.onRun(id);
  }

  askConfirm(action) {
    this.pending = action;
    this.el.note.innerHTML = `<b>${esc(action.label)}</b> — ${esc(action.confirm)} <em>Enter to confirm, Esc to back out.</em>`;
    this.el.note.className = 'palNote danger';
    this.el.list.classList.add('dimmed');
  }

  cancelConfirm() {
    this.pending = null;
    this.el.list.classList.remove('dimmed');
    this.render();
  }

  confirmed() {
    const action = this.pending;
    this.pending = null;
    this.el.list.classList.remove('dimmed');
    this.remember(action.id);
    this.close();
    this.onRun(action.id);
  }

  /* ---------------- drawing ---------------- */
  render() {
    const q = this.el.input.value;
    this.rows = rankActions(q, { state: this.state, recent: this.recent() });
    if (this.index >= this.rows.length) this.index = 0;

    const showGroups = !q.trim();
    let lastGroup = null;
    const html = [];
    this.rows.forEach((row, i) => {
      const a = row.action;
      if (showGroups && a.group !== lastGroup) {
        lastGroup = a.group;
        html.push(`<li class="palGroup">${esc(a.group)}</li>`);
      }
      const marks = [];
      if (a.authority >= AUTHORITY.destroys) marks.push('<span class="palMark bad">destructive</span>');
      else if (a.authority >= AUTHORITY.spends) marks.push('<span class="palMark spend">uses a key</span>');
      else if (a.authority >= AUTHORITY.writes) marks.push('<span class="palMark">writes a file</span>');

      html.push(
        `<li data-id="${esc(a.id)}" class="palRow${i === this.index ? ' on' : ''}${row.available ? '' : ' off'}">
           <div class="palMain">
             <span class="palLabel">${esc(a.label)}</span>
             ${a.hint ? `<span class="palHint">${esc(a.hint)}</span>` : ''}
           </div>
           <div class="palSide">
             ${marks.join('')}
             ${row.available ? '' : `<span class="palMark">${esc(WHY_NOT[a.when] || '')}</span>`}
             ${a.hotkey ? `<kbd>${esc(a.hotkey)}</kbd>` : ''}
           </div>
         </li>`
      );
    });

    this.el.list.innerHTML = html.join('') || '<li class="palEmpty">Nothing matches that.</li>';
    this.el.note.className = 'palNote';
    this.el.note.textContent = q.trim()
      ? `${this.rows.length} match${this.rows.length === 1 ? '' : 'es'} · ↑↓ to move · ⏎ to run`
      : 'Type to search · ↑↓ to move · ⏎ to run · Esc to close';
    this.scrollToCursor();
  }

  paintCursor() {
    const rows = [...this.el.list.querySelectorAll('li[data-id]')];
    rows.forEach((el, i) => el.classList.toggle('on', i === this.index));
    this.scrollToCursor();
  }

  scrollToCursor() {
    const el = this.el.list.querySelectorAll('li[data-id]')[this.index];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

/* The global hotkey. ⌘K anywhere, including from inside the request box,
   which is where you are when you realise you wanted a different thing. */
export function bindPaletteHotkey(palette) {
  window.addEventListener('keydown', e => {
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      palette.toggle();
    }
  }, true);
}
