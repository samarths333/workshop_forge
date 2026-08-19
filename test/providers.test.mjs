/* The engines.

   Everything in providers.js fails SILENTLY when it is wrong. A request body
   with the wrong max-tokens key gets a 400 the user reads as "the model is
   broken". A response read from the wrong field comes back empty and the
   build drops to the offline planner with no explanation. Forcing JSON the
   wrong way for a provider returns prose, the parse throws, and the shop
   quietly builds from keywords instead. None of it crashes; all of it makes
   the app worse in a way that looks like the model being bad.

   So the shaping is asserted field by field, per provider, against what each
   API actually documents — and the two cases that have already cost real
   builds get their own checks:

     · Ollama's num_predict defaults to 128 tokens. Every structured reply
       this app asks for is longer than that, so without it the JSON arrives
       truncated mid-object, every time, on the one provider that needs no key.
     · A temperature sent to a reasoning model is a 400 on the PRESENCE of
       the key, not its value, so it has to be absent rather than default.

     node test/providers.test.mjs
*/
import {
  PROVIDERS, PROVIDER_IDS, providerById, keylessProviders,
  TIERS, TIER_FALLBACK, TIER_FOR_ROLE, resolveTier, tierForRole,
  chatUrl, modelsUrl, authFor, buildBody, extractText, modelsFrom,
  geminiSchema, takesTemperature, classifyHttpStatus, ERROR_HELP, retryAfterMs,
  defaultProviderConfig, migrateConfig, usableChain, routeFor, engineLabel, JSON_MODES
} from '../renderer/providers.js';
import { PLAN_SCHEMA } from '../renderer/agent.js';
import { ORDER_SCHEMA } from '../renderer/workorder.js';
import { CREW } from '../renderer/roles.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const MSGS = [
  { role: 'system', content: 'You are the floor manager.' },
  { role: 'user', content: 'Build request: a desk lamp' }
];
const SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

/* ------------------------------------------------------------------ */
/* the catalogue                                                       */
/* ------------------------------------------------------------------ */
check('every provider in the table is complete enough to call', () => {
  assert(PROVIDERS.length >= 6, `only ${PROVIDERS.length} providers`);
  for (const p of PROVIDERS) {
    assert(p.id && p.label, 'a provider has no id or label');
    assert(['openai', 'anthropic', 'gemini', 'ollama'].includes(p.kind), `${p.id} speaks "${p.kind}", which nothing implements`);
    assert(JSON_MODES.includes(p.json), `${p.id} forces JSON with "${p.json}", which nothing implements`);
    assert(p.chat, `${p.id} has no chat path`);
    assert(p.modelsPath, `${p.id} has no models path`);
    assert(typeof p.needsKey === 'boolean', `${p.id} does not say whether it needs a key`);
    if (p.needsKey) assert(p.keyUrl, `${p.id} needs a key and does not say where to get one`);
    assert(p.note || !p.needsKey, `${p.id} has nothing to say about itself`);
  }
  assert(new Set(PROVIDER_IDS).size === PROVIDER_IDS.length, 'two providers share an id');
  assert(providerById('OpenAI') === providerById('openai'), 'lookup is case sensitive');
  assert(providerById('nope') === null, 'an unknown provider resolves to something');
});

check('the app can still do something with no key at all', () => {
  const free = keylessProviders();
  assert(free.includes('ollama'), 'the local engine needs a key now');
  assert(free.length >= 2, `only ${free.length} providers work without a key`);
  // and the escape hatch exists, because the list will always be missing somebody
  const any = providerById('compatible');
  assert(any && !any.needsKey, 'there is no generic OpenAI-compatible option');
  assert(any.base === '', 'the generic option ships with somebody else’s address in it');
});

