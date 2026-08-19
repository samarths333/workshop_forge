/* The command surface.

   A palette is only worth having if typing three letters lands on the thing
   you meant. That is a ranking problem, and a ranking problem fails quietly:
   the list is never empty, it is just subtly wrong, and the way you find out
   is by watching somebody scroll past the row they wanted.

   So the ranking is asserted against the three things people actually type —
   the start of the label, a word from the middle, the initials — with the
   expected winner named. And the registry itself is checked for the two
   things that make a command surface untrustworthy: an action that is
   available when it cannot possibly work, and a destructive action that does
   not ask.

     node test/palette.test.mjs
*/
import {
  ACTIONS, ACTION_IDS, GROUPS, actionById, AUTHORITY, WHEN,
  isAvailable, scoreAction, rankActions, hotkeyMap, actionForKey
} from '../renderer/actions.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const top = (q, state = {}) => rankActions(q, { state })[0]?.action.id;

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */
check('every action is complete enough to draw and to run', () => {
  assert(ACTIONS.length >= 25, `only ${ACTIONS.length} actions — that is a menu, not a command surface`);
  for (const a of ACTIONS) {
    assert(/^[a-z]+\.[a-z]+$/.test(a.id), `"${a.id}" is not a group.name id`);
    assert(a.label && a.label.length > 2, `${a.id} has no label`);
    assert(a.group, `${a.id} belongs to nothing`);
    assert(WHEN.includes(a.when), `${a.id} is available "${a.when}", which nothing implements`);
    assert(Object.values(AUTHORITY).includes(a.authority), `${a.id} has authority ${a.authority}, which is not a level`);
    assert(Array.isArray(a.keywords), `${a.id} has no keywords — it is findable only by its exact label`);
  }
  assert(new Set(ACTION_IDS).size === ACTION_IDS.length, 'two actions share an id');
  assert(new Set(ACTIONS.map(a => a.label)).size === ACTIONS.length, 'two actions share a label');
  assert(GROUPS.length >= 5, `only ${GROUPS.length} groups`);
});

check('anything that cannot be undone asks first', () => {
  /* The whole value of a confirm is that it is still there on the day you
     press the wrong thing, so it is asserted rather than left to habit. */
  for (const a of ACTIONS) {
    if (a.authority >= AUTHORITY.destroys) {
      assert(a.confirm && a.confirm.length > 20, `${a.id} destroys something and does not explain what`);
    }
    if (a.confirm) assert(a.authority >= AUTHORITY.destroys, `${a.id} asks for confirmation but is only level ${a.authority}`);
  }
  const forget = actionById('skills.forget');
  assert(forget && forget.confirm, 'forgetting the library does not ask');
  assert(/no undo|cannot|there is no/i.test(forget.confirm), forget.confirm);
});

check('an action that spends a key says so', () => {
  /* Authority has to be visible BEFORE enter, not discovered afterwards on
     a bill. */
  for (const id of ['build.run', 'build.again', 'study.now']) {
    assert(actionById(id).authority >= AUTHORITY.spends, `${id} spends a key and is not marked as doing so`);
  }
  assert(actionById('floor.metal').authority === AUTHORITY.free, 'moving the camera is marked as costing something');
  assert(actionById('export.stl').authority === AUTHORITY.writes, 'writing a file is not marked as writing a file');
});

/* ------------------------------------------------------------------ */
/* availability                                                        */
/* ------------------------------------------------------------------ */
check('an action is offered only when it could actually work', () => {
  const idle = { building: false, settled: false, bench: false };
  const mid = { building: true, settled: false, bench: false };
  const done = { building: false, settled: true, bench: false };
  const bench = { building: false, settled: true, bench: true };

  assert(isAvailable(actionById('build.run'), idle), 'cannot build in an idle shop');
  assert(!isAvailable(actionById('build.run'), mid), 'a second build can be started mid-build');
  assert(isAvailable(actionById('build.stop'), mid), 'cannot stop a running build');
  assert(!isAvailable(actionById('build.stop'), idle), 'an idle shop offers to stop');
  assert(!isAvailable(actionById('export.stl'), idle), 'an empty pedestal offers an STL');
  assert(isAvailable(actionById('export.stl'), done), 'a finished build will not export');
  assert(isAvailable(actionById('bench.measure'), bench), 'the bench will not measure');
  assert(!isAvailable(actionById('bench.measure'), done), 'measuring is offered with the bench shut');
  assert(!isAvailable(actionById('floor.follow'), bench), 'the camera is offered while the bench is open');
  assert(isAvailable(actionById('engine.settings'), mid), 'settings vanish mid-build');
});

check('an unavailable action is listed, not hidden', () => {
  /* A palette whose contents change under you is a palette nobody learns:
     the thing you looked for last time is missing this time and you cannot
     tell whether you misremembered it or it does not apply. */
  const rows = rankActions('', { state: { building: true } });
  const stl = rows.find(r => r.action.id === 'export.stl');
  assert(stl, 'an unavailable action was dropped from the list entirely');
  assert(!stl.available, 'it was listed as available with nothing on the pedestal');
  // ...but it does not get the good seats
  const firstUnavailable = rows.findIndex(r => !r.available);
  const lastAvailable = rows.map(r => r.available).lastIndexOf(true);
  assert(firstUnavailable > 0 && firstUnavailable > rows.findIndex(r => r.available),
    'unavailable actions are mixed in above available ones');
  assert(lastAvailable < rows.length, 'ordering is broken');
});

