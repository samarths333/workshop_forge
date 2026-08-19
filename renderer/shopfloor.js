/* THE FLOOR, RUNNING.

   Jarvis takes the request and hands the whole of it to the floor manager.
   The manager writes a work order. Every trade named on that order is given
   its brief AT THE SAME TIME, works on it without seeing the others, and
   delivers back. The manager merges what came back into one object, and
   hands that up to Jarvis, who is the only one who talks to the person.

   The delegation ledger is lifted straight from Jarvis's task manager: work
   is launched rather than awaited one at a time, every task carries a status
   through queued → running → delivered | failed, and lifecycle events are
   published so something else can draw it. That last part is what makes the
   crew panel possible — the panel is a subscriber, not a special case in
   here.

   This file does not know what an LLM is. It is handed an `ask` function and
   calls it. That is what lets the whole pipeline be driven end to end under
   node with a scripted model, which is where the merge arithmetic is
   actually checked. */

import {
  SPECIALISTS, roleById, makesParts, budgetOf, JARVIS, FOREMAN
} from './roles.js';
import {
  ORDER_SCHEMA, buildOrderMessages, validateOrder, orderFromParts, splitPlan, describeOrder
} from './workorder.js';
import {
  SUBPLAN_SCHEMA, SPEC_SCHEMA, buildSpecialistMessages, buildControlsMessages,
  validateSubplan, validateSpec, mergeSubplans, fallbackSubplan, attributePlan
} from './crewplan.js';
import { ENGINE_RE, specFromRequest, validateEngine, engineParts, sizeEngine, describeEngine } from './engine.js';

/* Every state a delegated task passes through. `denied` is its own thing
   rather than a flavour of failed: a task that was refused was never sent,
   and telling the two apart is the difference between "the model is down"
   and "you asked the wrong trade". */
export const TASK_STATES = ['queued', 'running', 'delivered', 'failed', 'denied'];

let seq = 0;
const nextId = () => `t${(++seq).toString(36)}`;

/* ------------------------------------------------------------------ */
/* the ledger                                                          */
/* ------------------------------------------------------------------ */
export class Ledger {
  constructor(onEvent) {
    this.tasks = [];
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
  }

  open(role, brief, parts) {
    const t = {
      id: nextId(), role, brief: String(brief || '').slice(0, 300), parts: parts || 0,
      status: 'queued', startedAt: 0, endedAt: 0,
      delivered: 0, coerced: 0, dropped: 0, notes: '', reason: ''
    };
    this.tasks.push(t);
    this.emit('assign', t);
    return t;
  }

  start(t) { t.status = 'running'; t.startedAt = Date.now(); this.emit('working', t); return t; }

  deliver(t, sub) {
    t.status = 'delivered';
    t.endedAt = Date.now();
    t.delivered = sub.parts.length;
    t.coerced = sub.coerced || 0;
    t.dropped = sub.dropped || 0;
    t.notes = sub.notes || '';
    t.fallback = !!sub.fallback;
    this.emit('delivered', t);
    return t;
  }

  fail(t, reason) {
    t.status = 'failed'; t.endedAt = Date.now(); t.reason = String(reason || '').slice(0, 160);
    this.emit('failed', t);
    return t;
  }

  deny(t, reason) {
    t.status = 'denied'; t.endedAt = Date.now(); t.reason = String(reason || '').slice(0, 160);
    this.emit('denied', t);
    return t;
  }

  emit(kind, task) { try { this.onEvent({ kind, task, tasks: this.tasks }); } catch { /* a subscriber must never take the floor down */ } }

  get summary() {
    const n = k => this.tasks.filter(t => t.status === k).length;
    return { total: this.tasks.length, delivered: n('delivered'), failed: n('failed'), denied: n('denied') };
  }
}

/* ------------------------------------------------------------------ */
/* authority                                                           */
/* ------------------------------------------------------------------ */

/* Jarvis gates every spawn on an authority decision before the work is sent,
   and so does this. There are only two rules on a shop floor but they are
   the two that matter: nobody is given geometry to make outside the
   materials they work in, and nobody who makes no parts is given a parts
   budget. A denial is recorded rather than silently corrected, because a
   manager that keeps assigning the electrical specialist a wooden leg is
   information. */
export function gateAssignment(assignment) {
  const role = roleById(assignment?.role);
  if (!role) return { ok: false, reason: `no such trade as "${assignment?.role}"` };
  if (assignment.parts > 0 && !makesParts(role.id)) {
    return { ok: false, reason: `${role.name} produces no geometry — a parts budget is not something to give them` };
  }
  if (assignment.parts > role.budget[1]) {
    return { ok: false, reason: `${assignment.parts} parts is over ${role.name}'s budget of ${role.budget[1]}` };
  }
  return { ok: true, reason: '' };
}

