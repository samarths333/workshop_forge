'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const DEV = process.argv.includes('--dev');
let win = null;

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
const cfgPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  provider: 'auto',                              // auto | nim | ollama | offline
  nimKey: '',
  nimModel: 'openai/gpt-oss-120b',
  nimBase: 'https://integrate.api.nvidia.com/v1',
  ollamaModel: 'llama3.2:3b',
  ollamaBase: 'http://127.0.0.1:11434',
  temperature: 0.7,
  references: 'auto',                            // auto | thingiverse | printables | off
  /* Shipped with a working app token so reference lookup does the right
     thing out of the box. Anyone who wants their own quota can paste a
     different one into Engine and it wins from then on. */
  thingiverseToken: 'ad5cb92d2ae88be9083a9fe9895d673c'
};
function loadCfg() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(cfgPath(), 'utf8'))); }
  catch { return { ...DEFAULTS }; }
}
function saveCfg(c) {
  const merged = Object.assign(loadCfg(), c);
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(merged, null, 2));
  return merged;
}

/* ------------------------------------------------------------------ */
/* the skill library                                                   */
/* ------------------------------------------------------------------ */
/* Lives beside settings.json in userData, so it survives a rebuild of the
   app and never ends up inside the read-only .app bundle. Written whole on
   every change — the file is a few kilobytes and a torn write here would
   cost the user everything Rivet has learned. */
const skillsPath = () => path.join(app.getPath('userData'), 'skills.json');

function loadSkills() {
  try {
    const raw = JSON.parse(fs.readFileSync(skillsPath(), 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw.skills) ? raw.skills : []);
  } catch { return []; }
}

function saveSkills(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'not a list' };
  const dir = path.dirname(skillsPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = skillsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, skillsPath());
  return { ok: true, count: list.length, path: skillsPath() };
}

ipcMain.handle('skills:load', () => loadSkills());
ipcMain.handle('skills:save', (_e, list) => saveSkills(list));
ipcMain.handle('skills:path', () => skillsPath());

ipcMain.handle('skills:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export what Rivet has learned',
    defaultPath: 'rivet-skills.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  fs.writeFileSync(filePath, JSON.stringify(loadSkills(), null, 2));
  return { ok: true, path: filePath };
});

ipcMain.handle('skills:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import a skill library',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths?.length) return { ok: false, cancelled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.skills;
    if (!Array.isArray(list)) throw new Error('that file is not a skill library');
    return { ok: true, skills: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ------------------------------------------------------------------ */
/* the object itself, off the pedestal and onto disk                   */
/* ------------------------------------------------------------------ */
/* The renderer tessellates and writes the bytes — it is the only side that
   has the meshes — and hands them over as a plain Uint8Array or a string.
   Main owns the dialog and the write, for the same reason it owns every
   other path in this app: the renderer never learns where anything lives. */
const EXT_LABEL = { stl: 'STL (for a slicer)', obj: 'OBJ (for a modeller)', json: 'JSON' };

ipcMain.handle('model:save', async (_e, { name, ext, data }) => {
  const safeExt = /^[a-z0-9]{2,4}$/.test(String(ext)) ? String(ext) : 'stl';
  const stem = String(name || 'build').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'build';

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save the build',
    defaultPath: `${stem}.${safeExt}`,
    filters: [{ name: EXT_LABEL[safeExt] || safeExt.toUpperCase(), extensions: [safeExt] }]
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(new Uint8Array(data));
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ------------------------------------------------------------------ */
/* llm transport                                                       */
/* ------------------------------------------------------------------ */
async function withTimeout(promise, ms, label) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await promise(ctl.signal); }
  finally { clearTimeout(t); }
}

async function callNIM(cfg, messages, schemaHint) {
  if (!cfg.nimKey) throw new Error('No NVIDIA API key set');
  const body = {
    model: cfg.nimModel,
    messages,
    temperature: cfg.temperature,
    max_tokens: 2400,
    response_format: { type: 'json_object' }
  };
  const r = await withTimeout(signal => fetch(`${cfg.nimBase}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.nimKey}` },
    body: JSON.stringify(body)
  }), 60000);
  if (!r.ok) throw new Error(`NIM ${r.status}: ${(await r.text()).slice(0, 220)}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('NIM returned an empty message');
  return { text, engine: `NVIDIA NIM · ${cfg.nimModel}` };
}

async function callOllama(cfg, messages, schema) {
  const body = {
    model: cfg.ollamaModel,
    messages,
    stream: false,
    options: { temperature: cfg.temperature, num_ctx: 8192 }
  };
  if (schema) body.format = schema;          // hard JSON-schema enforcement
  const r = await withTimeout(signal => fetch(`${cfg.ollamaBase}/api/chat`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), 180000);
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 220)}`);
  const j = await r.json();
  const text = j?.message?.content || '';
  if (!text.trim()) throw new Error('Ollama returned an empty message');
  return { text, engine: `Ollama · ${cfg.ollamaModel}` };
}

