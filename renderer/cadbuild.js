/* ------------------------------------------------------------------ *
 * cadbuild.js — write the script, run it, read the traceback, try again
 * ------------------------------------------------------------------ *
 *
 * The loop that makes the kernel worth having.
 *
 * Everywhere else in this shop, the correction signal is a model looking
 * at a description of its own work and being asked whether it looks
 * right. That is a weak signal and it knows it — a model that produced a
 * bad part will happily describe it as a good one.
 *
 * Here the signal is a KERNEL EXCEPTION. `fillet()` with a radius larger
 * than the edge it is applied to does not come out slightly wrong, it
 * raises, and the traceback names the operation and the reason. Feeding
 * that back is not a critique, it is a compiler error, and models are
 * enormously better at fixing those than at re-evaluating their own
 * judgement.
 *
 * The order of the loop is the whole design:
 *
 *     gate  →  run  →  check  →  repair
 *      ↑                            │
 *      └────────────────────────────┘
 *
 * GATE FIRST, and this is the part ADA's version does not have. A static
 * refusal costs nothing — no process, no kernel, no seconds — and it
 * catches the whole class of "the model imported os" without spending a
 * round trip. Only scripts that pass ever reach a Python interpreter.
 *
 * CHECK AFTER, because a script that runs is not a script that worked.
 * An empty compound, a part four metres across, a shell that never
 * closed — all of them exit zero. `checkSolid` asks whether the thing is
 * actually a part, and a fault there goes back round the loop exactly
 * like a traceback does.
 *
 * Takes `ask` and `run` as arguments and imports only the pure gate, so
 * the entire loop can be driven in node against a scripted model and a
 * scripted kernel. Every branch below is tested that way.
 */
import {
  gateScript, cadSystemPrompt, cadUserPrompt, repairPrompt, checkSolid
} from './cadscript.js';

/* Three attempts. Past that it is not a fixable mistake — it is a model
   that cannot do this part, and four more seconds of trying is four
   seconds nobody gets back. The primitive path is still there. */
export const MAX_ATTEMPTS = 3;

/* ------------------------------------------------------------------ */
/* one pass                                                            */
/* ------------------------------------------------------------------ */
/*   ask(messages, schema, role)  → { ok, text, engine }   the model
 *   run(code, { stem })          → { ok, metrics, files, mesh, ... }  the kernel
 *   log(line)                    → progress, optional
 */
export async function buildWithKernel(request, {
  ask, run, log = () => {}, recalled = null, refs = [], read = [], stem = 'part',
  attempts = MAX_ATTEMPTS
} = {}) {
  const history = [];
  let messages = [
    { role: 'system', content: cadSystemPrompt() },
    { role: 'user', content: cadUserPrompt(request, { recalled, refs, read }) }
  ];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await ask(messages, null, 'cad');
    if (!res?.ok) {
      history.push({ attempt, stage: 'model', problem: 'no engine answered' });
      return done(false, 'no engine answered — nothing to run', history);
    }

    /* --- the gate. Free, and it runs before anything is executed. --- */
    const gate = gateScript(res.text);
    if (!gate.ok) {
      const problem = `The script was refused before it could run:\n  · ${gate.reasons.join('\n  · ')}`;
      log(`attempt ${attempt}: refused — ${gate.reasons[0]}`);
      history.push({ attempt, stage: 'gate', problem: gate.reasons.join('; ') });
      messages = repairTurn(messages, res.text, problem, request);
      continue;
    }

    /* --- the kernel. This is the part that costs a process. --------- */
    let out;
    try {
      out = await run(gate.code, { stem: `${stem}-${attempt}` });
    } catch (e) {
      out = { ok: false, stage: 'kernel', error: String(e?.message || e) };
    }

    if (!out?.ok) {
      const problem = out?.traceback || out?.error || 'the kernel gave no reason';
      log(`attempt ${attempt}: ${out?.stage || 'failed'} — ${String(out?.error || '').slice(0, 90)}`);
      history.push({ attempt, stage: out?.stage || 'execute', problem: String(out?.error || '').slice(0, 200) });
      messages = repairTurn(messages, gate.code, problem, request);
      continue;
    }

    /* --- it ran. Did it make a part? -------------------------------- */
    const findings = checkSolid(out.metrics);
    const faults = findings.filter(f => f.severity === 'fault');
    if (faults.length) {
      const problem = 'The script ran, but what it produced is not usable:\n'
        + faults.map(f => `  · ${f.title} — ${f.why}. ${f.gain}`).join('\n');
      log(`attempt ${attempt}: ran, but ${faults[0].title.toLowerCase()}`);
      history.push({ attempt, stage: 'unusable', problem: faults.map(f => f.title).join('; ') });
      messages = repairTurn(messages, gate.code, problem, request);
      continue;
    }

    const m = out.metrics;
    log(`built it: ${Math.round(m.volume)}mm³, ${m.size.map(v => Math.round(v)).join(' × ')}mm, ${m.faces} faces`);
    return {
      ok: true,
      script: gate.code,
      metrics: m,
      files: out.files || {},
      mesh: out.mesh || [],
      findings,                       // improvements and notes; no faults by here
      engine: res.engine,
      attempts: attempt,
      history
    };
  }

  return done(false, `${attempts} attempts and the kernel would not take it`, history);
}