/* ------------------------------------------------------------------ */
/* addresses and credentials                                           */
/* ------------------------------------------------------------------ */
check('every provider is called at the address its API documents', () => {
  const u = (id, cfg = {}, model = 'M') => chatUrl(providerById(id), cfg, model);
  assert(u('openai') === 'https://api.openai.com/v1/chat/completions', u('openai'));
  assert(u('groq') === 'https://api.groq.com/openai/v1/chat/completions', u('groq'));
  assert(u('openrouter') === 'https://openrouter.ai/api/v1/chat/completions', u('openrouter'));
  assert(u('nvidia') === 'https://integrate.api.nvidia.com/v1/chat/completions', u('nvidia'));
  assert(u('ollama') === 'http://127.0.0.1:11434/api/chat', u('ollama'));
  assert(u('anthropic') === 'https://api.anthropic.com/v1/messages', u('anthropic'));
  // gemini puts the model in the path, and it has to be escaped
  assert(u('gemini', {}, 'gemini-2.5-flash').endsWith('/models/gemini-2.5-flash:generateContent'), u('gemini', {}, 'gemini-2.5-flash'));

  // a trailing slash on a custom base must not produce a double slash
  assert(u('openai', { base: 'https://gw.example.com/v1/' }) === 'https://gw.example.com/v1/chat/completions',
    u('openai', { base: 'https://gw.example.com/v1/' }));

  /* Anthropic gateways are handed round in three different shapes and all
     three have to land on the same endpoint. */
  assert(u('anthropic', { base: 'https://gw.co' }) === 'https://gw.co/v1/messages', 'bare origin');
  assert(u('anthropic', { base: 'https://gw.co/v1' }) === 'https://gw.co/v1/messages', 'origin with /v1');
  assert(u('anthropic', { base: 'https://gw.co/v1/messages' }) === 'https://gw.co/v1/messages', 'full path');
  assert(modelsUrl(providerById('anthropic'), { base: 'https://gw.co' }) === 'https://gw.co/v1/models', 'models path');
});

check('the credential goes where each provider expects it, and nowhere else', () => {
  const a = authFor(providerById('openai'), { key: 'sk-1' });
  assert(a.headers.Authorization === 'Bearer sk-1', JSON.stringify(a.headers));
  assert(!a.query, 'openai grew a query credential');

  const g = authFor(providerById('gemini'), { key: 'AIza1' });
  assert(g.query && g.query.key === 'AIza1', 'gemini key is not in the query string');
  assert(!g.headers.Authorization, 'gemini also sent a bearer header');

  const c = authFor(providerById('anthropic'), { key: 'sk-ant' });
  assert(c.headers['x-api-key'] === 'sk-ant', 'anthropic is not using x-api-key');
  assert(c.headers['anthropic-version'] === '2023-06-01', 'the required version header is missing');
  assert(!c.headers.Authorization, 'anthropic sent a bearer header at its own endpoint');

  /* Pointed at a gateway it has to switch to bearer — every Claude-compatible
     gateway wants the token that way and rejects x-api-key. */
  const gw = authFor(providerById('anthropic'), { key: 'tok', base: 'https://gw.co' });
  assert(gw.headers.Authorization === 'Bearer tok', 'a gateway did not get bearer auth');
  assert(!gw.headers['x-api-key'], 'a gateway also got x-api-key');

  const or = authFor(providerById('openrouter'), { key: 'k' });
  assert(or.headers['HTTP-Referer'] && or.headers['X-Title'], 'openrouter is missing its attribution headers');

  // no key, no credential header — and never the string "undefined"
  for (const p of PROVIDERS) {
    const h = authFor(p, {}).headers;
    for (const [k, v] of Object.entries(h)) {
      assert(!/undefined|null/.test(String(v)), `${p.id} sends ${k}: ${v} with no key set`);
    }
  }
  assert(!authFor(providerById('ollama'), { key: 'x' }).headers.Authorization, 'the local engine sends a credential');
});