ipcMain.handle('llm:plan', async (_e, { messages, schema }) => {
  const cfg = loadCfg();
  const tried = [];
  const order =
    cfg.provider === 'nim' ? ['nim'] :
    cfg.provider === 'ollama' ? ['ollama'] :
    cfg.provider === 'offline' ? [] : ['nim', 'ollama'];

  for (const which of order) {
    try {
      const out = which === 'nim' ? await callNIM(cfg, messages, schema)
                                  : await callOllama(cfg, messages, schema);
      return { ok: true, ...out, tried };
    } catch (err) {
      tried.push(`${which}: ${err.message}`);
    }
  }
  return { ok: false, tried, engine: 'offline planner' };
});

ipcMain.handle('llm:probe', async () => {
  const cfg = loadCfg();
  const out = { nim: null, ollama: null };
  if (cfg.nimKey) {
    try {
      const r = await withTimeout(signal => fetch(`${cfg.nimBase}/models`, {
        signal, headers: { Authorization: `Bearer ${cfg.nimKey}` }
      }), 12000);
      if (r.ok) {
        const j = await r.json();
        out.nim = { ok: true, models: (j.data || []).map(m => m.id).sort() };
      } else out.nim = { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { out.nim = { ok: false, error: e.message }; }
  } else out.nim = { ok: false, error: 'no key' };

  try {
    const r = await withTimeout(signal => fetch(`${cfg.ollamaBase}/api/tags`, { signal }), 6000);
    if (r.ok) {
      const j = await r.json();
      out.ollama = { ok: true, models: (j.models || []).map(m => m.name) };
    } else out.ollama = { ok: false, error: `HTTP ${r.status}` };
  } catch (e) { out.ollama = { ok: false, error: 'not running' }; }

  /* and check the reference lookup with a canned query, so a bad
     Thingiverse token shows up here rather than silently doing nothing
     in the middle of a build */
  if (cfg.references === 'off') {
    out.refs = { ok: false, error: 'turned off' };
  } else {
    const notes = [];
    let found = 0;
    if (cfg.references === 'auto' || cfg.references === 'thingiverse') {
      try { found += (await searchThingiverse(cfg, 'desk lamp', 3)).length; notes.push('thingiverse ok'); }
      catch (e) { notes.push(`thingiverse: ${e.message}`); }
    }
    if (cfg.references === 'auto' || cfg.references === 'printables') {
      try { found += (await searchPrintables('desk lamp', 3)).length; notes.push('printables ok'); }
      catch (e) { notes.push(`printables: ${e.message}`); }
    }
    out.refs = { ok: found > 0, found, notes };
  }

  return out;
});

/* ------------------------------------------------------------------ */
/* reference designs — how people actually make this thing             */
/* ------------------------------------------------------------------ */
/* The planner is much better at "a phone stand" when it has seen that real
   ones have a back rest at about 60°, a lip at the front and a cable slot,
   than when it is guessing from the two words in the request. So before
   planning we go and look at what people have actually published.

   Thingiverse first: everything on it is openly licensed, and the REST API
   is documented and stable. It wants a free app token. Printables is the
   backup — no auth, but the endpoint is the one their own front end talks
   to and is not a published contract, so it is treated as best-effort and
   never allowed to fail a build. */

const UA = 'WorkshopForge/1.0 (+https://github.com/) reference lookup';
const strip = s => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

async function searchThingiverse(cfg, term, limit) {
  if (!cfg.thingiverseToken) throw new Error('no app token set');
  const base = `https://api.thingiverse.com/search/?q=${encodeURIComponent(term)}`
    + `&type=things&per_page=${limit}&sort=popular`;

  // the API takes the token either as a bearer header or as a query
  // parameter depending on how the app was registered; try the tidier one
  // first and fall back rather than making the user guess which they have
  let r = await withTimeout(signal => fetch(base, {
    signal,
    headers: { Authorization: `Bearer ${cfg.thingiverseToken}`, 'User-Agent': UA }
  }), 12000);
  if (r.status === 401 || r.status === 403) {
    r = await withTimeout(signal => fetch(
      `${base}&access_token=${encodeURIComponent(cfg.thingiverseToken)}`,
      { signal, headers: { 'User-Agent': UA } }
    ), 12000);
  }
  if (!r.ok) throw new Error(r.status === 401 ? 'token rejected' : `HTTP ${r.status}`);
  const j = await r.json();
  const hits = Array.isArray(j) ? j : (j.hits || j.results || []);
  return hits.slice(0, limit).map(t => ({
    source: 'thingiverse',
    title: strip(t.name).slice(0, 90),
    url: t.public_url || t.url || '',
    likes: Number(t.like_count) || 0,
    tags: (t.tags || []).map(x => strip(x.name || x)).filter(Boolean).slice(0, 6),
    summary: strip(t.description).slice(0, 240)
  })).filter(x => x.title);
}

const PRINTABLES_QUERY = `query SearchModels($query: String!, $limit: Int, $ordering: SearchChoicesEnum) {
  result: searchPrints2(query: $query, printType: print, limit: $limit, ordering: $ordering) {
    items { id name slug likesCount downloadCount __typename }
    __typename
  }
}`;

async function searchPrintables(term, limit) {
  const r = await withTimeout(signal => fetch('https://api.printables.com/graphql/', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      operationName: 'SearchModels',
      query: PRINTABLES_QUERY,
      variables: { query: term, limit, ordering: 'best_match' }
    })
  }), 12000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const items = j?.data?.result?.items;
  if (!Array.isArray(items)) throw new Error('unexpected response shape');
  return items.slice(0, limit).map(m => ({
    source: 'printables',
    title: strip(m.name).slice(0, 90),
    url: m.id ? `https://www.printables.com/model/${m.id}-${m.slug || ''}` : '',
    likes: Number(m.likesCount) || 0,
    tags: [],
    summary: ''
  })).filter(x => x.title);
}

