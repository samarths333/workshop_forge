/* EVERY THING THE SHOP CAN BE TOLD TO DO, IN ONE PLACE.

   Before this, the app's capabilities were scattered across three toolbars,
   nine keyboard shortcuts and a settings sheet, and the only way to find out
   what a key did was to press it. That is fine for five commands and useless
   for forty.

   This is Jarvis's answer, ported: capabilities are a REGISTRY. Every one of
   them is a row with an id, a label, what it belongs to, the words somebody
   might reach for it by, an authority level and whether it needs confirming.
   The command palette is a view over the registry. The keyboard shortcuts
   are a view over the registry. The apprentice picks from a filtered view of
   the registry. Nothing has its own private list.

   Two things are deliberately NOT in here: what an action actually does, and
   any DOM. The registry is metadata, the handlers are bound in app.js by id,
   and `wiring.test.mjs` fails if the two ever disagree — an action in the
   palette with nothing behind it is a button that does nothing, which is
   worse than no button.

   AUTHORITY is the same idea as the crew's: a number, and a gate. Most
   actions are level 1 and just happen. Things that spend a key are level 4.
   Things that destroy something a person cannot get back are level 6 and
   have to be confirmed, every time, no remembering the answer. */

export const AUTHORITY = {
  free: 1,        // costs nothing, changes nothing you cannot see
  edits: 2,       // changes the build on the bench — undoable
  writes: 3,      // writes to disk: an export, the skill file
  spends: 4,      // spends somebody's API key
  destroys: 6     // takes something away that cannot be got back
};

/* `when` says the shape the app has to be in for the action to make sense.
   An action that does not apply is shown greyed rather than hidden — a
   palette whose contents change under you is a palette you cannot learn. */
export const WHEN = ['always', 'idle', 'building', 'settled', 'bench', 'notbench'];

