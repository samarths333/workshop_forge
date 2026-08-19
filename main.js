'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');

const DEV = process.argv.includes('--dev');
let win = null;

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
const cfgPath = () => path.join(app.getPath('userData'), 'settings.json');

/* loadCfg is synchronous and called from everywhere, so the pure migrator is
   pulled in once at boot rather than awaited on every read. Until it lands,
   settings read exactly as they always did.

   `var`, deliberately: `let` would leave this in the temporal dead zone for
   any read that happens before this line executes, and loadCfg is reachable
   from an IPC handler the instant the window exists. */
var MIGRATE = null;
import(url.pathToFileURL(path.join(__dirname, 'renderer', 'providers.js')).href)
  .then(m => { MIGRATE = m.migrateConfig; })
  .catch(e => console.error('[forge] the provider table would not load:', e.message));

const DEFAULTS = {
  /* The engine settings used to be two providers and an if/else. They are now
     a table: `providers` holds one entry per engine the app knows about,
     `chain` is the order to try them in, and `tiers` says which engine does
     which KIND of job — see renderer/providers.js. The old flat nim and ollama
     fields are still here so an existing settings file keeps its key; they
     are migrated into `providers` on load and never written again. */
  providers: {},                                 // id → { key, model, base }
  chain: [],                                     // ids, best first
  tiers: {},                                     // high | medium | low → { provider, model }
  provider: 'auto',                              // legacy, migrated
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
  thingiverseToken: 'ad5cb92d2ae88be9083a9fe9895d673c',
  /* Empty means "use the public instances". Anyone running their own
     SearXNG points this at it and stops depending on strangers. */
  searxBase: '',
  /* Blank means "go and find one". Anyone with build123d in a conda env
     points this at that interpreter and stops the search. */
  pythonPath: '',
  cadTimeout: 90000,
  readPages: true,
  /* Off by default. Something that starts moving on its own has to be
     asked for — and unattended study stays off the network until it is
     asked for separately, because an overnight run should not be able to
     spend somebody's key. */
  study: false,
  studyEngine: false
};
function loadCfg() {
  let raw;
  try { raw = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(cfgPath(), 'utf8'))); }
  catch { raw = { ...DEFAULTS }; }
  /* An existing settings file has a NIM key and an Ollama model in the old
     flat fields. Dropping those on the floor because the app grew a provider
     table would be the rudest possible upgrade, so they are folded in. The
     migration is pure and lives with the table it migrates into. */
  if (MIGRATE) Object.assign(raw, MIGRATE(raw));
  return raw;
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

/* ------------------------------------------------------------------ */
/* the shape library                                                   */
/* ------------------------------------------------------------------ */
/* Shapes somebody made on the bench. Beside skills.json for the same
   reasons — outside the read-only bundle, survives a rebuild, written
   whole because it is small and a torn write costs the lot. The renderer
   sanitizes what comes back (shapelib.sanitizeLibrary); main only moves
   bytes, exactly as it does for skills. */
const shapesPath = () => path.join(app.getPath('userData'), 'shapes.json');

function loadShapes() {
  try {
    const raw = JSON.parse(fs.readFileSync(shapesPath(), 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw.shapes) ? raw.shapes : []);
  } catch { return []; }
}

function saveShapes(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'not a list' };
  const dir = path.dirname(shapesPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = shapesPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, shapesPath());
  return { ok: true, count: list.length, path: shapesPath() };
}

ipcMain.handle('shapes:load', () => loadShapes());
ipcMain.handle('shapes:save', (_e, list) => saveShapes(list));
ipcMain.handle('shapes:path', () => shapesPath());

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

/* ------------------------------------------------------------------ *
 * one transport, N providers
 * ------------------------------------------------------------------ *
 * There used to be a function per engine and an if/else picking between
 * them. Adding a third meant a third function. Now the provider is a row in
 * a table (renderer/providers.js) that says where it lives, how it
 * authenticates, how its body is shaped and where the answer is — and this
 * is the one function that reads the row.
 *
 * The table lives on the renderer side with the rest of the pure logic, so
 * the shaping can be checked in node. Main is the only place that fetches,
 * exactly as with the reference lookup.
 */
