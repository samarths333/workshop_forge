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
  thingiverseToken: ''
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

ipcMain.handle('refs:search', async (_e, term) => {
  const cfg = loadCfg();
  const query = String(term || '').trim().slice(0, 120);
  if (!query) return { ok: false, refs: [], tried: ['empty request'] };
  if (cfg.references === 'off') return { ok: false, off: true, refs: [], tried: [] };

  const refs = [], tried = [];
  const wantThing = cfg.references === 'auto' || cfg.references === 'thingiverse';
  const wantPrint = cfg.references === 'auto' || cfg.references === 'printables';

  if (wantThing) {
    try { refs.push(...await searchThingiverse(cfg, query, 8)); }
    catch (e) { tried.push(`thingiverse: ${e.message}`); }
  }
  // only fall through to Printables if Thingiverse came up short — the
  // openly-licensed source is the one we would rather be learning from
  if (wantPrint && refs.length < 4) {
    try { refs.push(...await searchPrintables(query, 6)); }
    catch (e) { tried.push(`printables: ${e.message}`); }
  }

  return { ok: refs.length > 0, refs: refs.slice(0, 12), tried };
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
