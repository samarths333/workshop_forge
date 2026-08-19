/* WHERE THE FLOOR'S HEAD COMES FROM.

   The shop used to know about exactly two engines, and it knew about them
   the way a hardcoded thing knows about anything: `callNIM` and `callOllama`,
   two functions, an if/else, and a fallback order typed into an array. Adding
   a third meant a third function and touching the router.

   This is the same shape Jarvis (usejarvis.dev) uses instead: providers are
   DATA. Each one declares where it lives, how it authenticates, how it wants
   a request shaped, how to make it return JSON and where the answer is in the
   reply. Adding a provider is adding a row. The transport is one function in
   main.js that reads the row — the renderer never fetches anything, exactly
   as with the reference lookup.

   Everything here is pure, so the shaping is checked in node: the body a
   provider gets, the JSON-forcing it gets, and which field the text is pulled
   out of are all things that fail silently and expensively if they are wrong.

   FOUR TRANSPORT SHAPES cover every provider worth having. Most of the world
   speaks OpenAI's chat-completions; Anthropic wants its system prompt at the
   top level and has no response_format at all; Gemini wants `contents` and a
   query-string key; Ollama wants a nested options bag. Everything else is
   configuration. */

/* ------------------------------------------------------------------ */
/* forcing JSON out of a model                                         */
/* ------------------------------------------------------------------ */
/* Every call this app makes wants ONE JSON OBJECT back, and it has the schema
   for it. How you ask for that is the single biggest difference between
   providers, and getting it wrong does not error — it returns prose, the
   parse throws, and the build quietly drops to the offline planner. So it is
   named explicitly per provider rather than guessed:

     json_schema  response_format with the schema attached. Strongest.
     json_object  response_format with no schema — the model is told to emit
                  JSON and nothing more. The schema still goes in the prompt.
     tool         no response_format exists (Anthropic). One tool is declared
                  with the schema as its input, and the model is FORCED to
                  call it. The answer is the tool call's arguments.
     gemini       responseMimeType + responseSchema in generationConfig, and
                  the schema has to be stripped down first — see geminiSchema.
     ollama       top-level `format` takes the whole JSON Schema and the
                  decoder is constrained by it. This is why a 3B model is
                  viable locally: it only has to pick sensible values. */
export const JSON_MODES = ['json_schema', 'json_object', 'tool', 'gemini', 'ollama'];

