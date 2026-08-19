/* The renderer cannot be imported under node — it wants three.js and a DOM
   — so nothing here executes it. What it does instead is read the source
   and check the joins: that every named import is actually exported by the
   file it comes from, that every element app.js reaches for exists in the
   markup, that every method called on world/rivet is defined, and that the
   preload bridge matches the IPC handlers on the other side.

   These are exactly the mistakes that survive a syntax check and then
   throw on the first frame.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headNoun } from '../renderer/skills.js';
import { headTerm } from '../renderer/library.js';
import { headWord } from '../renderer/catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const files = readdirSync(join(root, 'renderer')).filter(f => f.endsWith('.js'));
const src = Object.fromEntries(files.map(f => [f, rd(`renderer/${f}`)]));

/* Comments talk ABOUT the code, which means they are full of things that
   look exactly like member accesses and module names. Anything scanning for
   real calls has to see the code without them, or a sentence mentioning
   crew.js becomes a call to `crew.js`. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // `export const A = 1, B = 2` exports both, so take the whole declaration
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const part of m[1].split(/,(?![^[(]*[\])])/)) {
      const n = part.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

/* ------------------------------------------------------------------ */
check('every named import exists in the module it comes from', () => {
  const missing = [];
  for (const [file, text] of Object.entries(src)) {
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
      const from = m[2];
      assert(src[from], `${file} imports from ${from}, which does not exist`);
      const have = exportsOf(src[from]);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !have.has(name)) missing.push(`${file}: "${name}" is not exported by ${from}`);
      }
    }
  }
  assert(!missing.length, missing.join('\n          '));
});

check('no module imports itself into a cycle it cannot resolve', () => {
  // agent → assembly, critic → agent + assembly, world → assembly.
  // assembly must stay at the bottom, importing nothing local.
  const local = [...src['assembly.js'].matchAll(/from\s*['"]\.\/([^'"]+)['"]/g)].map(m => m[1]);
  assert(!local.length, `assembly.js has grown local imports (${local.join(', ')}) — it must stay dependency-free so it can be tested headlessly`);
});