/* ------------------------------------------------------------------ */
/* typing three letters                                                */
/* ------------------------------------------------------------------ */
check('the start of a label wins', () => {
  assert(top('build') === 'build.run', top('build'));
  assert(top('stop') === 'build.stop', top('stop'));
  assert(top('undo') === 'bench.undo', top('undo'));
});

check('a word from the middle finds it', () => {
  assert(top('stl') === 'export.stl', top('stl'));
  assert(top('obj') === 'export.obj', top('obj'));
  assert(top('bench') === 'bench.toggle', top('bench'));
  assert(top('measure') === 'bench.measure', top('measure'));
});

check('the initials find it', () => {
  assert(top('lio') === 'bench.look', `"lio" found ${top('lio')} instead of Look it over`);
});

check('the word somebody would actually reach for finds it', () => {
  /* Nobody types "Engines and keys". They type "api key", or the name of
     the provider they are trying to add, and the keywords are what make
     that land. */
  for (const q of ['api key', 'openai', 'anthropic', 'gemini', 'ollama', 'provider', 'settings']) {
    assert(top(q) === 'engine.settings', `"${q}" found ${top(q)}`);
  }
  assert(top('optimise') === 'bench.look', top('optimise'));
  assert(top('optimize') === 'bench.look', `the American spelling found ${top('optimize')}`);
  assert(top('cad') === 'bench.toggle', top('cad'));
  assert(top('forge') === 'floor.metal', `"forge" found ${top('forge')}`);
  assert(top('vulcan') === 'floor.metal', `a robot's name found ${top('vulcan')}`);
  assert(top('ampere') === 'floor.electronics', `a robot's name found ${top('ampere')}`);
  assert(top('wipe') === 'skills.forget', top('wipe'));
});

check('a near miss still shows something rather than going empty', () => {
  const rows = rankActions('zzzz', { state: {} });
  assert(Array.isArray(rows), 'a nonsense query threw');
  // and a real query never returns nothing useful
  for (const q of ['ex', 'st', 'b', 'sa']) {
    assert(rankActions(q, { state: {} }).length > 0, `"${q}" matched nothing at all`);
  }
});

check('an available action outranks a better-matching unavailable one', () => {
  /* Otherwise the top hit on a fresh shop is an export that cannot run. */
  const rows = rankActions('s', { state: { building: false, settled: false, bench: false } });
  assert(rows[0].available, `the top hit for "s" is unavailable: ${rows[0].action.id}`);
});

check('an empty palette teaches what the app can do', () => {
  const rows = rankActions('', { state: { building: false, settled: true, bench: false } });
  assert(rows.length === ACTIONS.length, `an empty query showed ${rows.length} of ${ACTIONS.length}`);
  assert(rows[0].available, 'the first row of an empty palette cannot be run');
});

check('recents come first, once, and are still only listed once', () => {
  const recent = ['export.stl', 'bench.look'];
  const rows = rankActions('', { state: { settled: true }, recent });
  assert(rows[0].action.id === 'export.stl' && rows[1].action.id === 'bench.look', rows.slice(0, 2).map(r => r.action.id).join());
  const ids = rows.map(r => r.action.id);
  assert(new Set(ids).size === ids.length, 'a recent action is listed twice');
  assert(ids.length === ACTIONS.length, 'recents changed the size of the list');
  // a recent that no longer exists must not blank a row
  const stale = rankActions('', { state: {}, recent: ['gone.away'] });
  assert(stale.every(r => r.action), 'a stale recent produced an empty row');
});

/* ------------------------------------------------------------------ */
/* keyboard                                                            */
/* ------------------------------------------------------------------ */
check('every shortcut in the palette is a shortcut that exists', () => {
  /* A label promising a key that does nothing is worse than no label. */
  const map = hotkeyMap();
  assert(Object.keys(map).length >= 8, `only ${Object.keys(map).length} shortcuts`);
  for (const [key, id] of Object.entries(map)) {
    assert(actionById(id), `${key} points at ${id}, which does not exist`);
  }
  const dupes = Object.values(map).filter((v, i, a) => a.indexOf(v) !== i);
  assert(!dupes.length, `two shortcuts run ${dupes.join()}`);
});

check('a keypress resolves to the action its label promises', () => {
  assert(actionForKey({ key: 'z', meta: true }) === 'bench.undo', 'cmd-z');
  assert(actionForKey({ key: 'z', meta: true, shift: true }) === 'bench.redo', 'shift-cmd-z');
  assert(actionForKey({ key: 'Enter', meta: true }) === 'build.run', 'cmd-enter');
  assert(actionForKey({ key: ',', meta: true }) === 'engine.settings', 'cmd-comma');
  assert(actionForKey({ key: 'b' }) === 'bench.toggle', 'b');
  assert(actionForKey({ key: 'B' }) === 'bench.toggle', 'shifted b');
  assert(actionForKey({ key: '3' }) === 'floor.finished', '3');
  assert(actionForKey({ key: 'q' }) === null, 'an unbound key resolved to something');
  assert(actionForKey({ key: 'b', meta: true }) === null, 'cmd-b hit the bare-b binding');

  // and the labels agree with the bindings
  for (const [key, id] of [['B', 'bench.toggle'], ['O', 'bench.look'], ['3', 'floor.finished']]) {
    assert(actionById(id).hotkey === key, `${id} is bound to ${key} but its label says ${actionById(id).hotkey}`);
  }
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