/* ------------------------------------------------------------------ */
/* the floor                                                           */
/* ------------------------------------------------------------------ */
export class ShopFloor {
  /* ask(messages, schema, who) → { ok, text, engine }
     log(line, cls)            → whatever the caller wants to do with it
     onEvent({kind, task})     → ledger lifecycle, for the crew panel */
  constructor({ ask, log, onEvent } = {}) {
    this.ask = ask || (async () => ({ ok: false }));
    this.log = log || (() => {});
    this.ledger = new Ledger(onEvent);
    this.engine = '';
  }

  /* One request, start to finish. Never throws — every stage degrades to
     something local, exactly as the single-prompt pipeline did, because a
     shop that stops when a lookup fails is worse than one that builds
     something crude. */
  async run(request, ctx = {}) {
    const { refs = [], read = [], recalled = null, domain = null, offline = false, fallbackParts = null } = ctx;

    /* ---- 1. the manager writes the work order ---- */
    let order = null;
    /* With no engine, the floor does not fall back to six robots
       improvising. It takes the plan the shop already knows how to produce
       and SPLITS it — same archetype, same geometry, same proportions as the
       old offline build, handed out by trade. An offline build has to be at
       least as good as it was before the floor got a crew, or the crew is a
       downgrade dressed up as an org chart. */
    /* If this is an engine, it is sized BEFORE anybody is briefed. The
       manager does not decide the bore and neither does the specialist —
       the numbers are arithmetic off the request, and every trade then
       works against numbers that already agree with each other. */
    const engine = ENGINE_RE.test(request) ? validateEngine(specFromRequest(request)) : null;

    let preSplit = null;
    if (!offline) {
      try {
        const res = await this.ask(buildOrderMessages(request, refs, read, recalled, domain), ORDER_SCHEMA, FOREMAN.id);
        if (res?.ok) {
          order = validateOrder(parseJSON(res.text), request);
          this.engine = res.engine || this.engine;
        }
      } catch (err) {
        this.log(`${FOREMAN.name} could not write the order: ${err.message}`, 'err');
      }
    }
    if (!order) {
      preSplit = splitPlan(fallbackParts || [], request);
      order = preSplit.order;
      this.log(`${FOREMAN.name} worked the split out himself — no engine answered`, 'err');
    }
    this.log(`${FOREMAN.name}: ${describeOrder(order)}`, 'hi');

    /* ---- 2. every trade gets its brief, all at once ---- */
    const tasks = [];
    for (const a of order.assignments) {
      const gate = gateAssignment(a);
      const t = this.ledger.open(a.role, a.brief, a.parts);
      if (!gate.ok) { this.ledger.deny(t, gate.reason); continue; }
      tasks.push({ task: t, assignment: a });
    }
    /* Controls is consulted on every build whether the manager remembered it
       or not — the requirements are what the inspection at the end is
       measured against, and a build with no acceptance criteria passes
       everything. */
    /* An engine is the powerplant trade's work by definition, and a manager
       who forgets to assign it hands a V8 to the trade that makes brackets.
       Forced in the same way controls is, and for the same reason: some
       things about a build are not the model's call. */
    if (engine && !order.assignments.some(a => a.role === 'powerplant')) {
      const must = engineParts(sizeEngine(engine)).slice(0, 4).map(p => p.name);
      const a = {
        role: 'powerplant',
        brief: `the engine itself — ${describeEngine({ engine }).split('\n')[0]}`,
        mount: order.mounts[0].id,
        parts: budgetOf('powerplant', 8),
        must
      };
      order.assignments.push(a);
      tasks.push({ task: this.ledger.open('powerplant', a.brief, a.parts), assignment: a });
      this.log(`${FOREMAN.name} left the engine off the order — ${roleById('powerplant').name} is taking it`, 'err');
    }

    if (!order.assignments.some(a => a.role === 'controls')) {
      const a = { role: 'controls', brief: `set the requirements for a ${order.title}`, mount: order.mounts[0].id, parts: 0, must: [] };
      order.assignments.unshift(a);
      tasks.unshift({ task: this.ledger.open('controls', a.brief, 0), assignment: a });
    }

    const ready = preSplit ? new Map(preSplit.subplans.map(s => [s.role, s])) : null;
    const subplans = await Promise.all(tasks.map(({ task, assignment }) =>
      this.runOne(task, assignment, order, { request, recalled, offline, ready, engine })));

    /* ---- 3. the manager fits it together ---- */
    const plan = attributePlan(mergeSubplans(order, subplans.filter(Boolean), {
      handover: `That is the build, ${JARVIS.name}. Over to you.`, engine
    }));

    return { order, subplans: subplans.filter(Boolean), plan, ledger: this.ledger, engine: this.engine };
  }