/* ------------------------------------------------------------------ */
/* the catalogue                                                       */
/* ------------------------------------------------------------------ */
export const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    base: 'https://api.anthropic.com',
    chat: '/v1/messages',
    modelsPath: '/v1/models',
    auth: { header: 'x-api-key' },
    headers: { 'anthropic-version': '2023-06-01' },
    json: 'tool',
    needsKey: true,
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    /* These 400 on the PRESENCE of a temperature, not on its value, so the
       key has to be left out entirely rather than set to the default. */
    noTemperature: /claude-(opus-4-[6-9]|sonnet-5|fable-5)/i,
    note: 'No response_format — the schema is forced through a tool call instead. Works with a Claude-compatible gateway too: put the origin in Base and the token in Key, and it switches to bearer auth.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    json: 'json_schema',
    maxKey: 'max_completion_tokens',
    needsKey: true,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    /* Reasoning models and gpt-5 reject a custom temperature outright. */
    noTemperature: /^o\d|^gpt-5(?!-chat)/i,
    note: 'Takes the JSON Schema directly, which is the strongest structured output on the list.'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    chat: '/models/{model}:generateContent',
    modelsPath: '/models',
    /* The only one on the list that puts its credential in the URL. */
    auth: { query: 'key' },
    json: 'gemini',
    needsKey: true,
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    note: 'Its schema dialect is a subset of JSON Schema, so the schema is stripped down on the way out — see geminiSchema.'
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    /* Groq validates a supplied schema server-side and is strict about
       nullability in a way this app's schemas are not written for, so it gets
       the weaker mode and the schema stays in the prompt. */
    json: 'json_object',
    maxKey: 'max_completion_tokens',
    needsKey: true,
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'],
    dropModels: /whisper|orpheus|playai|tts|guard|embed|^groq\/compound/i,
    note: 'The fastest thing on the list by a distance. Rate limited per minute, which a build of six calls can reach.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    headers: { 'HTTP-Referer': 'https://github.com/workshop-forge', 'X-Title': 'Workshop Forge' },
    json: 'json_schema',
    /* max_tokens, NOT max_completion_tokens — OpenRouter did not follow
       OpenAI's rename and silently ignores the newer key. */
    maxKey: 'max_tokens',
    needsKey: true,
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct'],
    note: 'One key, every model, ids are vendor/model. Whether the schema is honoured depends on where it routes.'
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai',
    base: 'https://integrate.api.nvidia.com/v1',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    json: 'json_object',
    maxKey: 'max_tokens',
    needsKey: true,
    keyHint: 'nvapi-…',
    keyUrl: 'https://build.nvidia.com',
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'deepseek-ai/deepseek-v3.2', 'meta/llama-3.3-70b-instruct', 'qwen/qwen3-next-80b-a3b-instruct'],
    note: 'Free developer tier, no card. json_schema support varies per container, so it gets json_object.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'ollama',
    base: 'http://127.0.0.1:11434',
    chat: '/api/chat',
    modelsPath: '/api/tags',
    auth: null,
    json: 'ollama',
    needsKey: false,
    defaultModel: 'llama3.2:3b',
    models: [],
    note: 'Runs on this machine, needs no key, and gets the actual JSON Schema pushed into the decoder — which is why a 3B model is enough here.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    base: 'http://127.0.0.1:1234/v1',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    json: 'json_schema',
    /* Older OpenAI-compatible servers 400 on max_completion_tokens. */
    maxKey: 'max_tokens',
    needsKey: false,
    defaultModel: '',
    models: [],
    note: 'Start the LM Studio server and leave the key blank.'
  },
  {
    id: 'compatible',
    label: 'Any OpenAI-compatible endpoint',
    kind: 'openai',
    base: '',
    chat: '/chat/completions',
    modelsPath: '/models',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    json: 'json_object',
    maxKey: 'max_tokens',
    needsKey: false,
    defaultModel: '',
    models: [],
    note: 'vLLM, llama.cpp, LiteLLM, Together, DeepSeek, Mistral, a company gateway — anything that speaks /chat/completions. Put the full base including /v1 in Base. This is the escape hatch: if a provider is not on this list, it goes here.'
  }
];

export const PROVIDER_IDS = PROVIDERS.map(p => p.id);
const BY_ID = PROVIDERS.reduce((m, p) => (m[p.id] = p, m), {});
export const providerById = id => BY_ID[String(id || '').toLowerCase()] || null;

/* Which ones can answer without a key. Worth knowing on its own: it is the
   answer to "what can this app do with nothing configured". */
export const keylessProviders = () => PROVIDERS.filter(p => !p.needsKey).map(p => p.id);

/* ------------------------------------------------------------------ */
/* tiers — which engine does which job                                 */
/* ------------------------------------------------------------------ */
/* Straight out of Jarvis, and it fits this app better than it fits a chat
   assistant. A build is not one call any more, it is a work order followed by
   five specialist briefs in parallel followed by a critique. Those are not the
   same job:

     high    the work order and the critique. Real reasoning about structure.
             Worth your best model. Two calls a build.
     low     the five specialist briefs. Small, tightly-schema'd, and five of
             them go out at once. Worth your fastest and cheapest.
     medium  everything else — the reflection that turns a build into a skill.

   A tier that is not configured falls UP, so a single-provider setup keeps
   working with no tier wiring at all. */
export const TIERS = ['high', 'medium', 'low'];
export const TIER_FALLBACK = { high: ['medium'], medium: ['high'], low: ['medium', 'high'] };

export const TIER_LABEL = {
  high: 'Hard thinking — the work order and the inspection',
  medium: 'Everything else — reflection, naming, lessons',
  low: 'The five specialist briefs, in parallel'
};