/* ------------------------------------------------------------------ */
/* the body                                                            */
/* ------------------------------------------------------------------ */
check('an OpenAI-shaped body uses the max-tokens key that provider accepts', () => {
  /* OpenAI renamed it and most of the ecosystem did not follow. Sending the
     wrong one is a 400 on some and a silently ignored cap on others — which
     is worse, because the reply then runs long and costs money. */
  const openai = buildBody(providerById('openai'), { model: 'gpt-4.1-mini', messages: MSGS, schema: SCHEMA });
  assert(openai.max_completion_tokens > 0, 'openai did not get max_completion_tokens');
  assert(openai.max_tokens === undefined, 'openai also got the old key');

  const orouter = buildBody(providerById('openrouter'), { model: 'x', messages: MSGS, schema: SCHEMA });
  assert(orouter.max_tokens > 0, 'openrouter did not get max_tokens');
  assert(orouter.max_completion_tokens === undefined, 'openrouter got the key it ignores');

  const lm = buildBody(providerById('lmstudio'), { model: 'x', messages: MSGS });
  assert(lm.max_tokens > 0, 'a local OpenAI-compatible server got the newer key it will refuse');
});

check('JSON is forced the way each provider actually supports', () => {
  const oa = buildBody(providerById('openai'), { model: 'gpt-4.1', messages: MSGS, schema: SCHEMA });
  assert(oa.response_format?.type === 'json_schema', JSON.stringify(oa.response_format));
  assert(oa.response_format.json_schema.schema === SCHEMA, 'the schema did not reach the request');

  const nv = buildBody(providerById('nvidia'), { model: 'x', messages: MSGS, schema: SCHEMA });
  assert(nv.response_format?.type === 'json_object', JSON.stringify(nv.response_format));

  /* Anthropic has no response_format at all. A forced tool call is the only
     way to make it return an object, and the tool has to be REQUIRED — an
     optional one gets ignored about a third of the time. */
  const an = buildBody(providerById('anthropic'), { model: 'claude-sonnet-4-5', messages: MSGS, schema: SCHEMA });
  assert(!an.response_format, 'anthropic was sent a response_format it does not have');
  assert(an.tools?.[0]?.input_schema === SCHEMA, 'the schema is not on the tool');
  assert(an.tools[0].name === 'emit' && an.tool_choice?.name === 'emit', 'the tool is not forced');
  assert(an.tool_choice.type === 'tool', 'tool_choice is not a forced call');

  const gm = buildBody(providerById('gemini'), { model: 'gemini-2.5-flash', messages: MSGS, schema: SCHEMA });
  assert(gm.generationConfig?.responseMimeType === 'application/json', 'gemini was not asked for JSON');
  assert(gm.generationConfig.responseSchema, 'gemini got no schema');

  const ol = buildBody(providerById('ollama'), { model: 'llama3.2:3b', messages: MSGS, schema: SCHEMA });
  assert(ol.format === SCHEMA, 'ollama did not get the schema in `format`');
  assert(ol.stream === false, 'ollama was asked to stream');
});

check('Ollama is told how long the answer may be', () => {
  /* THE ONE THAT ACTUALLY BIT. Ollama caps generation at 128 tokens unless
     told otherwise. Every schema in this app produces a reply longer than
     that, so the JSON arrived cut off mid-object, the parse threw, and the
     build fell back to keywords — on the one provider that needs no key and
     is therefore the one most people were using. */
  const b = buildBody(providerById('ollama'), { model: 'x', messages: MSGS, schema: SCHEMA, maxTokens: 3200 });
  assert(b.options?.num_predict === 3200, `num_predict is ${b.options?.num_predict} — 128 is the default and it truncates every reply`);
  assert(b.options.num_ctx >= 8192, 'the context window is too small for the prompts this app sends');
});

check('a model that refuses a temperature is not sent one', () => {
  /* Both families 400 on the KEY being present, not on the value, so a
     "safe default" is exactly as broken as a weird one. */
  assert(!takesTemperature(providerById('openai'), 'o4-mini'), 'a reasoning model was offered a temperature');
  assert(!takesTemperature(providerById('openai'), 'gpt-5'), 'gpt-5 was offered a temperature');
  assert(takesTemperature(providerById('openai'), 'gpt-5-chat'), 'gpt-5-chat refuses one and should not');
  assert(takesTemperature(providerById('openai'), 'gpt-4.1'), 'a normal model was denied a temperature');

  const o = buildBody(providerById('openai'), { model: 'o4-mini', messages: MSGS, temperature: 0.7 });
  assert(!('temperature' in o), 'the key is present — it is the presence that 400s, not the value');
  const n = buildBody(providerById('openai'), { model: 'gpt-4.1', messages: MSGS, temperature: 0.3 });
  assert(n.temperature === 0.3, 'a normal model lost its temperature');
});