  /* One specialist, one brief. A failure here costs that trade's parts and
     nothing else — the fallback still puts something plausible in the right
     place, because a hole in the object is worse than a dull part in it. */
  async runOne(task, assignment, order, ctx) {
    const role = roleById(assignment.role);
    this.ledger.start(task);

    /* controls answers a different question and hands back no geometry */
    if (!makesParts(role.id)) {
      if (ctx.offline) {
        const sub = validateSpec({ requirements: order.requirements, checks: [] });
        this.ledger.deliver(task, sub);
        return sub;
      }
      try {
        const res = await this.ask(buildControlsMessages(order, assignment, ctx.request), SPEC_SCHEMA, role.id);
        if (!res?.ok) throw new Error('no engine answered');
        const sub = validateSpec(parseJSON(res.text));
        this.ledger.deliver(task, sub);
        if (sub.requirements.length) this.log(`${role.name}: ${sub.requirements[0]}`, 'hi');
        return sub;
      } catch (err) {
        this.ledger.fail(task, err.message);
        return validateSpec({ requirements: order.requirements });
      }
    }

    /* already split out of a plan the shop knows — hand it straight over.
       An empty entry is a real answer here and not a failure: the split
       decides who has work, and a trade it gave nothing to is a trade with
       nothing to do. Reaching for the defaults instead would bolt two
       invented parts onto a finished archetype. */
    if (ctx.ready) {
      const ready = ctx.ready.get(role.id) || { role: role.id, notes: 'nothing in this build for this trade', parts: [], wires: [], coerced: 0, dropped: 0 };
      this.ledger.deliver(task, ready);
      return ready;
    }

    if (ctx.offline) {
      const sub = fallbackSubplan(role.id, order, assignment, ctx.engine);
      this.ledger.deliver(task, sub);
      return sub;
    }

    try {
      const msgs = buildSpecialistMessages(role.id, order, assignment, { recalled: ctx.recalled, engine: ctx.engine });
      const res = await this.ask(msgs, SUBPLAN_SCHEMA, role.id);
      if (!res?.ok) throw new Error('no engine answered');
      const sub = validateSubplan(parseJSON(res.text), role.id, order, assignment);
      if (!sub.parts.length) throw new Error('came back with nothing');
      this.engine = res.engine || this.engine;
      this.ledger.deliver(task, sub);
      const note = [
        `${role.name} delivered ${sub.parts.length} part${sub.parts.length === 1 ? '' : 's'}`,
        sub.parts.map(p => p.name).join(', ')
      ].join(' — ');
      this.log(note, 'ok');
      if (sub.coerced) this.log(`  ${sub.coerced} of ${role.name}'s parts were outside ${role.name === 'Kraft' ? 'their' : 'his'} materials and were pulled back into them`, 'err');
      if (sub.dropped) this.log(`  ${sub.dropped} part${sub.dropped === 1 ? '' : 's'} over budget, dropped`, 'err');
      return sub;
    } catch (err) {
      this.ledger.fail(task, err.message);
      this.log(`${role.name} did not deliver (${err.message}) — using the trade's own defaults`, 'err');
      return fallbackSubplan(role.id, order, assignment, ctx.engine);
    }
  }
}

/* Same tolerance as the old parsePlan: models fence their JSON, models
   preface it, and neither is a reason to throw a build away. */
export function parseJSON(text) {
  let raw = String(text).trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object in the reply');
  return JSON.parse(raw.slice(a, b + 1));
}

/* What Jarvis says back. It is the only thing in the app that speaks for the
   whole floor, so it reports the shape of the work rather than the detail —
   who did what, what the manager could not get, and what is still wrong with
   the object. */
export function jarvisReport({ order, ledger, plan, issues = [], findings = [] }) {
  /* Counted off the PLAN, not off the ledger. The ledger says what each
     trade was handed back for its own assignment; the frame is structures'
     work too, and reporting "7 parts, from Vulcan (3)" is the kind of
     arithmetic that makes a person stop trusting the report. */
  const made = {};
  for (const s of plan.steps || []) if (s.part) made[s.by || 'foreman'] = (made[s.by || 'foreman'] || 0) + 1;
  const total = Object.values(made).reduce((n, v) => n + v, 0);
  const trades = Object.entries(made).map(([id, n]) => `${roleById(id)?.name || id} (${n})`);
  const bad = ledger.tasks.filter(t => t.status === 'failed' || t.status === 'denied');

  const lines = [];
  lines.push(`${order.title} — ${total} part${total === 1 ? '' : 's'} off ${trades.length} trade${trades.length === 1 ? '' : 's'}: ${trades.join(', ') || 'none'}.`);
  if (bad.length) lines.push(`${bad.map(t => `${roleById(t.role)?.name || t.role} ${t.status}: ${t.reason}`).join('; ')}.`);
  if (order.requirements?.length) lines.push(`Built to: ${order.requirements.slice(0, 3).join('; ')}.`);
  if (issues.length) lines.push(`Still open: ${issues.slice(0, 2).join('; ')}.`);
  else if (findings.length) lines.push(`${findings.length} thing${findings.length === 1 ? '' : 's'} the engineer would change.`);
  else lines.push('Nothing outstanding.');
  return lines.join(' ');
}

export { SPECIALISTS };