/* ------------------------------------------------------------------ */
/* the engineering sources                                             */
/* ------------------------------------------------------------------ */
/* Thingiverse has no turbofan and no wing spar. What it has is a keychain
   shaped like a jet engine. For anything above the level of "things that
   print in four hours" the useful references are encyclopedic and
   technical, so those get their own fetchers here.

   Same contract as the maker sites: every one of these is best-effort, and
   a source that is down, rate-limited or has changed its response shape
   returns nothing and says why. None of them is ever allowed to fail a
   build. */

async function getJSON(url, ms = 12000, headers = {}) {
  const r = await withTimeout(signal => fetch(url, {
    signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }
  }), ms);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* Wikipedia — what the thing is made of, and what the parts are called.
   One round trip: the search generator hands its results straight to the
   extract module, so a query returns titles AND prose together. */
async function searchWikipedia(term, limit) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*'
    + '&prop=extracts&explaintext=1&exintro=0&exchars=2200&redirects=1'
    + `&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrlimit=${limit}&gsrnamespace=0`;
  const j = await getJSON(url);
  const pages = j?.query?.pages;
  if (!pages) throw new Error('nothing found');
  return Object.values(pages)
    .filter(p => p && p.title && p.extract)
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .slice(0, limit)
    .map(p => ({
      source: 'wikipedia',
      title: strip(p.title).slice(0, 90),
      url: `https://en.wikipedia.org/?curid=${p.pageid}`,
      likes: 0,
      tags: [],
      // the extract is the raw material structureFrom() mines in the
      // renderer — main does not interpret it, it just carries it
      summary: strip(p.extract).slice(0, 2000)
    }));
}

/* Wikimedia Commons — the cutaways and schematics themselves. Biased
   towards drawings on purpose: a photograph of an engine tells the planner
   nothing it can use, a labelled section drawing tells it everything. */