check('the system prompt goes where each provider keeps it', () => {
  const oa = buildBody(providerById('openai'), { model: 'x', messages: MSGS });
  assert(oa.messages.length === 2 && oa.messages[0].role === 'system', 'openai lost the system message');

  const an = buildBody(providerById('anthropic'), { model: 'x', messages: MSGS });
  assert(Array.isArray(an.system) && /floor manager/.test(an.system[0].text), 'anthropic system prompt is missing');
  assert(an.messages.every(m => m.role !== 'system'), 'anthropic got a system message in the array, which it rejects');
  assert(an.max_tokens > 0, 'anthropic requires max_tokens and did not get one');

  const gm = buildBody(providerById('gemini'), { model: 'x', messages: MSGS });
  assert(/floor manager/.test(gm.systemInstruction?.parts?.[0]?.text || ''), 'gemini systemInstruction is missing');
  assert(gm.contents.every(c => c.role !== 'system'), 'gemini got a system role it does not have');
  assert(gm.contents[0].role === 'user' && gm.contents[0].parts[0].text, 'gemini contents are malformed');
  // assistant → model, which is the only rename gemini needs
  const gm2 = buildBody(providerById('gemini'), { model: 'x', messages: [{ role: 'assistant', content: 'hi' }] });
  assert(gm2.contents[0].role === 'model', 'gemini got role "assistant", which it rejects');
});

check('Gemini gets a schema in the dialect it actually parses', () => {
  /* responseSchema is an OpenAPI subset. The real schemas in this app carry
     keys it 400s on, and a 400 constrains nothing at all — a slightly looser
     schema still constrains the decoder. */
  const dirty = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { type: 'string' },
      b: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      c: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { d: { type: 'string' } } } }
    },
    required: ['a']
  };
  const clean = JSON.stringify(geminiSchema(dirty));
  for (const bad of ['$schema', 'additionalProperties', 'oneOf']) {
    assert(!clean.includes(bad), `"${bad}" survived into the gemini schema`);
  }
  assert(clean.includes('"required"') && clean.includes('"properties"'), 'the useful half was stripped too');
  assert(geminiSchema(dirty).properties.c.items.properties.d.type === 'string', 'nested properties were flattened');

  // and the app's real schemas survive the trip
  for (const [name, sch] of [['plan', PLAN_SCHEMA], ['order', ORDER_SCHEMA]]) {
    const g = JSON.stringify(geminiSchema(sch));
    assert(!/\$schema|additionalProperties|oneOf|anyOf/.test(g), `${name} still carries a key gemini rejects`);
    assert(g.length > 100, `${name} was stripped to nothing`);
  }
});

/* ------------------------------------------------------------------ */
/* reading the reply                                                   */
/* ------------------------------------------------------------------ */
check('the answer is read out of the field each provider puts it in', () => {
  assert(extractText(providerById('openai'), { choices: [{ message: { content: '{"a":1}' } }] }) === '{"a":1}', 'openai');
  assert(extractText(providerById('ollama'), { message: { content: '{"a":1}' } }) === '{"a":1}', 'ollama');
  assert(extractText(providerById('gemini'),
    { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] }) === '{"a":1}', 'gemini parts are not joined');
  assert(extractText(providerById('anthropic'),
    { content: [{ type: 'text', text: 'hello' }] }) === 'hello', 'anthropic text');

  /* The forced tool call is not a message — the object IS the arguments, and
     reading `.text` off it gives an empty string and a build that quietly
     goes offline. */
  const tool = extractText(providerById('anthropic'),
    { content: [{ type: 'text', text: 'here you go' }, { type: 'tool_use', name: 'emit', input: { title: 'lamp' } }] });
  assert(JSON.parse(tool).title === 'lamp', `a forced tool call came back as ${tool}`);

  // an empty reply must read as empty, not throw
  for (const p of PROVIDERS) assert(typeof extractText(p, {}) === 'string', `${p.id} throws on an empty reply`);
});