check('the modules the tests depend on have not grown a dependency', () => {
  // these four are the whole reason the suite runs in a millisecond with no
  // window: they must not reach for three.js, the DOM or each other
  for (const f of ['assembly.js', 'skills.js', 'history.js', 'export3d.js', 'library.js']) {
    assert(src[f], `${f} is gone`);
    /* Scanned as CODE, not as text. These files explain themselves at
       length and the explanations are full of the word "import" — a
       comment saying a file imports nothing used to fail the check that
       it imports nothing. */
    const imports = [...code(src[f]).matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
    assert(!imports.length, `${f} now imports: ${imports.join(' / ')} — it has to stay headless`);
    assert(!/\bdocument\.|\bwindow\.|THREE\./.test(code(src[f])), `${f} reaches for the DOM or three.js`);
  }
});

/* A shape is data now, and the whole design rests on shapelib.js staying
   arithmetic: it is the file that decides what a shape IS, it reads a
   user-editable file off disk, and it hands its vocabulary to the model.
   The moment it can see three.js it can also be right about a shape the
   floor draws differently, which is the one failure the normalisation
   exists to make impossible. */
/* skills.js and library.js each work out what a request is ABOUT, and
   neither can import the other — both are import-free by design. So the
   rule is written twice, and this is what stops the two copies drifting:
   a recall that thinks the request is about a car and a reference lookup
   that thinks it is about an engine would disagree silently, and the
   symptom would be a good recipe alongside irrelevant references. */
check('the three head-noun rules agree with each other', () => {
  for (const phrase of ['a car with an engine', 'a stand for a lamp', 'a desk lamp',
    'a bookshelf', 'a rover to carry a bookshelf across a room', 'a turbofan engine']) {
    assert(headNoun(phrase) === headTerm(phrase),
      `"${phrase}": skills says ${headNoun(phrase)}, library says ${headTerm(phrase)}`);
    assert(headNoun(phrase) === headWord(phrase),
      `"${phrase}": skills says ${headNoun(phrase)}, catalog says ${headWord(phrase)}`);
  }
});

/* The catalogue is what the shop knows things are MADE OF, it is read by
   the offline planner and by the prompt, and it has to stay arithmetic for
   the same reason engine.js does: every archetype in it is checked by
   BUILDING it in node, and that only works while it cannot see a mesh. */
check('the parts catalogue stays data, and stays headless', () => {
  const imports = [...code(src['catalog.js']).matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `catalog.js now imports: ${imports.join(' / ')}`);
  assert(!/document\.|window\.|THREE\.|fetch\(/.test(code(src['catalog.js'])),
    'catalog.js reaches for the DOM, three.js or the network');

  /* A part that turns says so with a tag, and the tag has to survive the
     validator or a car comes out with its wheels welded solid. */
  assert(/moves/.test(src['agent.js']), 'validatePlan drops the tag that says a part turns');
  assert(/catalogMotion/.test(src['app.js']), 'nothing outside the engine ever moves');
  assert(/catalogBlock/.test(src['agent.js']) && /catalogBlock/.test(src['workorder.js']),
    'the model is never told what the thing it is building is made of');
});

check('the shape vocabulary stays data, and stays headless', () => {
  const imports = [...code(src['shapelib.js']).matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `shapelib.js now imports: ${imports.join(' / ')}`);
  assert(!/document\.|window\.|THREE\.|fetch\(/.test(code(src['shapelib.js'])),
    'shapelib.js reaches for the DOM, three.js or the network');

  /* One list of primitives, in two files that cannot import each other —
     assembly.js imports nothing at all, so the duplication is deliberate
     and this is what keeps it honest. shapelib.test.mjs checks the values
     match; this checks nobody has quietly deleted that check's premise. */
  const solver = src['assembly.js'].match(/export const SHAPES = \[([^\]]+)\]/)[1];
  const lib = src['shapelib.js'].match(/export const PRIMITIVE_SHAPES = \[([^\]]+)\]/)[1];
  const norm = t => t.split(',').map(x => x.trim().replace(/'/g, '')).join(',');
  assert(norm(solver) === norm(lib),
    `the solver knows ${norm(solver)} and shapelib knows ${norm(lib)}`);

  /* The vocabulary reaching the model is the LIVE one. If the schema went
     back to the solver's nine, every shape somebody made would be filtered
     out of the enum and quietly become a box — with the picker still
     offering it. */
  assert(/enum: SHAPE_ENUM/.test(src['agent.js']), 'the plan schema is not on the live shape list');
  assert(/enum: SHAPE_ENUM/.test(src['crewplan.js']), 'a specialist cannot use a shape you made');
  assert(/enum: SHAPE_ENUM/.test(src['workorder.js']), 'the work order cannot use a shape you made');

  /* And only ONE thing turns a definition into geometry. A preview drawn
     by its own code can be right about a shape the floor gets wrong. */
  const previews = (code(src['cad.js']).match(/new THREE\.LatheGeometry|new THREE\.ExtrudeGeometry/g) || []);
  assert(!previews.length, `cad.js builds its own profile geometry (${previews.join(', ')}) instead of going through shapes.js`);
});

check('the engine stays arithmetic, and stays headless', () => {
  /* engine.js is where every number about a powerplant comes from, and it
     must not learn about three.js or the DOM — the sizing, the fault rules
     and the kinematics are all checked in node against engines that exist.
     The moment it can see a mesh, the numbers stop being checkable. */
  const imports = [...code(src['engine.js']).matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `engine.js now imports: ${imports.join(' / ')}`);
  assert(!/document\.|window\.|THREE\.|fetch\(/.test(src['engine.js']), 'engine.js reaches for the DOM, three.js or the network');

  // and the mechanical solver has not learned what a crankshaft is
  assert(!/engine_role|sizeICE|firingOrder/.test(src['assembly.js']),
    'assembly.js has grown an opinion about engines — the two stay separate');

  /* The one thing engine.js knows about the shop is the shape of a part
     spec, and the one thing the shop knows about engines is the tag. If
     the tag is not in the schema, a specialist cannot say which bit of the
     engine it made and every part is sized as if it were nothing. */
  assert(/engine_role/.test(src['agent.js']), 'the plan schema has no engine_role');
  assert(/engine_role/.test(src['crewplan.js']), 'a specialist cannot say which bit of the engine it made');
});

check('the sixth bay exists everywhere a bay has to exist', () => {
  /* A station is only real if the floor plan, the plan schema, the clips
     and the world all agree it is. Miss one and the failure is silent:
     the robot walks to a bay that is not drawn, or the planner picks an
     action for a room the schema will not accept. */
  assert(/machining/.test(src['roles.js']), 'roles.js has no machining station');
  assert(/machining/.test(src['agent.js']), 'ROOM_KEYS has no machining — the schema would reject every step there');
  assert(/machining/.test(src['world.js']), 'world.js does not draw the machine shop');
  assert(/room: 'machining'/.test(src['animations.js']), 'nothing to play at the machine shop');
  assert(/'alloy'/.test(src['assembly.js']), 'the solver does not know what alloy is');
  assert(/alloy/.test(src['metrics.js']), 'alloy has no density, so an engine weighs nothing');
  assert(/'alloy'/.test(src['shapes.js']), 'alloy has no material, so an engine is drawn as cardboard');
});

check('the electrical side stays a graph, and stays headless', () => {
  /* circuit.js is the only place in the app that models something other
     than a tree, and it must not learn about three.js or the DOM — the
     whole netlist and every electrical rule is checked in node. */
  const imports = [...src['circuit.js'].matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `circuit.js now imports: ${imports.join(' / ')}`);
  assert(!/document\.|window\.|THREE\./.test(src['circuit.js']), 'circuit.js reaches for the DOM or three.js');

  // the mechanical solver must not have learned about electricity either
  assert(!/netlist|analyseCircuit|wires/.test(src['assembly.js']),
    'assembly.js has grown an opinion about circuits — the two solvers stay separate');
});

check('a wire is clamped as hard as an attachment', () => {
  const a = src['agent.js'];
  assert(/validateWires\(/.test(a), 'validatePlan no longer clamps the wiring');
  const at = a.indexOf('const wires = validateWires');
  assert(at > a.indexOf('export function validatePlan'), 'wires are validated outside validatePlan');
  // and a component must take its body from the catalogue, not the model
  assert(/bodyFor\(/.test(a), 'a component can still arrive with whatever shape the model felt like');
});

check('the electronics room exists everywhere it has to', () => {
  const w = src['world.js'], a = src['agent.js'], an = src['animations.js'];
  assert(/electronics:/.test(w), 'no electronics room in world.js');
  assert(/ROOM_ORDER = \[[^\]]*electronics/.test(w), 'the room is not in ROOM_ORDER');
  assert(/ROOM_KEYS = \[[^\]]*electronics/.test(a), 'the planner cannot name the room');
  assert(/buildElectronics\(\)/.test(w), 'the room is declared but never built');
  assert(/room: 'electronics'/.test(an), 'there are no clips for the room');
  // every clip claiming the room must be reachable from the planner's menu
  const clips = [...an.matchAll(/A\('([a-z_]+)',[^)]*?room: 'electronics'/gs)].length;
  assert(clips >= 4, `only ${clips} electronics clips`);
});

check('the engineer keeps his hands off three.js', () => {
  /* optimize.js and apprentice.js are the two new places judgement lives,
     and both have to stay runnable in node — a hundred study cycles and
     every optimiser rule are checked headlessly, which is only possible
     while neither of them can reach a canvas. */
  const opt = [...src['optimize.js'].matchAll(/from\s*['"]\.\/([^'"]+)['"]/g)].map(m => m[1]);
  // roles.js is on the list because it owns the floor plan, and the walk
  // pricing has to read the same station positions the shop is built from
  const allowed = ['assembly.js', 'metrics.js', 'agent.js', 'circuit.js', 'engine.js', 'roles.js'];
  assert(opt.every(i => allowed.includes(i)), `optimize.js imports ${opt.join(', ')}`);
  assert(!/from\s*['"]three['"]|document\.|window\./.test(src['optimize.js']), 'optimize.js has grown a renderer dependency');

  const app = [...src['apprentice.js'].matchAll(/from\s*['"]/g)];
  assert(!app.length, 'apprentice.js imports something — the study policy must stay pure');
  assert(!/document\.|window\./.test(src['apprentice.js']), 'apprentice.js touches the DOM');
});

check('every optimiser patch goes through the normal edit path', () => {
  /* An optimisation that mutates a plan directly would skip the clamping
     validatePlan does and would not land on the undo stack — you could not
     take back something Rivet decided. */
  const o = src['optimize.js'];
  assert(/editPart|removePart/.test(o), 'optimize.js no longer uses the agent edit functions');
  assert(!/plan\.steps\[[^\]]+\]\.part\s*=/.test(o), 'optimize.js writes a part directly instead of going through editPart');
  const app = src['app.js'];
  const at = app.indexOf('function applyOneFinding');
  assert(at > 0, 'the bench cannot apply a finding');
  const body = app.slice(at, at + 500);
  assert(/snapshot\(/.test(body), 'applying an optimisation does not land on the undo stack');
  assert(/reSolve\(/.test(body), 'applying an optimisation does not re-solve');
});

check('study time ends the moment the person does anything', () => {
  const app = src['app.js'];
  assert(/addEventListener\(ev, interrupt/.test(app), 'nothing interrupts a study build');
  const at = app.indexOf('function interrupt');
  const body = app.slice(at, at + 400);
  assert(/stopJob\(/.test(body), 'interrupting does not actually stop the build');
});

check('the bench arithmetic stays testable', () => {
  // metrics.js is allowed exactly one dependency: the solver's own idea of
  // how big a part is. Anything else and a mass can no longer be checked
  // in node against the thing that was actually drawn.
  const imports = [...src['metrics.js'].matchAll(/from\s*['"]\.\/([^'"]+)['"]/g)].map(m => m[1]);
  assert(imports.every(i => i === 'assembly.js'),
    `metrics.js imports ${imports.join(', ')} — only assembly.js is allowed`);
});

check('the shop looks things up in main, and decides where to look in the renderer', () => {
  // routing is pure and tested; fetching is not and lives on the other side
  const lib = src['library.js'];
  assert(/export function sourcesFor/.test(lib), 'the router is gone');
  const main = rd('main.js');
  for (const s of ['wikipedia', 'commons', 'ntrs', 'openverse', 'web']) {
    assert(new RegExp(`${s}:\\s*\\(`, 'i').test(main) || new RegExp(`search${s}`, 'i').test(main),
      `library.js can route to "${s}" but main.js cannot fetch it`);
  }
  // and every source the renderer names must be one main can actually run
  const named = [...lib.matchAll(/^\s{2}([a-z]+):\s*\{ label:/gm)].map(m => m[1]);
  assert(named.length >= 5, `only ${named.length} sources declared`);
  for (const s of named) {
    assert(new RegExp(`${s}:\\s*\\(`).test(main), `"${s}" is declared in library.js but has no fetcher in main.js`);
  }
});

check('the shop can read a page, and only the main side fetches one', () => {
  const main = rd('main.js');
  assert(/ipcMain\.handle\('refs:read'/.test(main), 'nothing can open a page');
  assert(/searchWeb/.test(main) && /web:\s*\(/.test(main), 'the web source has no fetcher');
  // and the renderer must not have grown its own fetch
  const lib = src['library.js'];
  assert(!/fetch\(/.test(lib), 'library.js is fetching pages itself — main owns the network');
  assert(/export function minePages/.test(lib), 'the mining is gone');
  // the bridge has to expose it
  assert(/read:/.test(rd('preload.js')), 'refs:read is not on the bridge');
});

check('a page fetch can never stall a build', () => {
  const main = rd('main.js');
  const at = main.indexOf("ipcMain.handle('refs:read'");
  const body = main.slice(at, at + 600);
  assert(/allSettled/.test(body), 'pages are read sequentially — one slow site would hold up the shop');
  assert(/slice\(0, *[1-9]\)/.test(body), 'there is no cap on how many pages get opened');
});

check('every lookup actually carries the search term', () => {
  /* The failure this exists to catch: Thingiverse takes its term in the
     PATH and ignores an unknown `q=` parameter. The result is 200 OK and
     a page of the most popular models on the site — real, well-liked, and
     the same ones for every request. Nothing throws, nothing logs, and the
     planner is quietly told that a desk lamp is a tugboat. */
  const main = rd('main.js');
  const at = main.indexOf('async function searchThingiverse');
  const url = main.slice(at, at + 1200);
  assert(/api\.thingiverse\.com\/search\/\$\{encodeURIComponent\(term\)\}/.test(url),
    'the Thingiverse term is not in the path — it will be ignored and you get the site charts back');
  assert(!/search\/\?q=/.test(url), 'the ignored q= parameter is back');

  // and every other fetcher has to put the term somewhere in its request
  for (const fn of ['searchPrintables', 'searchWikipedia', 'searchCommons', 'searchNTRS', 'searchOpenverse', 'searchWeb']) {
    const body = main.slice(main.indexOf(`async function ${fn}`), main.indexOf(`async function ${fn}`) + 900);
    assert(/encodeURIComponent\(term\)|query: term|\bterm\b/.test(body), `${fn} never uses the term it was given`);
  }
});

check('nothing reaches the prompt without being checked against the request', () => {
  const app = src['app.js'];
  assert(/rankRefs\(/.test(app), 'app.js no longer filters references for relevance');
  const at = app.indexOf('rankRefs(');
  const near = app.slice(at - 200, at + 200);
  assert(/enrichRefs|refs =/.test(near), 'rankRefs is not on the path the refs actually take');
});

check('nothing runs a CAD script without the gate seeing it first', () => {
  /* The single most important seam in the CAD feature. The gate is what
     stands between a generated script and a Python interpreter, and the
     only way to keep that true is for the run path to go through it. */
  const b = src['cadbuild.js'];
  assert(b, 'cadbuild.js is gone');
  assert(/gateScript\(/.test(b), 'the repair loop no longer gates the script');
  const gateAt = b.indexOf('gateScript(');
  const runAt = b.indexOf('await run(');
  assert(gateAt > 0 && runAt > gateAt,
    'the kernel is invoked before the gate — a refused script would already have run');

  // and the gate itself must stay pure, or it cannot be tested
  const imports = [...src['cadscript.js'].matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `cadscript.js now imports: ${imports.join(' / ')} — the gate has to stay headless`);
  assert(!/document\.|window\.|THREE\./.test(src['cadscript.js']), 'the gate reaches for the DOM');
});

check('the renderer never executes anything itself', () => {
  /* Main owns execution for the same reason it owns every fetch: the
     renderer is the side that talks to a model, and the side that talks
     to a model does not get a subprocess. */
  for (const f of ['cadbuild.js', 'cadscript.js', 'forge.js', 'app.js']) {
    assert(!/child_process|spawn\(|execFile|\brequire\(/.test(src[f] || ''),
      `${f} is reaching for a subprocess — that belongs in main.js`);
  }
  const main = rd('main.js');
  assert(/ipcMain\.handle\('cad:run'/.test(main), 'nothing can run a CAD script');
  assert(/ipcMain\.handle\('cad:probe'/.test(main), 'nothing can tell whether the kernel is installed');
  assert(/cadRun:/.test(rd('preload.js')), 'the kernel is not on the bridge');
});

check('the kernel is a second fence, not the only one', () => {
  const k = rd('cad/kernel.py');
  assert(/guarded_import/.test(k), 'the kernel hands out the real __import__');
  assert(/ALLOWED_IMPORTS/.test(k), 'there is no import allowlist in the kernel');
  assert(/SAFE_BUILTINS/.test(k), 'the script runs with the real builtins');
  assert(!/"open"|'open'/.test(k.split('SAFE_BUILTINS')[1].split('}')[0]),
    'open() is in the safe builtins');
  // and it re-checks the text, because the day the gate has a hole is the
  // day this is the thing that stops it
  assert(/stage": "refused"|"refused"/.test(k) || /refused/.test(k),
    'the kernel does not re-check what it was handed');
  // the script must never be the thing that writes a file
  assert(/def export\(/.test(k), 'the kernel does not own the exporting');
});

check('a CAD build is optional, and its absence is not an error', () => {
  /* The whole app is built on always producing something. build123d is a
     200MB native dependency and cannot be a hard requirement. */
  const c = src['cadscript.js'];
  assert(/available = true/.test(c), 'wantsKernel assumes the kernel exists');
  assert(/not installed/.test(c), 'there is no answer for a machine without it');
  const f = src['forge.js'];
  assert(/handing it back to the shop floor|shop floor/.test(f),
    'a failed CAD build does not fall back to the primitive path');
});

check('the headless mode reuses the shop rather than reimplementing it', () => {
  /* The whole value of --forge is that Bob gets what Rivet would have
     built. The moment forge.js grows its own solver or its own planner
     that stops being true, and the two would drift apart silently. */
  const f = src['forge.js'];
  assert(f, 'forge.js is gone');
  for (const need of ['./agent.js', './critic.js', './optimize.js', './export3d.js', './shapes.js', './shopfloor.js']) {
    assert(new RegExp(`from '${need.replace('.', '\\.')}'`).test(f),
      `forge.js does not use ${need} — it is reimplementing part of the shop`);
  }
  assert(!/function solveAssembly|function validatePlan|function mergeSubplans/.test(f), 'forge.js has its own copy of the pipeline');

  const main = rd('main.js');
  assert(/--forge/.test(main) && /function runForge/.test(main), 'main.js cannot be driven headlessly');
  assert(/forge:done/.test(main) && /forge:job/.test(main), 'the headless bridge is incomplete');
  /* And it must never hang: something else is waiting on this process.
     Scanned across the whole function rather than a fixed window — a
     magic character count fails the day anything is inserted above it,
     which says nothing about whether the timeout is still there. */
  const at = main.indexOf('function runForge');
  const end = main.indexOf('app.whenReady', at);
  const body = main.slice(at, end > at ? end : main.length);
  assert(/setTimeout\(\(\) => finish/.test(body), 'a headless build can hang forever');
});

check('the renderer never writes a file itself', () => {
  // the same rule as the network: the renderer asks main to do a named
  // thing. A save dialog or an fs call on this side means the sandbox
  // boundary has been quietly stepped over.
  for (const [file, text] of Object.entries(src)) {
    assert(!/require\(['"]fs['"]\)|showSaveDialog|writeFileSync/.test(text),
      `${file} is touching the filesystem directly`);
  }
  assert(/ipcMain\.handle\('model:save'/.test(rd('main.js')), 'nothing in main handles the model export');
  assert(/saveModel/.test(rd('preload.js')), 'the export bridge is missing from preload');
});

check('every command the bench can send is one app.js answers', () => {
  const html = rd('renderer/index.html');
  const cmds = [...html.matchAll(/data-cmd="([a-z]+)"/g)].map(m => m[1]);
  assert(cmds.length >= 4, `only ${cmds.length} bench commands in the markup`);
  // 'fit' is handled by the toolbar listener, the rest go to cad.onCommand
  const handler = src['app.js'].slice(src['app.js'].indexOf('cad.onCommand = '));
  const body = handler.slice(0, handler.indexOf('\n};'));
  for (const c of new Set(cmds)) {
    if (c === 'fit') continue;
    assert(body.includes(`'${c}'`), `the bench has a "${c}" button that cad.onCommand ignores`);
  }
});

check('every element app.js looks up exists in index.html', () => {
  const html = rd('renderer/index.html');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const missing = [];
  for (const m of src['app.js'].matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)) {
    if (!ids.has(m[1])) missing.push(m[1]);
  }
  assert(!missing.length, `app.js reaches for #${[...new Set(missing)].join(', #')} — not in the markup`);
});

check('the bench finds the markup it queries for', () => {
  const html = rd('renderer/index.html');
  const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
  const missing = [];
  for (const m of src['cad.js'].matchAll(/querySelector(?:All)?\('\.([A-Za-z0-9_-]+)'/g)) {
    if (!classes.has(m[1])) missing.push('.' + m[1]);
  }
  // and the attributes it toggles buttons by
  for (const attr of ['data-proj', 'data-view']) {
    assert(src['cad.js'].includes(attr) ? html.includes(attr) : true,
      `cad.js drives [${attr}] buttons that are not in the markup`);
  }
  assert(!missing.length, `cad.js queries for ${[...new Set(missing)].join(', ')} — not in the markup`);
});

check('every cad.* member app.js uses is defined on CadView', () => {
  const text = src['cad.js'];
  const has = new Set();
  for (const m of text.matchAll(/^\s{2}([A-Za-z0-9_$]+)\s*\(/gm)) has.add(m[1]);
  for (const m of text.matchAll(/this\.([A-Za-z0-9_$]+)\s*=/g)) has.add(m[1]);
  const app = src['app.js'].replace(/from\s*'[^']*'/g, '');
  const missing = [];
  for (const m of app.matchAll(/\bcad\.([A-Za-z0-9_$]+)/g)) {
    if (!has.has(m[1])) missing.push('cad.' + m[1]);
  }
  assert(!missing.length, `undefined: ${[...new Set(missing)].join(', ')}`);
});

check('bench edits go through the validator, not straight into the plan', () => {
  const app = src['app.js'];
  assert(/editPart\(/.test(app), 'app.js does not use editPart');
  // the panel must not write to part specs itself — clamping lives in agent.js
  assert(!/\.part\.(size|shape|material|attach)\s*=/.test(app),
    'app.js assigns to a part spec directly, bypassing the clamping in agent.editPart');
});

check('every world.* and rivet.* member app.js uses is defined', () => {
  const methodsOf = text => {
    const s = new Set();
    for (const m of text.matchAll(/^\s{2}([A-Za-z0-9_$]+)\s*\(/gm)) s.add(m[1]);
    for (const m of text.matchAll(/this\.([A-Za-z0-9_$]+)\s*=/g)) s.add(m[1]);
    for (const m of text.matchAll(/^\s{2}get\s+([A-Za-z0-9_$]+)/gm)) s.add(m[1]);
    return s;
  };
  const worldHas = methodsOf(src['world.js']);
  const rivetHas = methodsOf(src['character.js']);
  const missing = [];
  const app = code(src['app.js']).replace(/from\s*'[^']*'/g, '');   // not the import paths, not the prose
  for (const m of app.matchAll(/\bworld\.([A-Za-z0-9_$]+)/g)) {
    if (!worldHas.has(m[1])) missing.push(`world.${m[1]}`);
  }
  for (const m of app.matchAll(/\brivet\.([A-Za-z0-9_$]+)/g)) {
    if (!rivetHas.has(m[1])) missing.push(`rivet.${m[1]}`);
  }
  assert(!missing.length, `undefined: ${[...new Set(missing)].join(', ')}`);
});

check('every crew.* member app.js uses is defined on Crew', () => {
  /* Same job as the world/rivet check, for the layer that replaced the old
     single-robot executor. app.js drives the floor entirely through this
     object, so a typo here is a build that walks nowhere. */
  const text = src['crew.js'];
  const has = new Set();
  for (const m of text.matchAll(/^\s{2}([A-Za-z0-9_$]+)\s*\(/gm)) has.add(m[1]);
  for (const m of text.matchAll(/this\.([A-Za-z0-9_$]+)\s*=/g)) has.add(m[1]);
  for (const m of text.matchAll(/^\s{2}get\s+([A-Za-z0-9_$]+)/gm)) has.add(m[1]);
  const app = code(src['app.js']).replace(/from\s*'[^']*'/g, '');
  const missing = [];
  for (const m of app.matchAll(/\bcrew\.([A-Za-z0-9_$]+)/g)) {
    if (!has.has(m[1])) missing.push('crew.' + m[1]);
  }
  assert(!missing.length, `undefined: ${[...new Set(missing)].join(', ')}`);
});

check('there is exactly one floor plan, and everybody reads it', () => {
  /* The optimiser prices a plan by how far the work walks. It cannot import
     world.js (three.js), so it used to keep its own copy of where the rooms
     were — and that copy went stale the moment the walls came down, pricing
     every plan against a shop that no longer existed. Nothing threw. */
  const opt = src['optimize.js'], world = src['world.js'], roles = src['roles.js'];
  assert(/export const STATION_X/.test(roles), 'roles.js no longer owns the floor plan');
  assert(!/const ROOM_X = \{/.test(opt), 'optimize.js has its own copy of the station positions again');
  assert(/walkBetween/.test(opt), 'the optimiser is not pricing walks off the shared plan');
  assert(/STATION_X\.finished/.test(world), 'world.js is not built from the shared plan');
  for (const k of ['software', 'metal', 'finished', 'cardboard', 'electronics']) {
    assert(new RegExp(`${k}:`).test(roles.slice(roles.indexOf('export const STATION_X'), roles.indexOf('export const STATION_X') + 400)),
      `the floor plan has no ${k} station`);
  }
});

check('the floor is a real crew, not one robot with five hats', () => {
  const roles = src['roles.js'];
  const ids = [...roles.matchAll(/^\s{4}id: '([a-z]+)'/gm)].map(m => m[1]);
  assert(ids.length >= 4, `only ${ids.length} specialists on the floor`);
  for (const need of ['structures', 'softgoods', 'electrical', 'controls']) {
    assert(ids.includes(need), `there is no ${need} specialist`);
  }
  assert(/export const FOREMAN/.test(roles) && /export const JARVIS/.test(roles),
    'the chain of command is missing a link');
  // and the register must stay headless, like the solver
  const imports = [...roles.matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
  assert(!imports.length, `roles.js now imports: ${imports.join(' / ')}`);
  assert(!/document\.|window\.|THREE\./.test(roles), 'roles.js reaches for the DOM or three.js');

  // the crew builds one robot per role, and they are told apart on sight
  const crew = src['crew.js'];
  assert(/new Rivet\(/.test(crew) && /CREW\.forEach/.test(crew), 'crew.js does not build a robot per role');
  assert(/accent: role\.accent/.test(crew) && /tint: role\.tint/.test(crew),
    'every robot on the floor would look identical');
});

check('nothing that decides a build can reach the network or a canvas', () => {
  /* The whole planning layer — who does what, what the interfaces are, how
     four answers merge into one object — has to be checkable in node. The
     moment one of these grows three.js or a fetch, the merge arithmetic can
     only be tested by looking at a window. */
  for (const f of ['roles.js', 'workorder.js', 'crewplan.js', 'shopfloor.js']) {
    assert(src[f], `${f} is gone`);
    assert(!/from\s*['"]three['"]|\bdocument\.[A-Za-z_$]|\bwindow\.[A-Za-z_$]|\bfetch\s*\(/.test(code(src[f])),
      `${f} has grown a renderer or network dependency`);
  }
  // shopfloor takes its model as an argument, which is what makes the whole
  // pipeline drivable from a test with a scripted one
  assert(/constructor\(\{ ask/.test(src['shopfloor.js']),
    'shopfloor.js no longer takes the model as a dependency — the pipeline is untestable');
});

check('every step that reaches the floor has an owner', () => {
  /* A step nobody owns is a step no robot is scheduled to walk to, and the
     build stops halfway with five robots standing still and no error. */
  const agent = src['agent.js'];
  assert(/ROLE_IDS\.includes\(by\)/.test(agent), 'validatePlan no longer clamps the step owner');
  const app = src['app.js'];
  assert(/attributePlan\(/.test(app), 'app.js does not fill in owners for a plan the crew did not write');
  const crew = src['crew.js'];
  assert(/this\.byRole\.has\(step\.by\)/.test(crew), 'the crew does not dispatch on the step owner');
  assert(/FOREMAN\.id/.test(crew), 'an unowned step has nobody to fall through to');
});

check('the merge cannot bolt one trade’s part onto another trade’s numbering', () => {
  /* The single highest-consequence line in the new pipeline: a specialist
     numbers its parts from zero, and the merge has to shift them by where
     its block starts. Getting it wrong reparents half the object silently. */
  const cp = src['crewplan.js'];
  assert(/offset \+ p\.attach\.to/.test(cp), 'a local attachment is no longer shifted by its block offset');
  assert(/shiftPin/.test(cp), 'wire pins are no longer shifted with the parts');
  const merge = cp.slice(cp.indexOf('export function mergeSubplans'));
  assert(/order\.frame\.forEach/.test(merge.slice(0, 3000)), 'the frame is no longer laid down first');
});

check('every action in the palette has something behind it', () => {
  /* A row in the command palette with no handler is a button that does
     nothing, which is worse than no button: the person concludes the app is
     broken rather than that the feature is missing. */
  const acts = src['actions.js'];
  const ids = [...acts.matchAll(/\{ id: '([a-z.]+)'/g)].map(m => m[1]);
  assert(ids.length >= 25, `only ${ids.length} actions`);
  const app = src['app.js'];
  const at = app.indexOf('const HANDLERS = {');
  assert(at > 0, 'app.js has no handler table');
  const table = app.slice(at, app.indexOf('\n};', at));
  const missing = ids.filter(id => !table.includes(`'${id}'`));
  assert(!missing.length, `no handler for: ${missing.join(', ')}`);
  // and nothing bound that does not exist
  const bound = [...table.matchAll(/^\s{2}'([a-z.]+)':/gm)].map(m => m[1]);
  const orphan = bound.filter(id => !ids.includes(id));
  assert(!orphan.length, `app.js handles ${orphan.join(', ')}, which is not in the registry`);
});

check('the command surface stays headless and the palette owns the DOM', () => {
  const acts = src['actions.js'];
  assert(!/document\.[A-Za-z_$]|\bwindow\.[A-Za-z_$]|from\s*['"]three['"]/.test(code(acts)),
    'actions.js reaches for the DOM — the registry has to stay checkable in node');
  assert(!/\bfetch\s*\(/.test(acts), 'actions.js is making a network call');
  const pal = src['palette.js'];
  assert(/⌘K|metaKey/.test(pal), 'the palette has no hotkey');
  assert(/rankActions/.test(pal), 'the palette does not use the shared ranking');
});

check('the palette finds the markup it queries for', () => {
  const html = rd('renderer/index.html');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
  for (const m of src['palette.js'].matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) {
    assert(ids.has(m[1]), `palette.js reaches for #${m[1]}, which is not in the markup`);
  }
  for (const m of src['palette.js'].matchAll(/querySelector\('\.([A-Za-z0-9_-]+)'\)/g)) {
    assert(classes.has(m[1]), `palette.js reaches for .${m[1]}, which is not in the markup`);
  }
});

check('the shop is not welded to one company’s API', () => {
  /* The whole point of the provider table: adding an engine is adding a row,
     and main.js reads the row rather than knowing about anybody by name. */
  const prov = src['providers.js'];
  const ids = [...prov.matchAll(/^\s{4}id: '([a-z]+)'/gm)].map(m => m[1]);
  assert(ids.length >= 6, `only ${ids.length} providers`);
  for (const need of ['anthropic', 'openai', 'gemini', 'ollama']) {
    assert(ids.includes(need), `no ${need} provider`);
  }
  assert(ids.includes('compatible'), 'there is no generic OpenAI-compatible escape hatch');
  assert(!/from\s*['"]three['"]|\bdocument\.[A-Za-z_$]|\bfetch\s*\(/.test(code(prov)),
    'providers.js fetches or touches the renderer — main owns the network');

  const main = rd('main.js');
  assert(/callProvider/.test(main), 'main.js has no generic transport');
  assert(!/function callNIM|function callOllama/.test(main), 'main.js still has a function per engine');
  assert(/providers\.js/.test(main), 'main.js does not read the provider table');
  assert(/ipcMain\.handle\('llm:models'/.test(main), 'there is no way to ask a provider what it can reach');
  // the routing has to be by role, or the tiers do nothing
  assert(/routeFor\(role, cfg\)/.test(main), 'main.js does not route a call by who is asking');
  assert(/role/.test(rd('preload.js').slice(rd('preload.js').indexOf("plan:"), rd('preload.js').indexOf("plan:") + 200)),
    'the bridge does not carry who is asking, so every call lands on the same tier');
});

check('the local engine is told how long an answer may be', () => {
  /* Ollama caps generation at 128 tokens by default. Every reply this app
     asks for is longer, so without num_predict the JSON arrives truncated,
     the parse throws, and the build silently falls back to keywords — on
     the one engine that needs no key. */
  assert(/num_predict/.test(src['providers.js']),
    'num_predict is gone — every local build will come back truncated and nothing will say so');
});

check('the preload bridge lines up with the handlers in main', () => {
  const pre = rd('preload.js'), main = rd('main.js');
  const invoked = [...pre.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]);
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
  const orphan = invoked.filter(c => !handled.has(c));
  assert(!orphan.length, `preload invokes ${orphan.join(', ')} with nothing listening`);
  const used = rd('renderer/app.js');
  for (const m of used.matchAll(/window\.forge\.(?:skills\.)?([A-Za-z0-9_$]+)\s*\(/g)) {
    assert(new RegExp(`\\b${m[1]}\\s*:`).test(pre), `app.js calls window.forge…${m[1]}(), which preload does not expose`);
  }
});

check('the settings panel and the defaults in main agree on field names', () => {
  const main = rd('main.js'), app = rd('renderer/app.js');
  const defaults = main.slice(main.indexOf('const DEFAULTS = {'));
  const keys = new Set([...defaults.slice(0, defaults.indexOf('};'))
    .matchAll(/^\s{2}([A-Za-z0-9_$]+)\s*:/gm)].map(m => m[1]));

  // whatever setCfg sends has to be a key main actually knows about, or the
  // setting silently does nothing
  const sent = app.slice(app.indexOf('window.forge.setCfg({'));
  const fields = [...sent.slice(0, sent.indexOf('});'))
    .matchAll(/^\s{4}([A-Za-z0-9_$]+)\s*:/gm)].map(m => m[1]);
  assert(fields.length >= 4, `only found ${fields.length} fields in saveCfg`);
  const stray = fields.filter(f => !keys.has(f));
  assert(!stray.length, `the settings panel writes ${stray.join(', ')}, which main.js has no default for`);

  // and everything loadCfg reads back must be a real element
  const html = rd('renderer/index.html');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  for (const m of app.matchAll(/\$\('#(cfg[A-Za-z0-9]+)'\)/g)) {
    assert(ids.has(m[1]), `app.js reads #${m[1]}, which is not in the settings panel`);
  }
});

check('the reference lookup cannot reach the renderer', () => {
  // network calls belong in main; the renderer asks and is handed JSON
  const app = rd('renderer/app.js') + rd('renderer/agent.js') + rd('renderer/cad.js');
  assert(!/\bfetch\s*\(/.test(app), 'a renderer module is making its own network call');
  assert(/thingiverse|printables/i.test(rd('main.js')), 'the reference sources are not in main.js');
  assert(/refs:search/.test(rd('preload.js')), 'the reference bridge is missing from preload');
});

check('the inline importmap still matches its CSP hash', async () => {
  const html = rd('renderer/index.html');
  const script = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert(script, 'the importmap is gone');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(script[1], 'utf8').digest('base64');
  const csp = html.match(/'sha256-([^']+)'/);
  assert(csp, 'no script hash in the content security policy');
  assert(csp[1] === digest,
    `the importmap was edited without updating the CSP hash.\n          policy has  sha256-${csp[1]}\n          content is  sha256-${digest}`);
});

check('every action the planner can pick has a clip behind it', () => {
  const anim = src['animations.js'];
  const ids = [...anim.matchAll(/^A\('([a-z_]+)'/gm)].map(m => m[1]);
  assert(ids.length > 40, `only ${ids.length} clips found`);
  assert(new Set(ids).size === ids.length, 'two clips share an id');
  for (const id of ['pick_up', 'set_down', 'walk_carry', 'present', 'idle']) {
    assert(ids.includes(id), `the executor plays "${id}" but no such clip exists`);
  }
  // the internal ones must be kept off the planner's menu
  for (const id of ['pick_up', 'set_down', 'walk_carry']) {
    const block = anim.slice(anim.indexOf(`A('${id}'`), anim.indexOf(`A('${id}'`) + 900);
    assert(/internal:\s*true/.test(block), `"${id}" is on the menu the planner picks from`);
  }
});

check('the geometry table covers every shape the schema allows', () => {
  const shapes = src['assembly.js'].match(/export const SHAPES = \[([^\]]+)\]/)[1]
    .split(',').map(s => s.trim().replace(/'/g, ''));
  const geo = src['shapes.js'].slice(src['shapes.js'].indexOf('export function partGeometry'));
  for (const sh of shapes) {
    if (sh === 'box') continue;                       // the default arm
    assert(geo.includes(`'${sh}'`), `nothing can draw a "${sh}"`);
  }
  // and the solver must have an opinion about the size of each of them
  const eff = src['assembly.js'].slice(src['assembly.js'].indexOf('export function effectiveSize'));
  const sized = shapes.filter(sh => eff.slice(0, eff.indexOf('halfExtents')).includes(`'${sh}'`));
  assert(sized.length >= shapes.length - 4,
    `effectiveSize only special-cases ${sized.join(', ')} — check the rest fall through to a sensible default`);
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