function done(ok, error, history) {
  return { ok, error, history, script: '', metrics: null, files: {}, mesh: [], findings: [], attempts: history.length };
}

/* The conversation is kept, so the model can see what it already tried
   rather than making the same mistake in a fresh context. Trimmed to the
   opening brief plus the last exchange — a full transcript of four
   failures costs a fortune in tokens and the older ones are not the
   reason it is failing now. */
function repairTurn(messages, code, problem, request) {
  const head = messages.slice(0, 2);
  return [
    ...head,
    { role: 'assistant', content: '```python\n' + String(code).slice(0, 4000) + '\n```' },
    { role: 'user', content: repairPrompt(String(code), String(problem), request) }
  ];
}

/* ------------------------------------------------------------------ */
/* what to keep                                                        */
/* ------------------------------------------------------------------ */
/* A working script is a far better thing to remember than a list of
   primitives. It is parametric, it is editable, it says WHY the geometry
   is the shape it is, and handing it back next time turns a cold
   generation into an edit — which is the difference between "design me a
   bearing block" working sometimes and working every time.

   Shaped to sit inside the existing skill recipe rather than beside it,
   so `learn` and `recall` need to know nothing new. */
export function cadRecipe(result, request) {
  if (!result?.ok || !result.script) return null;
  const m = result.metrics || {};
  return {
    kind: 'cad',
    script: result.script,
    request,
    size_mm: (m.size || []).map(v => Math.round(v)),
    volume_mm3: Math.round(m.volume || 0),
    faces: m.faces || 0,
    attempts: result.attempts || 1,
    at: new Date().toISOString()
  };
}

/* The other half: pulling one back out. A skill only offers its script
   if it has one — the primitive recipes have no idea this exists, and
   asking for a hex bolt should not hand the model a lamp's box stack. */
export function recallScript(recalled) {
  const r = recalled?.skill?.recipe;
  if (!r?.cad?.script) return null;
  return {
    script: r.cad.script,
    hand: !!recalled.skill.stats?.taught,
    confidence: recalled.skill.confidence ?? 0.4
  };
}

/* ------------------------------------------------------------------ */
/* saying what happened                                                */
/* ------------------------------------------------------------------ */
/* The attempt history is worth surfacing rather than hiding. "It got it
   on the third go because the first fillet was too big" is genuinely
   useful — it says the part is near a geometric limit, which is exactly
   what somebody about to machine it wants to know. */
export function describeAttempts(result) {
  if (!result) return '';
  if (result.ok && result.attempts === 1) return 'The kernel took it first time.';
  if (result.ok) {
    const why = result.history.map(h => h.problem.split(';')[0].slice(0, 60));
    return `Took ${result.attempts} attempts — ${why.join(', then ')}.`;
  }
  const last = result.history[result.history.length - 1];
  return `The kernel would not take it after ${result.history.length} attempts`
    + (last ? ` — last problem: ${last.problem.slice(0, 120)}` : '') + '.';
}