check('a model list is read, deduped and filtered', () => {
  assert(modelsFrom(providerById('openai'), { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }).join() === 'a,b', 'openai list');
  assert(modelsFrom(providerById('ollama'), { models: [{ name: 'llama3.2:3b' }] }).join() === 'llama3.2:3b', 'ollama list');
  assert(modelsFrom(providerById('gemini'), { models: [{ name: 'models/gemini-2.5-flash' }] }).join() === 'gemini-2.5-flash',
    'gemini ids keep their models/ prefix');
  // groq's catalogue is full of things that are not chat models
  const groq = modelsFrom(providerById('groq'), { data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }] });
  assert(groq.join() === 'llama-3.3-70b-versatile', `groq offered ${groq.join()}`);
});

/* ------------------------------------------------------------------ */
/* what went wrong                                                     */
/* ------------------------------------------------------------------ */
check('a failure is classified into something a person can act on', () => {
  const cases = [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [498, 'network'], [404, 'not_found'],
    [400, 'bad_request'], [422, 'bad_request'], [503, 'network'], [500, 'server'], [418, 'unknown']];
  for (const [status, code] of cases) {
    assert(classifyHttpStatus(status) === code, `${status} classified as ${classifyHttpStatus(status)}, expected ${code}`);
  }
  for (const code of new Set(cases.map(c => c[1]))) {
    assert(ERROR_HELP[code] && ERROR_HELP[code].length > 10, `"${code}" has nothing to tell the user`);
  }
});

check('Retry-After is read in both the forms the spec allows', () => {
  assert(retryAfterMs('30') === 30000, `seconds: ${retryAfterMs('30')}`);
  assert(retryAfterMs('0') === 0, 'zero seconds');
  assert(retryAfterMs(null) === null, 'a missing header');
  assert(retryAfterMs('nonsense') === null, 'garbage');
  const soon = new Date(Date.now() + 20000).toUTCString();
  const ms = retryAfterMs(soon);
  assert(ms > 15000 && ms < 25000, `an HTTP-date came back as ${ms}`);
});

/* ------------------------------------------------------------------ */
/* tiers and routing                                                   */
/* ------------------------------------------------------------------ */
check('an unconfigured tier falls up instead of failing', () => {
  const only = { medium: { provider: 'openai' } };
  assert(resolveTier('high', only).provider === 'openai', 'high did not fall up to medium');
  assert(resolveTier('low', only).provider === 'openai', 'low did not fall up');
  assert(resolveTier('medium', only).tier === 'medium', 'medium did not resolve to itself');
  assert(resolveTier('high', {}) === null, 'an empty tier map resolved to something');

  // every tier's chain must terminate, or a lookup loops
  for (const t of TIERS) {
    assert(Array.isArray(TIER_FALLBACK[t]), `${t} has no fallback chain`);
    assert(!TIER_FALLBACK[t].includes(t), `${t} falls up to itself`);
  }
});

check('the trades that there are four of get the cheap tier', () => {
  /* This is the whole point of tiering here. Two calls a build need real
     reasoning; four go out at once and are tightly schema'd. Paying frontier
     prices for the four is the expensive mistake. */
  assert(tierForRole('foreman') === 'high', 'the work order is not on the good model');
  assert(tierForRole('critic') === 'high', 'the inspection is not on the good model');
  for (const r of ['structures', 'softgoods', 'powerplant', 'electrical', 'controls']) {
    assert(tierForRole(r) === 'low', `${r} is not on the cheap tier`);
  }
  assert(tierForRole('nobody') === 'medium', 'an unknown caller does not land somewhere sane');
  // and every robot on the floor has a tier, or its calls are unrouted
  for (const role of CREW) assert(TIER_FOR_ROLE[role.id], `${role.id} has no tier`);
});

