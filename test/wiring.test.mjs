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
  for (const f of ['assembly.js', 'skills.js', 'history.js', 'export3d.js']) {
    assert(src[f], `${f} is gone`);
    const imports = [...src[f].matchAll(/^\s*import\s.*$/gm)].map(m => m[0].trim());
    assert(!imports.length, `${f} now imports: ${imports.join(' / ')} — it has to stay headless`);
    assert(!/\bdocument\.|\bwindow\.|THREE\./.test(src[f]), `${f} reaches for the DOM or three.js`);
  }
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
  const app = src['app.js'].replace(/from\s*'[^']*'/g, '');     // not the import paths
  for (const m of app.matchAll(/\bworld\.([A-Za-z0-9_$]+)/g)) {
    if (!worldHas.has(m[1])) missing.push(`world.${m[1]}`);
  }
  for (const m of app.matchAll(/\brivet\.([A-Za-z0-9_$]+)/g)) {
    if (!rivetHas.has(m[1])) missing.push(`rivet.${m[1]}`);
  }
  assert(!missing.length, `undefined: ${[...new Set(missing)].join(', ')}`);
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