export const ACTIONS = [
  /* ---------------- the build ---------------- */
  { id: 'build.run', label: 'Build it', group: 'Build', hotkey: '⌘⏎', when: 'idle', authority: AUTHORITY.spends,
    keywords: ['make', 'start', 'go', 'run', 'request', 'new'], hint: 'send what is in the box to the floor' },
  { id: 'build.stop', label: 'Stop the floor', group: 'Build', when: 'building', authority: AUTHORITY.free,
    keywords: ['halt', 'cancel', 'abort', 'quit'], hint: 'everybody down tools' },
  { id: 'build.again', label: 'Build that again', group: 'Build', when: 'settled', authority: AUTHORITY.spends,
    keywords: ['repeat', 'rerun', 'retry', 'redo build'], hint: 'same request, fresh from the top' },
  { id: 'build.random', label: 'Build something', group: 'Build', when: 'idle', authority: AUTHORITY.spends,
    keywords: ['surprise', 'anything', 'random', 'idea'], hint: 'let the floor pick — the same choice the apprentice would make' },

  /* ---------------- the bench ---------------- */
  { id: 'bench.toggle', label: 'Open the bench', group: 'Bench', hotkey: 'B', when: 'always', authority: AUTHORITY.free,
    keywords: ['cad', 'edit', 'inspect', 'drawing', 'properties'] },
  { id: 'bench.fit', label: 'Fit the view', group: 'Bench', hotkey: 'F', when: 'bench', authority: AUTHORITY.free,
    keywords: ['frame', 'zoom', 'all', 'centre'] },
  { id: 'bench.look', label: 'Look it over', group: 'Bench', hotkey: 'O', when: 'settled', authority: AUTHORITY.free,
    keywords: ['optimise', 'optimize', 'engineer', 'faults', 'check', 'review'], hint: 'what an engineer would change about it' },
  { id: 'bench.measure', label: 'Measure between two parts', group: 'Bench', hotkey: 'M', when: 'bench', authority: AUTHORITY.free,
    keywords: ['clearance', 'gap', 'distance', 'ruler'] },
  { id: 'bench.isolate', label: 'Isolate the selected part', group: 'Bench', hotkey: 'I', when: 'bench', authority: AUTHORITY.free,
    keywords: ['hide', 'solo', 'only', 'focus'] },
  { id: 'bench.section', label: 'Cut through it', group: 'Bench', hotkey: 'S', when: 'bench', authority: AUTHORITY.free,
    keywords: ['section', 'slice', 'inside', 'cross'] },
  { id: 'bench.add', label: 'Add a part', group: 'Bench', when: 'settled', authority: AUTHORITY.edits,
    keywords: ['new part', 'insert', 'more'] },
  { id: 'bench.undo', label: 'Undo', group: 'Bench', hotkey: '⌘Z', when: 'always', authority: AUTHORITY.edits,
    keywords: ['back', 'revert', 'step back'] },
  { id: 'bench.redo', label: 'Redo', group: 'Bench', hotkey: '⇧⌘Z', when: 'always', authority: AUTHORITY.edits,
    keywords: ['forward', 'again'] },
  { id: 'bench.teach', label: 'Teach the floor this', group: 'Bench', when: 'settled', authority: AUTHORITY.writes,
    keywords: ['learn', 'remember', 'save recipe', 'correct'], hint: 'your corrections become the recipe it starts from next time' },
  { id: 'bench.bom', label: 'Parts list as CSV', group: 'Bench', when: 'settled', authority: AUTHORITY.writes,
    keywords: ['bom', 'bill of materials', 'csv', 'parts'] },
  /* Making a shape needs no build on the pedestal — `bench` and not
     `settled`, because the moment somebody wants a shape the shop has not
     got is usually before there is anything to put it on. */
  { id: 'bench.shapes', label: 'Make a shape of your own', group: 'Bench', when: 'bench', authority: AUTHORITY.writes,
    keywords: ['shape', 'profile', 'custom', 'new shape', 'lathe', 'extrude', 'draw', 'primitive', 'library'],
    hint: 'draw a profile and save it — the planner can use it from then on' },
  { id: 'bench.run', label: 'Turn the engine over', group: 'Bench', hotkey: 'R', when: 'settled', authority: AUTHORITY.free,
    keywords: ['run', 'start', 'spin', 'crank', 'rotate', 'engine', 'motion', 'idle'],
    hint: 'the crank turns and the pistons follow the firing order' },

  /* ---------------- the floor ---------------- */
  { id: 'floor.software', label: 'Go to the spec desk', group: 'Floor', hotkey: '1', when: 'always', authority: AUTHORITY.free,
    keywords: ['software', 'byte', 'controls', 'requirements', 'station'] },
  { id: 'floor.metal', label: 'Go to the forge', group: 'Floor', hotkey: '2', when: 'always', authority: AUTHORITY.free,
    keywords: ['forge', 'metal', 'vulcan', 'structures', 'weld', 'anvil', 'station'] },
  { id: 'floor.finished', label: 'Go to the assembly bay', group: 'Floor', hotkey: '3', when: 'always', authority: AUTHORITY.free,
    keywords: ['assembly', 'gaffer', 'pedestal', 'finished', 'station'] },
  { id: 'floor.cardboard', label: 'Go to light materials', group: 'Floor', hotkey: '4', when: 'always', authority: AUTHORITY.free,
    keywords: ['cardboard', 'kraft', 'softgoods', 'panels', 'station'] },
  { id: 'floor.machining', label: 'Go to the machine shop', group: 'Floor', hotkey: '6', when: 'always', authority: AUTHORITY.free,
    keywords: ['machine', 'machining', 'mach', 'powerplant', 'lathe', 'mill', 'engine', 'station'] },
  { id: 'floor.electronics', label: 'Go to the electronics bench', group: 'Floor', hotkey: '5', when: 'always', authority: AUTHORITY.free,
    keywords: ['electrical', 'ampere', 'solder', 'circuit', 'station'] },
  { id: 'floor.follow', label: 'Follow the work', group: 'Floor', hotkey: 'F', when: 'notbench', authority: AUTHORITY.free,
    keywords: ['camera', 'track', 'chase'] },
  { id: 'floor.wide', label: 'Stand back and watch the floor', group: 'Floor', when: 'always', authority: AUTHORITY.free,
    keywords: ['wide', 'establish', 'whole shop', 'zoom out', 'overview'] },

  /* ---------------- what comes off the pedestal ---------------- */
  { id: 'export.plan', label: 'Save the plan as JSON', group: 'Export', when: 'settled', authority: AUTHORITY.writes,
    keywords: ['json', 'plan', 'download', 'save'] },
  { id: 'export.stl', label: 'Save an STL', group: 'Export', when: 'settled', authority: AUTHORITY.writes,
    keywords: ['stl', 'print', 'slicer', '3d', 'mesh'] },
  { id: 'export.obj', label: 'Save an OBJ', group: 'Export', when: 'settled', authority: AUTHORITY.writes,
    keywords: ['obj', 'blender', 'mesh', 'model'] },

  /* ---------------- what it has learned ---------------- */
  { id: 'skills.export', label: 'Export everything it has learned', group: 'Learned', when: 'always', authority: AUTHORITY.writes,
    keywords: ['skills', 'backup', 'save library'] },
  { id: 'skills.import', label: 'Import a skill library', group: 'Learned', when: 'always', authority: AUTHORITY.writes,
    keywords: ['skills', 'restore', 'load library', 'merge'] },
  { id: 'skills.forget', label: 'Forget everything it has learned', group: 'Learned', when: 'always', authority: AUTHORITY.destroys,
    confirm: 'This wipes every recipe and every correction on file. There is no undo.',
    keywords: ['wipe', 'reset', 'clear', 'delete skills', 'start over'] },

  /* ---------------- the apprenticeship ---------------- */
  { id: 'study.now', label: 'Practise something now', group: 'Apprentice', when: 'idle', authority: AUTHORITY.spends,
    keywords: ['study', 'train', 'learn', 'drill', 'practice'], hint: 'pick the thing it is worst at and build it' },
  { id: 'study.toggle', label: 'Practise when the shop is idle', group: 'Apprentice', when: 'always', authority: AUTHORITY.free,
    keywords: ['study', 'auto', 'idle', 'overnight', 'unattended'] },
  { id: 'study.plan', label: 'What would it practise next?', group: 'Apprentice', when: 'always', authority: AUTHORITY.free,
    keywords: ['curriculum', 'next', 'weakest', 'syllabus', 'report'], hint: 'the syllabus, and why each thing is on it' },

  /* ---------------- the engines ---------------- */
  { id: 'engine.settings', label: 'Engines and keys', group: 'Engine', hotkey: '⌘,', when: 'always', authority: AUTHORITY.free,
    keywords: ['settings', 'api key', 'provider', 'model', 'openai', 'anthropic', 'gemini', 'groq', 'ollama', 'config'] },
  { id: 'engine.test', label: 'Test every engine', group: 'Engine', when: 'always', authority: AUTHORITY.free,
    keywords: ['probe', 'check', 'ping', 'connection', 'reachable'] },
  { id: 'engine.offline', label: 'Work offline from here', group: 'Engine', when: 'always', authority: AUTHORITY.free,
    keywords: ['offline', 'no network', 'local only', 'disconnect'] },

  /* ---------------- the palette itself ---------------- */
  { id: 'app.log', label: 'Copy the shop log', group: 'App', when: 'always', authority: AUTHORITY.free,
    keywords: ['log', 'copy', 'clipboard', 'debug', 'transcript'] }
];