export function resolveTier(requested, tiers = {}) {
  for (const t of [requested, ...(TIER_FALLBACK[requested] || [])]) {
    const a = tiers[t];
    if (a && a.provider) return { tier: t, provider: a.provider, model: a.model || '' };
  }
  return null;
}

/* Who gets which tier. The foreman is the only one on the floor doing a job
   that a small model is genuinely bad at, and the specialists are the ones
   there are several of. */
export const TIER_FOR_ROLE = {
  foreman: 'high',
  structures: 'low',
  softgoods: 'low',
  powerplant: 'low',
  electrical: 'low',
  controls: 'low',
  critic: 'high',
  reflect: 'medium'
};
export const tierForRole = role => TIER_FOR_ROLE[String(role || '').toLowerCase()] || 'medium';

/* ------------------------------------------------------------------ */
/* shaping a request                                                   */
/* ------------------------------------------------------------------ */
const trimBase = s => String(s || '').replace(/\/+$/, '');

export function baseOf(p, cfg = {}) {
  return trimBase(cfg.base || p.base);
}

/* Anthropic is the awkward one: a gateway origin may or may not already
   carry the path, so it is normalised rather than concatenated. */
export function chatUrl(p, cfg = {}, model = '') {
  const base = baseOf(p, cfg);
  if (p.kind === 'anthropic') {
    if (/\/v1\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  return base + p.chat.replace('{model}', encodeURIComponent(model || cfg.model || p.defaultModel));
}

export function modelsUrl(p, cfg = {}) {
  const base = baseOf(p, cfg);
  if (p.kind === 'anthropic') return chatUrl(p, cfg).replace(/\/messages$/, '/models');
  return base + p.modelsPath;
}

/* The credential, wherever this provider wants it. Anthropic switches from
   its own header to bearer the moment it is pointed at a gateway, because
   that is what every Claude-compatible gateway expects. */
export function authFor(p, cfg = {}) {
  const key = String(cfg.key || '');
  const headers = { 'Content-Type': 'application/json', ...(p.headers || {}) };
  let query = null;
  if (!p.auth || !key) return { headers, query };

  if (p.kind === 'anthropic') {
    const custom = baseOf(p, cfg) !== trimBase(p.base);
    if (custom) headers.Authorization = `Bearer ${key}`;
    else headers['x-api-key'] = key;
    return { headers, query };
  }
  if (p.auth.query) return { headers, query: { [p.auth.query]: key } };
  headers[p.auth.header] = `${p.auth.prefix || ''}${key}`;
  return { headers, query };
}

const isSystem = m => m.role === 'system';

/* Gemini's responseSchema is an OpenAPI subset, not JSON Schema. Left as-is
   it 400s on the keys this app's schemas actually use. Anything it does not
   understand is dropped rather than translated — a slightly looser schema
   still constrains the decoder, and a 400 constrains nothing. */
export function geminiSchema(schema) {
  const walk = s => {
    if (!s || typeof s !== 'object') return s;
    if (Array.isArray(s)) return s.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (['$schema', 'additionalProperties', '$ref', 'oneOf', 'anyOf', 'allOf', 'default', 'strict'].includes(k)) continue;
      out[k] = (k === 'properties')
        ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]))
        : walk(v);
    }
    return out;
  };
  return walk(schema);
}

/* Whether this model will refuse a temperature. Both families that do it
   reject the KEY, not the value, so it has to be omitted. */
export function takesTemperature(p, model) {
  return !(p.noTemperature && p.noTemperature.test(String(model || '')));
}

/* The whole request body, for whichever of the four shapes this provider
   speaks. `maxTokens` matters more than it looks: Ollama's default cap is
   128 tokens, which truncates every structured reply this app asks for and
   throws in the parser instead of anywhere legible. */