let PROV = null;
async function providers() {
  if (!PROV) PROV = await import(url.pathToFileURL(path.join(__dirname, 'renderer', 'providers.js')).href);
  return PROV;
}

/* Everything that went wrong, in a shape the renderer can say out loud.
   `code` is the classified reason — auth, rate_limit, network — because
   "HTTP 401" in a log line is not something anybody acts on. */
function providerError(label, status, body, P) {
  const code = P.classifyHttpStatus(status);
  const e = new Error(`${label} ${status} — ${P.ERROR_HELP[code]}${body ? `: ${String(body).slice(0, 180)}` : ''}`);
  e.code = code;
  e.status = status;
  return e;
}

async function callProvider(cfg, providerId, modelOverride) {
  const P = await providers();
  const p = P.providerById(providerId);
  if (!p) throw new Error(`no provider called "${providerId}"`);
  const pc = (cfg.providers || {})[p.id] || {};
  if (p.needsKey && !pc.key) throw Object.assign(new Error(`${p.label}: no key set`), { code: 'auth' });

  const model = modelOverride || pc.model || p.defaultModel;
  if (!model) throw Object.assign(new Error(`${p.label}: no model set`), { code: 'bad_request' });

  return async (messages, schema) => {
    const { headers, query } = P.authFor(p, pc);
    let target = P.chatUrl(p, pc, model);
    if (query) target += (target.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();

    const body = P.buildBody(p, {
      model, messages, schema,
      temperature: cfg.temperature,
      maxTokens: p.kind === 'ollama' ? 3200 : 2600
    });

    const r = await withTimeout(signal => fetch(target, {
      method: 'POST', signal, headers, body: JSON.stringify(body)
    }), p.needsKey ? 90000 : 180000);

    if (!r.ok) {
      const err = providerError(p.label, r.status, await r.text().catch(() => ''), P);
      const wait = P.retryAfterMs(r.headers.get('retry-after'));
      if (wait != null) err.retryAfterMs = wait;
      throw err;
    }
    const j = await r.json();
    const text = P.extractText(p, j);
    if (!String(text).trim()) throw Object.assign(new Error(`${p.label} returned an empty message`), { code: 'server' });
    return { text, engine: P.engineLabel(p.id, model), provider: p.id, model };
  };
}

/* One job, routed. `role` is who on the floor is asking — the foreman, a
   specialist, the critic — and it picks the TIER, which picks the engine.
   Everything configured is still behind it as a fallback, so a tier
   assignment is a preference rather than a single point of failure. */
ipcMain.handle('llm:plan', async (_e, { messages, schema, role }) => {
  const cfg = loadCfg();
  const P = await providers();
  const route = P.routeFor(role, cfg);
  const tried = [];

  for (const hop of route) {
    try {
      const send = await callProvider(cfg, hop.provider, hop.model);
      const out = await send(messages, schema);
      return { ok: true, ...out, tier: hop.tier || null, tried };
    } catch (err) {
      tried.push(`${hop.provider}: ${err.message}`);
      /* A rate limit on the tier's own engine is not a reason to give up on
         it forever, but it IS a reason to move on for this call rather than
         sit on a timer while three other specialists wait. */
    }
  }
  return { ok: false, tried, engine: 'offline planner' };
});

/* The model list for one provider, so the settings panel offers what the key
   can actually reach today instead of a hardcoded guess. */
ipcMain.handle('llm:models', async (_e, { provider }) => {
  const cfg = loadCfg();
  const P = await providers();
  const p = P.providerById(provider);
  if (!p) return { ok: false, error: 'no such provider' };
  const pc = (cfg.providers || {})[p.id] || {};
  try {
    const { headers, query } = P.authFor(p, pc);
    let target = P.modelsUrl(p, pc);
    if (query) target += (target.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
    const r = await withTimeout(signal => fetch(target, { signal, headers }), 15000);
    if (!r.ok) throw providerError(p.label, r.status, '', P);
    const models = P.modelsFrom(p, await r.json());
    return { ok: true, models: models.length ? models : p.models };
  } catch (e) {
    /* A provider that cannot list is not necessarily a provider that cannot
       answer — several of them do not expose a catalogue at all. The built-in
       list is still better than an empty dropdown. */
    return { ok: false, error: e.message, models: p.models };
  }
});

ipcMain.handle('llm:probe', async () => {
  const cfg = loadCfg();
  const out = { nim: null, ollama: null, web: null, providers: {} };

  /* Search is worth probing separately: it is the one part of the stack
     that can fail silently and leave every build slightly worse without
     ever showing an error. */
  try {
    const hits = await searchWeb(cfg, 'bandsaw fence build', 3);
    out.web = { ok: true, count: hits.length, first: hits[0]?.title || '' };
  } catch (e) {
    out.web = { ok: false, error: e.message };
  }
  /* Every provider that is configured gets pinged, in parallel — one dead
     endpoint used to hold the whole panel up while it timed out. What comes
     back per provider is whether it answered, what its catalogue looks like,
     and the CLASSIFIED reason if it did not, because "auth" and "network"
     are two very different afternoons. */
  const P = await providers();
  out.providers = {};
  await Promise.all(P.PROVIDERS.map(async p => {
    const pc = (cfg.providers || {})[p.id] || {};
    if (p.needsKey && !pc.key) { out.providers[p.id] = { ok: false, code: 'unset', error: 'no key' }; return; }
    if (!p.base && !pc.base) { out.providers[p.id] = { ok: false, code: 'unset', error: 'no address' }; return; }
    try {
      const { headers, query } = P.authFor(p, pc);
      let target = P.modelsUrl(p, pc);
      if (query) target += (target.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
      const r = await withTimeout(signal => fetch(target, { signal, headers }), 12000);
      if (!r.ok) {
        const code = P.classifyHttpStatus(r.status);
        out.providers[p.id] = { ok: false, code, error: `${r.status} — ${P.ERROR_HELP[code]}` };
        return;
      }
      const models = P.modelsFrom(p, await r.json());
      out.providers[p.id] = { ok: true, models: models.length ? models : p.models };
    } catch (e) {
      out.providers[p.id] = { ok: false, code: 'network', error: e.message };
    }
  }));
  /* the two the app used to know about, kept in the old shape so nothing
     that reads them has to care that there are now nine */
  out.nim = out.providers.nvidia;
  out.ollama = out.providers.ollama;

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
  /* The search term goes in the PATH. `?q=` is not a parameter this API
     knows, and an unknown parameter is not an error here — it is ignored,
     and you get the most popular things on the whole site instead. That
     failure is invisible: 200 OK, a full page of real, well-liked models,
     the same ones for every request. It is why a desk lamp and a coffee
     grinder stand both came back as a tugboat. */
  const base = `https://api.thingiverse.com/search/${encodeURIComponent(term)}`
    + `?type=things&per_page=${limit}&sort=popular`;

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
  // a term with no matches is a 404 here, not an empty list
  if (r.status === 404) return [];
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

/* ------------------------------------------------------------------ */
/* the open web                                                        */
/* ------------------------------------------------------------------ */
/* The print sites have a keychain shaped like a jet engine and the
   encyclopedia has one paragraph. For most of what people actually ask
   for — a bandsaw fence, a quadcopter arm, a bike rack that fits a
   Corolla — the useful writing is on a forum, a maker blog, a supplier's
   spec page. None of that is in any of the APIs above.

   SearXNG is the way in: it is a metasearch front end that returns JSON,
   needs no key and no account, and is what a self-hosted search stack
   looks like. Public instances rate-limit and disappear, so this tries a
   list of them in turn and then falls back to DuckDuckGo's lite endpoint,
   which is undocumented and treated as exactly that. */
const SEARX_FALLBACKS = [
  'https://searx.be',
  'https://search.inetol.net',
  'https://priv.au'
];

async function searchWeb(cfg, term, limit) {
  const instances = [cfg.searxBase, ...SEARX_FALLBACKS].filter(Boolean);
  const tried = [];

  for (const base of instances) {
    try {
      const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(term)}`
        + '&format=json&safesearch=1&language=en&categories=general';
      const j = await getJSON(url, 14000);
      const hits = Array.isArray(j?.results) ? j.results : [];
      if (!hits.length) { tried.push(`${base}: nothing`); continue; }
      return hits.slice(0, limit).map(h => ({
        source: 'web',
        title: strip(h.title).slice(0, 110),
        url: h.url || '',
        likes: 0,
        tags: [],
        summary: strip(h.content).slice(0, 400)
      })).filter(x => x.title && x.url);
    } catch (e) {
      // a public instance that is down or rate-limiting is the normal case,
      // not an error worth surfacing — move to the next one
      tried.push(`${base}: ${e.message}`);
    }
  }

  /* Both backstops, then give up with advice rather than a shrug. The
     honest position in 2026: public SearXNG instances ship with the JSON
     API off and increasingly sit behind browser verification, so this
     path is only dependable against an instance you run yourself. It is
     one docker line, and then it is genuinely free and unlimited. */
  for (const fn of [searchDuckDuckGo, searchDuckLite]) {
    try {
      const out = await fn(term, limit);
      if (out.length) return out;
      tried.push(`${fn.name}: nothing`);
    } catch (e) { tried.push(`${fn.name}: ${e.message}`); }
  }
  throw new Error('no search reachable — run your own SearXNG and set it in Engine '
    + `(docker run -d -p 8888:8080 searxng/searxng, then http://127.0.0.1:8888). Tried: ${tried.slice(0, 3).join('; ')}`);
}

/* The backstop. HTML, undocumented, scraped — so it is deliberately last
   and deliberately forgiving about coming back empty. */
async function searchDuckDuckGo(term, limit) {
  const r = await withTimeout(signal => fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`,
    { signal, headers: { 'User-Agent': UA, Accept: 'text/html' } }
  ), 12000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = decodeDDG(m[1]);
    const title = strip(m[2].replace(/<[^>]+>/g, ' '));
    if (!href || !title) continue;
    out.push({ source: 'web', title: title.slice(0, 110), url: href, likes: 0, tags: [], summary: '' });
  }
  return out;
}

/* The lite endpoint is a different shape again — a bare table of links —
   and it survives when the html one does not. */
async function searchDuckLite(term, limit) {
  const r = await withTimeout(signal => fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST', signal,
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html'
    },
    body: `q=${encodeURIComponent(term)}`
  }), 12000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  const out = [];
  const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = decodeDDG(m[1]);
    const title = strip(m[2].replace(/<[^>]+>/g, ' '));
    if (href && title) out.push({ source: 'web', title: title.slice(0, 110), url: href, likes: 0, tags: [], summary: '' });
  }
  return out;
}

/* DuckDuckGo wraps every result in its own redirect. */
function decodeDDG(href) {
  try {
    const s = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(s);
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : (u.protocol.startsWith('http') ? u.href : '');
  } catch { return ''; }
}

/* ------------------------------------------------------------------ */
/* reading a page                                                      */
/* ------------------------------------------------------------------ */
/* A list of titles is what the shop already had, and it is not enough —
   "Bandsaw Fence Build Thread" tells the planner nothing. The page behind
   it says the fence is a hardwood face on an aluminium extrusion with a
   cam clamp at each end, and gives the dimensions.

   So the best few results get fetched and stripped to text. No parser
   library: script, style, nav and footer are cut, tags are dropped,
   entities are decoded, whitespace is collapsed. Crude, and completely
   adequate for mining part names and numbers out of prose. The renderer
   does the mining — this side only ever produces text. */
async function readPage(url, max = 6000) {
  const r = await withTimeout(signal => fetch(url, {
    signal, redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
  }), 12000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const type = r.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/.test(type)) throw new Error('not a page');

  const html = (await r.text()).slice(0, 900_000);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // keep the block structure as newlines so sentences do not run together
    .replace(/<\/(p|div|li|h[1-6]|tr|br)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(body)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).filter(l => l.length > 1).join('\n')
    .slice(0, max);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27|#x2F|#8217|#8220|#8221|#8211|#8212);/g, m => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
      '&nbsp;': ' ', '&#39;': "'", '&#x27;': "'", '&#x2F;': '/',
      '&#8217;': '’', '&#8220;': '“', '&#8221;': '”', '&#8211;': '–', '&#8212;': '—'
    }[m] || m))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/* Read several at once, and never let one slow page hold up a build. */
ipcMain.handle('refs:read', async (_e, urls) => {
  const list = (Array.isArray(urls) ? urls : []).slice(0, 4).filter(u => /^https?:\/\//.test(u));
  if (!list.length) return { ok: false, pages: [] };

  const runs = await Promise.allSettled(list.map(async u => ({ url: u, text: await readPage(u) })));
  const pages = runs.filter(r => r.status === 'fulfilled' && r.value.text.length > 400).map(r => r.value);
  return { ok: pages.length > 0, pages };
});

const FETCHERS = {
  web:         (cfg, term, n) => searchWeb(cfg, term, n),
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
  /* The renderer hands over a ladder of queries, most specific first. Walk
     down it until a rung returns enough to be worth having — searching for
     the whole sentence somebody typed matches almost nothing, and stopping
     at the first rung that returns a single weak hit is nearly as bad. */
  const ladder = [...new Set([...alt, term])].filter(Boolean);

  const runs = await Promise.allSettled(wanted.map(async name => {
    const fn = FETCHERS[name];
    if (!fn) throw new Error('no such source');
    let best = [], used = null;
    for (const t of ladder) {
      const out = await fn(cfg, t, perSource);
      if (out.length > best.length) { best = out; used = t; }
      if (best.length >= 2) break;
    }
    return { name, out: best, used };
  }));

  runs.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      refs.push(...r.value.out);
      if (!r.value.out.length) tried.push(`${wanted[i]}: nothing found`);
    } else {
      tried.push(`${wanted[i]}: ${r.reason?.message || 'failed'}`);
    }
  });

  return { ok: refs.length > 0, refs: refs.slice(0, 16), tried, sources: wanted, searched: ladder };
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

/* ------------------------------------------------------------------ */
/* the CAD kernel                                                      */
/* ------------------------------------------------------------------ */
/* A separate Python process per script, holding build123d. It is a
   sidecar rather than a library because OpenCascade is a 200MB native
   dependency that has no business being a hard requirement of a shop
   whose whole point is that it always produces something — no Python,
   no kernel, and the primitive path carries on exactly as before.

   Main owns the execution for the same reason it owns every other fetch
   and every other file write: the renderer never gets to run anything. */
const CAD_KERNEL = path.join(__dirname, 'cad', 'kernel.py');

function pythonCandidates(cfg) {
  const listed = String(cfg.pythonPath || '').trim();
  return [
    listed,
    process.env.WORKSHOP_PYTHON,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    // conda is where build123d usually ends up, because that is what its
    // own install instructions tell people to do
    path.join(os.homedir(), 'miniconda3', 'bin', 'python3'),
    path.join(os.homedir(), 'anaconda3', 'bin', 'python3')
  ].filter(Boolean);
}

/* Which interpreter actually has the kernel in it. Cached, because this
   spawns a process and the answer does not change while the app runs. */
let cadPython = null;
async function findPython(cfg) {
  if (cadPython !== null) return cadPython;
  for (const exe of pythonCandidates(cfg)) {
    try {
      const r = await runProc(exe, ['-c', 'import build123d, sys; sys.stdout.write(build123d.__version__)'], '', 20000);
      if (r.code === 0 && r.stdout.trim()) {
        cadPython = { exe, version: r.stdout.trim() };
        return cadPython;
      }
    } catch { /* not this one */ }
  }
  cadPython = { exe: null, version: null };
  return cadPython;
}

function runProc(exe, args, input, ms) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(exe, args, {
        cwd: path.dirname(CAD_KERNEL),
        // a stripped environment: the script has no business reading the
        // API key out of the shop's own process
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) { return reject(e); }

    let stdout = '', stderr = '', settled = false;
    const finish = r => { if (!settled) { settled = true; resolve(r); } };

    // the hard stop. A kernel that hangs on a pathological loft would
    // otherwise hold a build open forever.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ code: -1, stdout, stderr: stderr + '\ntimed out' });
    }, ms);

    child.stdout.on('data', d => { stdout += d; if (stdout.length > 4e7) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { stderr += d.toString().slice(0, 4000); });
    child.on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    child.on('close', code => { clearTimeout(timer); finish({ code, stdout, stderr }); });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

ipcMain.handle('cad:probe', async () => {
  const py = await findPython(loadCfg());
  return py.exe
    ? { ok: true, python: py.exe, version: py.version }
    : { ok: false, error: 'build123d was not found in any Python on this machine — pip install build123d' };
});

ipcMain.handle('cad:run', async (_e, { code, stem, out, mesh = true }) => {
  const cfg = loadCfg();
  const py = await findPython(cfg);
  if (!py.exe) return { ok: false, stage: 'kernel', error: 'no Python with build123d installed' };

  const dir = out || path.join(app.getPath('temp'), 'workshop-forge-cad');
  const job = JSON.stringify({ code: String(code || ''), out: dir, stem: stem || 'part', mesh });

  let r;
  try {
    r = await runProc(py.exe, [CAD_KERNEL], job, Number(cfg.cadTimeout) || 90000);
  } catch (e) {
    return { ok: false, stage: 'kernel', error: `could not start the kernel: ${e.message}` };
  }

  // the kernel writes its answer as the last line; anything the script
  // printed came out on the same stream and is simply ignored
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* not the answer line */ }
  }
  return {
    ok: false, stage: 'kernel',
    error: r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'the kernel said nothing'
  };
});

/* ------------------------------------------------------------------ */
/* headless: the shop as something another program can call            */
/* ------------------------------------------------------------------ */
/*   electron . --forge "a desk lamp" --out /tmp/build [--offline] [--json]
 *
 * Bob does not want to watch a robot walk across a shop for four minutes;
 * he wants the object, a picture of it and the files. So this runs the
 * whole pipeline in a hidden window — the same planner, the same solver,
 * the same critic, the same exporter — and writes:
 *
 *     build.png   build-front.png   build-top.png
 *     build.stl   build.obj   build.json   build-parts.csv
 *     result.json     ← everything above, plus the numbers, as one object
 *
 * and prints result.json to stdout so the caller does not have to guess
 * where anything went. Exit code 0 means there is an object to look at.
 *
 * The window is hidden rather than absent because three.js needs a real
 * GL context to produce a real image, and Electron already has one. */
function forgeArgs() {
  const a = process.argv;
  const at = a.indexOf('--forge');
  if (at < 0) return null;
  const val = flag => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null;
  };
  const request = (a[at + 1] && !a[at + 1].startsWith('--')) ? a[at + 1] : val('--request');
  if (!request) return null;
  return {
    request,
    out: val('--out') || path.join(app.getPath('temp'), 'workshop-forge'),
    offline: a.includes('--offline'),
    quiet: a.includes('--json'),          // suppress progress, print only the result
    size: Number(val('--size')) || 900
  };
}

function runForge(job) {
  const log = m => { if (!job.quiet) process.stderr.write(`[forge] ${m}\n`); };

  const hidden = new BrowserWindow({
    width: 1000, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      // a hidden window still paints, which is what makes the render real
      offscreen: false, backgroundThrottling: false
    }
  });

  ipcMain.handle('forge:job', () => job);
  ipcMain.on('forge:log', (_e, m) => log(String(m).slice(0, 300)));

  let settled = false;
  const finish = (code, payload) => {
    if (settled) return;
    settled = true;
    if (payload) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    try { hidden.destroy(); } catch { /* already gone */ }
    app.exit(code);
  };

  ipcMain.on('forge:done', (_e, r) => {
    /* The stack comes over with the failure and used to be dropped here,
       which made a headless build the one place in the app where something
       broke and left you nothing to go on. */
    if (!r?.ok) {
      log(`failed: ${r?.error || 'unknown'}`);
      if (r?.stack) log(r.stack);
      return finish(1, { ok: false, error: r?.error || 'build failed', stack: r?.stack });
    }

    try {
      fs.mkdirSync(job.out, { recursive: true });
      const stem = path.join(job.out, 'build');
      const written = {};

      // the pictures come over as data URLs; strip the header and write bytes
      for (const shot of r.shots || []) {
        const file = shot.id === 'iso' ? `${stem}.png` : `${stem}-${shot.id}.png`;
        fs.writeFileSync(file, Buffer.from(String(shot.data).split(',')[1] || '', 'base64'));
        written[shot.id === 'iso' ? 'image' : `image_${shot.id}`] = file;
      }
      /* A kernel build already wrote its STL and STEP where the kernel
         was told to put them; they only need moving next to the pictures.
         STEP is the one that matters — it is real B-rep that opens in
         Fusion as editable geometry, which the primitive path could never
         produce. */
      for (const [kind, src] of Object.entries(r.kernelFiles || {})) {
        if (!['stl', 'step'].includes(kind) || !src || !fs.existsSync(src)) continue;
        const dest = `${stem}.${kind}`;
        try { fs.copyFileSync(src, dest); written[kind] = dest; } catch { /* keep going */ }
      }
      if (r.script) { fs.writeFileSync(`${stem}.py`, r.script, 'utf8'); written.script = `${stem}.py`; }

      if (r.stl) { fs.writeFileSync(`${stem}.stl`, Buffer.from(new Uint8Array(r.stl))); written.stl = `${stem}.stl`; }
      if (r.obj) { fs.writeFileSync(`${stem}.obj`, r.obj, 'utf8'); written.obj = `${stem}.obj`; }
      if (r.bom) { fs.writeFileSync(`${stem}-parts.csv`, r.bom, 'utf8'); written.bom = `${stem}-parts.csv`; }
      fs.writeFileSync(`${stem}.json`, JSON.stringify(r.plan, null, 2));
      written.plan = `${stem}.json`;

      const result = {
        ok: true,
        request: r.request, title: r.title, summary: r.summary,
        note: r.note, engine: r.engine,
        files: written,
        metrics: r.metrics,
        findings: r.findings,
        circuit: r.circuit || undefined,
        /* The engine's own numbers. The renderer works these out and they
           were being dropped here, which made the one thing a caller asking
           for an engine actually wants the one thing it could not read. */
        powerplant: r.powerplant || undefined,
        engineSpec: r.engineSpec || undefined,
        /* Who on the floor built what. When an object comes back wrong the
           first useful question is which trade got it wrong, and a parts
           list cannot answer that. */
        jarvis: r.jarvis,
        crew: r.crew,
        delegation: r.delegation,
        workorder: r.workorder,
        steps: r.steps
      };
      fs.writeFileSync(path.join(job.out, 'result.json'), JSON.stringify(result, null, 2));
      log(`wrote ${Object.keys(written).length} files to ${job.out}`);
      finish(0, result);
    } catch (e) {
      finish(1, { ok: false, error: `could not write the output: ${e.message}` });
    }
  });

  // a build that hangs is worse than one that fails, so it does not hang
  setTimeout(() => finish(1, { ok: false, error: 'timed out after 5 minutes' }), 300_000);

  hidden.webContents.on('render-process-gone', (_e, d) => finish(1, { ok: false, error: `renderer died: ${d.reason}` }));
  hidden.loadFile(path.join(__dirname, 'renderer', 'forge.html'));
  if (process.argv.includes('--dev')) hidden.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  /* --forge means somebody else is driving: no menu, no shop, no robot. */
  const job = forgeArgs();
  if (job) { runForge(job); return; }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