export const ACTION_IDS = ACTIONS.map(a => a.id);
const BY_ID = ACTIONS.reduce((m, a) => (m[a.id] = a, m), {});
export const actionById = id => BY_ID[id] || null;
export const GROUPS = [...new Set(ACTIONS.map(a => a.group))];

/* ------------------------------------------------------------------ */
/* is this one available right now                                     */
/* ------------------------------------------------------------------ */
/* `state` is the shop as the palette sees it: is a build running, is there
   something settled on the pedestal, is the bench open. */
export function isAvailable(action, state = {}) {
  switch (action.when) {
    case 'idle': return !state.building;
    case 'building': return !!state.building;
    case 'settled': return !!state.settled;
    case 'bench': return !!state.bench;
    case 'notbench': return !state.bench;
    default: return true;
  }
}

/* ------------------------------------------------------------------ */
/* finding one by typing                                               */
/* ------------------------------------------------------------------ */
/* Jarvis reaches for Fuse for this. This app ships with two dependencies and
   is not growing a third for forty rows, so the scoring is written out — and
   written to reward the three things people actually do:

     · type the start of the label            "bui" → Build it
     · type a word from the middle            "stl" → Save an STL
     · type the initials                      "lio" → Look it over

   Everything is scored, not filtered, so a near miss still appears rather
   than the list going empty and looking broken. */