async function searchCommons(term, limit) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*'
    + `&list=search&srnamespace=6&srlimit=${limit}`
    + `&srsearch=${encodeURIComponent(`${term} (diagram OR schematic OR cutaway OR cross-section)`)}`;
  const j = await getJSON(url);
  const hits = j?.query?.search;
  if (!Array.isArray(hits)) throw new Error('unexpected response shape');
  return hits.slice(0, limit).map(h => ({
    source: 'commons',
    title: strip(h.title).replace(/^File:/, '').replace(/\.(svg|png|jpe?g|gif)$/i, '').slice(0, 90),
    url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(h.title)}`,
    likes: 0,
    tags: [],
    summary: strip(h.snippet).slice(0, 200)
  })).filter(x => x.title);
}

/* NASA's technical reports — half a century of engineering documents on
   anything that flies, all public domain. The abstracts alone are dense
   with the right vocabulary. */
async function searchNTRS(term, limit) {
  const j = await getJSON(`https://ntrs.nasa.gov/api/citations/search?q=${encodeURIComponent(term)}&size=${limit}`, 15000);
  const hits = j?.results;
  if (!Array.isArray(hits)) throw new Error('unexpected response shape');
  return hits.slice(0, limit).map(h => ({
    source: 'ntrs',
    title: strip(h.title).slice(0, 90),
    url: h.id ? `https://ntrs.nasa.gov/citations/${h.id}` : '',
    likes: 0,
    tags: (h.subjectCategories || []).slice(0, 4).map(s => strip(s)),
    summary: strip(h.abstract).slice(0, 600)
  })).filter(x => x.title && x.summary);
}

/* Openverse — openly licensed images across a lot of collections, which is
   where the good exploded-view diagrams tend to be. */
async function searchOpenverse(term, limit) {
  const j = await getJSON(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(term + ' diagram')}&page_size=${limit}`);
  const hits = j?.results;
  if (!Array.isArray(hits)) throw new Error('unexpected response shape');
  return hits.slice(0, limit).map(h => ({
    source: 'openverse',
    title: strip(h.title).slice(0, 90),
    url: h.foreign_landing_url || h.url || '',
    likes: 0,
    tags: (h.tags || []).slice(0, 5).map(t => strip(t.name || t)).filter(Boolean),
    summary: ''
  })).filter(x => x.title);
}

const FETCHERS = {
  thingiverse: (cfg, term, n) => searchThingiverse(cfg, term, n),
  printables:  (_c, term, n) => searchPrintables(term, n),
  wikipedia:   (_c, term, n) => searchWikipedia(term, n),
  commons:     (_c, term, n) => searchCommons(term, n),
  ntrs:        (_c, term, n) => searchNTRS(term, n),
  openverse:   (_c, term, n) => searchOpenverse(term, n)
};

/* The renderer decides WHICH sources to ask — that is routing, it is pure,
   and it is tested in library.js. Main just runs the named lookups. */
ipcMain.handle('refs:search', async (_e, query) => {
  const cfg = loadCfg();
  const q = typeof query === 'string' ? { term: query } : (query || {});
  const term = String(q.term || '').trim().slice(0, 120);
  const alt = (Array.isArray(q.terms) ? q.terms : []).map(t => String(t).slice(0, 120)).filter(Boolean);
  if (!term) return { ok: false, refs: [], tried: ['empty request'] };
  if (cfg.references === 'off') return { ok: false, off: true, refs: [], tried: [] };

  // an explicit setting still pins the maker sites, the way it always did
  let wanted = Array.isArray(q.sources) && q.sources.length ? q.sources : ['thingiverse', 'printables'];
  if (cfg.references === 'thingiverse') wanted = wanted.filter(s => s !== 'printables');
  if (cfg.references === 'printables') wanted = wanted.filter(s => s !== 'thingiverse');

  const refs = [], tried = [];
  const perSource = Math.max(3, Math.ceil(10 / wanted.length));

  /* All of them at once. Four sequential lookups at up to fifteen seconds
     each is a quarter of a minute of a robot standing still before he has
     even been told what to build. */
  const runs = await Promise.allSettled(wanted.map(async name => {
    const fn = FETCHERS[name];
    if (!fn) throw new Error('no such source');
    let out = await fn(cfg, term, perSource);
    // an encyclopedia often wants the noun on its own rather than the
    // sentence someone asked in
    if (!out.length && alt.length) {
      for (const t of alt) {
        out = await fn(cfg, t, perSource);
        if (out.length) break;
      }
    }
    return { name, out };
  }));

  runs.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      refs.push(...r.value.out);
      if (!r.value.out.length) tried.push(`${wanted[i]}: nothing found`);
    } else {
      tried.push(`${wanted[i]}: ${r.reason?.message || 'failed'}`);
    }
  });

  return { ok: refs.length > 0, refs: refs.slice(0, 16), tried, sources: wanted };
});

ipcMain.handle('cfg:get', () => loadCfg());
ipcMain.handle('cfg:set', (_e, c) => saveCfg(c));
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0c0a08',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

const template = [
  { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  {
    label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ]
  },
  { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