check('a provider with no key is not offered as if it were broken', () => {
  const cfg = {
    providers: { openai: { key: 'k' }, anthropic: { key: '' }, ollama: {}, compatible: {} },
    chain: ['anthropic', 'openai', 'ollama', 'compatible', 'nope']
  };
  const usable = usableChain(cfg);
  assert(usable.includes('openai'), 'a configured provider was dropped');
  assert(usable.includes('ollama'), 'the keyless local engine was dropped');
  assert(!usable.includes('anthropic'), 'a provider with an empty key is in the chain');
  assert(!usable.includes('compatible'), 'the generic provider with no address is in the chain');
  assert(!usable.includes('nope'), 'a provider that does not exist is in the chain');
  assert(usableChain({}).length === 0, 'an empty config produced a chain');
});

check('a tier assignment is a preference, not a single point of failure', () => {
  const cfg = {
    providers: { openai: { key: 'k' }, groq: { key: 'k' }, ollama: {} },
    chain: ['openai', 'groq', 'ollama'],
    tiers: { high: { provider: 'openai', model: 'gpt-4.1' }, low: { provider: 'groq' } }
  };
  const foreman = routeFor('foreman', cfg);
  assert(foreman[0].provider === 'openai' && foreman[0].model === 'gpt-4.1', `the foreman went to ${JSON.stringify(foreman[0])}`);
  assert(foreman.length === 3, 'the rest of the chain is not behind the tier');
  assert(!foreman.slice(1).some(h => h.provider === 'openai'), 'the tier provider appears twice in the route');

  const spec = routeFor('softgoods', cfg);
  assert(spec[0].provider === 'groq', `a specialist went to ${spec[0].provider}`);

  /* A tier pointing at something not in the chain must not strand the call. */
  const stale = routeFor('foreman', { ...cfg, tiers: { high: { provider: 'anthropic' } } });
  assert(stale.length === 3 && stale[0].provider === 'openai', 'a stale tier assignment stranded the route');
  assert(routeFor('foreman', {}).length === 0, 'an unconfigured app produced a route');
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
check('an existing settings file keeps its key', () => {
  /* Growing a provider table is not a reason to make somebody re-paste the
     key they set up months ago. */
  const old = {
    provider: 'auto', nimKey: 'nvapi-xyz', nimModel: 'openai/gpt-oss-120b',
    nimBase: 'https://integrate.api.nvidia.com/v1',
    ollamaModel: 'qwen2.5:7b', ollamaBase: 'http://127.0.0.1:11434'
  };
  const m = migrateConfig(old);
  assert(m.providers.nvidia.key === 'nvapi-xyz', 'the NIM key was dropped');
  assert(m.providers.ollama.model === 'qwen2.5:7b', 'the Ollama model was dropped');
  assert(m.chain.join() === 'nvidia,ollama', `chain came out as ${m.chain.join()}`);
  assert(!m.providers.nvidia.base, 'the default base was written in as an override');

  assert(migrateConfig({ provider: 'ollama' }).chain.join() === 'ollama', 'ollama-only did not migrate');
  assert(migrateConfig({ provider: 'offline' }).chain.length === 0, 'offline-only did not migrate');
  // and a config that has already migrated is left alone
  const twice = migrateConfig(m);
  assert(twice.chain.join() === m.chain.join() && twice.providers.nvidia.key === 'nvapi-xyz', 'migrating twice changed it');

  const fresh = defaultProviderConfig();
  for (const p of PROVIDERS) assert(fresh[p.id], `${p.id} has no default config entry`);
  assert(Object.values(fresh).every(v => v.key === ''), 'a default config ships with a key in it');
});

check('the badge says what actually answered', () => {
  assert(engineLabel('openai', 'gpt-4.1-mini') === 'OpenAI · gpt-4.1-mini', engineLabel('openai', 'gpt-4.1-mini'));
  assert(engineLabel('ollama', '') === 'Ollama (local)', engineLabel('ollama', ''));
  assert(engineLabel('mystery', 'x') === 'mystery · x', 'an unknown provider breaks the badge');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