export function scoreAction(query, action) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const label = action.label.toLowerCase();
  const group = action.group.toLowerCase();
  const hint = (action.hint || '').toLowerCase();
  const words = label.split(/\s+/);
  const initials = words.map(w => w[0]).join('');

  let best = 0;
  const bump = v => { if (v > best) best = v; };

  if (label === q) bump(1000);
  /* An exact keyword beats a prefix of a longer label, and it has to. In an
     app called Workshop Forge, "forge" is a prefix of "Forget everything it
     has learned" — and it is emphatically not what anybody typing it wants.
     A keyword that IS the query is somebody naming the thing; a prefix is
     somebody being halfway through a different word. */
  for (const k of action.keywords || []) if (k.toLowerCase() === q) bump(950);
  if (label.startsWith(q)) bump(900);
  if (initials.startsWith(q) && q.length > 1) bump(820);
  for (const w of words) if (w.startsWith(q)) bump(780);
  if (label.includes(q)) bump(600);
  if (group.toLowerCase().startsWith(q)) bump(560);
  for (const k of action.keywords || []) {
    const kw = k.toLowerCase();
    if (kw.startsWith(q)) bump(640);
    else if (kw.includes(q)) bump(480);
  }
  if (hint.includes(q)) bump(360);
  if (action.id.toLowerCase().includes(q)) bump(340);

  /* Last resort: the letters in order, anywhere. This is what makes "svstl"
     find "Save an STL" and it is scored low on purpose, because it matches
     nearly everything on a short query. */
  if (!best && q.length >= 2) {
    let i = 0;
    for (const ch of label) if (ch === q[i]) i++;
    if (i === q.length) bump(200 - label.length);
  }
  return best;
}

/* The palette's whole list, ordered. With no query it is the recents first
   and then everything by group, because an empty palette that shows nothing
   teaches nobody what the app can do. */
export function rankActions(query, { state = {}, recent = [], actions = ACTIONS } = {}) {
  const q = String(query || '').trim();
  const decorate = a => ({ action: a, available: isAvailable(a, state) });

  if (!q) {
    const recents = recent.map(id => BY_ID[id]).filter(Boolean);
    const seen = new Set(recents.map(a => a.id));
    const rest = actions.filter(a => !seen.has(a.id));
    /* Available first — an unavailable action still belongs in the list so
       the shape of it stays learnable, but it does not get the top slots. */
    rest.sort((a, b) => {
      const av = Number(isAvailable(b, state)) - Number(isAvailable(a, state));
      if (av) return av;
      return GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group);
    });
    return [...recents, ...rest].map(decorate);
  }

  /* Being unavailable is a PENALTY, not an ordering. Sorting available-first
     outright means typing "stl" on an empty pedestal lands on "Stand back
     and watch the floor" — the export is the obvious intent and it is not
     even in the running. A penalty large enough to lose a close contest and
     small enough to win an obvious one is the whole of it. */
  const OFF = 300;
  return actions
    .map(a => ({ a, s: scoreAction(q, a) }))
    .filter(x => x.s > 0)
    .map(x => ({ ...x, s: x.s - (isAvailable(x.a, state) ? 0 : OFF) }))
    .sort((x, y) => y.s - x.s || x.a.label.length - y.a.label.length)
    .map(x => decorate(x.a));
}

/* ------------------------------------------------------------------ */
/* keyboard                                                            */
/* ------------------------------------------------------------------ */
/* One place that says which key runs which action, derived from the same
   rows the palette draws. A shortcut that disagrees with the label next to
   it in the palette is worse than no label. */
export function hotkeyMap() {
  const map = {};
  for (const a of ACTIONS) {
    if (!a.hotkey) continue;
    map[a.hotkey] = a.id;
  }
  return map;
}

/* Turn a keydown into an action id, if it is one. Bare letters only fire
   when nothing is being typed into — that check belongs to the caller,
   which is the only thing that knows what has focus. */
export function actionForKey({ key, meta = false, ctrl = false, shift = false }) {
  const k = String(key || '');
  const cmd = meta || ctrl;
  if (cmd && (k === 'z' || k === 'Z')) return shift ? 'bench.redo' : 'bench.undo';
  if (cmd && k === 'Enter') return 'build.run';
  if (cmd && k === ',') return 'engine.settings';
  if (cmd) return null;
  const bare = {
    b: 'bench.toggle', f: 'floor.follow', o: 'bench.look', m: 'bench.measure',
    i: 'bench.isolate', s: 'bench.section',
    1: 'floor.software', 2: 'floor.metal', 3: 'floor.finished', 4: 'floor.cardboard', 5: 'floor.electronics',
    6: 'floor.machining'
  };
  return bare[k.toLowerCase()] || null;
}