export function buildBody(p, { model, messages, schema, temperature = 0.7, maxTokens = 2600 } = {}) {
  const m = model || p.defaultModel;
  const temp = takesTemperature(p, m) ? temperature : undefined;

  if (p.kind === 'anthropic') {
    const system = messages.filter(isSystem).map(x => x.content).join('\n\n');
    const body = {
      model: m,
      max_tokens: maxTokens,
      messages: messages.filter(x => !isSystem(x)).map(x => ({ role: x.role, content: x.content }))
    };
    if (system) body.system = [{ type: 'text', text: system }];
    if (temp !== undefined) body.temperature = temp;
    /* No response_format exists here. One tool, the schema as its input, and
       the model is given no choice but to call it. */
    if (schema) {
      body.tools = [{ name: 'emit', description: 'Return the answer as a single object matching the schema.', input_schema: schema }];
      body.tool_choice = { type: 'tool', name: 'emit' };
    }
    return body;
  }

  if (p.kind === 'gemini') {
    const system = messages.filter(isSystem).map(x => x.content).join('\n\n');
    const gen = { maxOutputTokens: maxTokens };
    if (temp !== undefined) gen.temperature = temp;
    if (schema) { gen.responseMimeType = 'application/json'; gen.responseSchema = geminiSchema(schema); }
    const body = {
      contents: messages.filter(x => !isSystem(x)).map(x => ({
        role: x.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(x.content) }]
      })),
      generationConfig: gen
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  }

  if (p.kind === 'ollama') {
    const body = {
      model: m,
      messages,
      stream: false,
      /* num_predict is the one that matters. Ollama defaults it to 128 —
         nothing this app asks for fits in 128 tokens, so without this every
         reply arrives truncated mid-object and the parse fails with a
         message that says nothing about why. */
      options: { temperature, num_ctx: 8192, num_predict: maxTokens }
    };
    if (schema) body.format = schema;
    return body;
  }

  // OpenAI-shaped: the majority of the world
  const body = { model: m, messages };
  body[p.maxKey || 'max_tokens'] = maxTokens;
  if (temp !== undefined) body.temperature = temp;
  if (schema && p.json === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'reply', strict: false, schema } };
  } else if (p.json === 'json_object' || (schema && p.json === 'json_schema')) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/* Where the answer is. Four shapes again, plus the one case that is not a
   message at all: a forced tool call, whose arguments ARE the object. */
export function extractText(p, json) {
  if (p.kind === 'anthropic') {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const tool = blocks.find(b => b?.type === 'tool_use' && b.input);
    if (tool) return JSON.stringify(tool.input);
    return blocks.filter(b => b?.type === 'text').map(b => b.text).join('');
  }
  if (p.kind === 'gemini') {
    const parts = json?.candidates?.[0]?.content?.parts || [];
    return parts.map(x => x?.text || '').join('');
  }
  if (p.kind === 'ollama') return json?.message?.content || '';
  return json?.choices?.[0]?.message?.content || '';
}

export function modelsFrom(p, json) {
  let ids = [];
  if (p.kind === 'gemini') ids = (json?.models || []).map(m => String(m.name || '').replace('models/', ''));
  else if (p.kind === 'ollama') ids = (json?.models || []).map(m => m.name);
  else ids = (json?.data || []).map(m => m.id);
  ids = ids.filter(Boolean).filter(id => !(p.dropModels && p.dropModels.test(id)));
  return [...new Set(ids)].sort();
}

/* ------------------------------------------------------------------ */
/* what went wrong                                                     */
/* ------------------------------------------------------------------ */
/* An exact port of Jarvis's classifier, and the reason to bother is the
   difference between "your key is wrong" and "the service is down". The old
   shop reported both as `HTTP 401` in a log line nobody reads, and a build
   just went quiet. */
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 498) return 'network';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 502 || status === 503 || status === 504) return 'network';
  if (status >= 500) return 'server';
  return 'unknown';
}

export const ERROR_HELP = {
  auth: 'the key was rejected — check it is pasted whole and has not expired',
  rate_limit: 'rate limited — a build makes six calls, so a per-minute cap is easy to hit',
  network: 'could not reach it — check the base URL, or that the local server is running',
  bad_request: 'the request was refused — usually the model name, or a model that will not do structured output',
  not_found: 'no such model or endpoint at that address',
  server: 'the provider is having a bad time; try the next one in the chain',
  unknown: 'unclear — the message from the provider is above'
};

/* Retry-After, in either of the two forms the spec allows. */
export function retryAfterMs(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

/* What a fresh install looks like, and the migration off the old two-engine
   settings. Nobody's key gets dropped on the floor because the app grew a
   provider list. */
export function defaultProviderConfig() {
  const out = {};
  for (const p of PROVIDERS) out[p.id] = { key: '', model: p.defaultModel, base: '' };
  return out;
}

export function migrateConfig(cfg = {}) {
  const providers = { ...defaultProviderConfig(), ...(cfg.providers || {}) };

  /* The old value wins over the SHIPPED DEFAULT, but not over an entry the
     person has already set in the new table. `||` is the wrong operator here
     and was quietly wrong for exactly one reason: defaultProviderConfig has
     already filled `model` in with the app's default, so nothing ever falls
     through it and the saved model was dropped every time. */
  const take = (id, field, value, shippedDefault) => {
    if (!value) return;
    const cur = providers[id][field];
    if (!cur || cur === shippedDefault) providers[id][field] = value;
  };
  const def = id => providerById(id)?.defaultModel || '';

  if (cfg.nimKey) take('nvidia', 'key', cfg.nimKey, '');
  take('nvidia', 'model', cfg.nimModel, def('nvidia'));
  if (cfg.nimBase && cfg.nimBase !== providerById('nvidia').base) take('nvidia', 'base', cfg.nimBase, '');
  take('ollama', 'model', cfg.ollamaModel, def('ollama'));
  if (cfg.ollamaBase && !/127\.0\.0\.1:11434|localhost:11434/.test(cfg.ollamaBase)) take('ollama', 'base', cfg.ollamaBase, '');

  /* The chain is the old `provider` setting generalised. "auto" used to mean
     NIM then Ollama; it now means "everything that is configured, best
     first", which is the same thing when only those two are. */
  let chain = Array.isArray(cfg.chain) && cfg.chain.length ? cfg.chain.filter(providerById) : null;
  if (!chain) {
    chain = cfg.provider === 'nim' ? ['nvidia']
      : cfg.provider === 'ollama' ? ['ollama']
        : cfg.provider === 'offline' ? []
          : ['nvidia', 'ollama'];
  }
  const tiers = cfg.tiers && typeof cfg.tiers === 'object' ? cfg.tiers : {};
  return { providers, chain, tiers };
}

/* Which providers could actually answer right now, in chain order. A provider
   with no key and no keyless mode is not "configured badly", it is simply not
   set up, and it should not appear in a failure list as if it were broken. */
export function usableChain({ providers = {}, chain = [] } = {}) {
  return chain.filter(id => {
    const p = providerById(id);
    if (!p) return false;
    const c = providers[id] || {};
    if (p.needsKey && !c.key) return false;
    if (!p.base && !c.base) return false;          // the generic one needs an address
    return true;
  });
}

/* The order to try for one job: the tier's own provider first, then the rest
   of the chain behind it. A tier assignment is a preference, not a promise —
   if your best model is down the build still happens on whatever is up. */
export function routeFor(role, cfg = {}) {
  const usable = usableChain(cfg);
  const want = resolveTier(tierForRole(role), cfg.tiers || {});
  if (want && usable.includes(want.provider)) {
    return [{ provider: want.provider, model: want.model, tier: tierForRole(role) }]
      .concat(usable.filter(id => id !== want.provider).map(id => ({ provider: id, model: '' })));
  }
  return usable.map(id => ({ provider: id, model: '' }));
}

/* One line describing what answered, for the badge. */
export function engineLabel(providerId, model) {
  const p = providerById(providerId);
  return `${p ? p.label : providerId}${model ? ` · ${model}` : ''}`;
}
