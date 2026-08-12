/* =====================================================================
   What Rivet keeps.

   A build is expensive: a planning call, an inspection call, corrections,
   then four minutes of a robot walking around with parts in his arms. It
   is daft to throw all of that away and re-derive "a lamp has a base, a
   stem and a shade" from scratch on the next request.

   So each finished build is distilled into a SKILL — a small record of
   what the object turned out to be made of, in the shop's own attach/array
   vocabulary, plus the lessons that inspection taught. On the next request
   the closest matching skill is recalled and injected into the planner's
   prompt as a proven starting structure, and its confidence goes up or its
   recipe gets replaced depending on how the rebuild goes.

   The split that matters: the MODEL supplies semantics (what to call this,
   which words should recall it, what the lesson was). The CODE supplies
   geometry, always taken from the solved assembly that actually passed
   inspection — never from the model's description of it. A model that
   hallucinates its own past work would poison the memory within three
   builds.
   ===================================================================== */

const STOP = new Set(('a an the and or of for with to in on at that this it its is are be' +
  ' build make design create me my some something please can you rivet shop new small big' +
  ' simple nice good little bit into out from as by').split(/\s+/));

export const MAX_SKILLS = 60;

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w => (w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w));
}

/* ------------------------------------------------------------------ */
/* recall                                                              */
/* ------------------------------------------------------------------ */
export function scoreSkill(skill, tokens) {
  if (!skill) return 0;
  const kw = new Set((skill.keywords || []).map(k => String(k).toLowerCase()));
  const cls = String(skill.class || '').toLowerCase();
  const nameTokens = new Set(tokenize(skill.name));

  let hits = 0, classHit = false;
  for (const t of tokens) {
    if (t === cls) { classHit = true; hits += 3; continue; }
    if (kw.has(t)) hits += 1.4;
    else if (nameTokens.has(t)) hits += 1;
  }
  if (!hits) return 0;
  // one shared keyword out of a nine-word request should not outrank a
  // class match, hence the sqrt rather than a plain ratio
  const base = hits / Math.sqrt(Math.max(2, tokens.length));
  const conf = 0.35 * (skill.confidence ?? 0.4);
  const proven = Math.min(0.25, 0.05 * ((skill.stats?.uses || 1) - 1));
  return base + conf + proven + (classHit ? 0.4 : 0);
}

/* The best skill for a request, or null if nothing is close enough that
   handing it over would help more than it would mislead. */
export function recall(skills, request) {
  const tokens = tokenize(request);
  if (!tokens.length || !skills?.length) return null;
  let best = null;
  for (const s of skills) {
    const score = scoreSkill(s, tokens);
    if (score > 0 && (!best || score > best.score)) best = { skill: s, score };
  }
  if (!best || best.score < 0.85) return null;
  const kw = new Set((best.skill.keywords || []).map(k => k.toLowerCase()));
  const matched = tokens.filter(t => kw.has(t) || t === String(best.skill.class).toLowerCase());
  return { ...best, matched: [...new Set(matched)].slice(0, 5) };
}

/* ------------------------------------------------------------------ */
/* distillation                                                        */
/* ------------------------------------------------------------------ */
/* The recipe is lifted from the plan's part SPECS — attach and array and
   size, the things that can be replayed — and never from prose. */
export function recipeFrom(plan, roles) {
  const roleOf = new Map((roles || []).map(r => [Number(r.i), String(r.role || '').slice(0, 40)]));
  const parts = [];
  const process = [];

  for (const step of plan.steps) {
    let partRef = null;
    if (step.part) {
      partRef = parts.length;
      const p = step.part;
      parts.push({
        role: roleOf.get(parts.length) || p.name,
        name: p.name,
        shape: p.shape,
        material: p.material,
        size: p.size.map(v => +Number(v).toFixed(2)),
        ...(p.attach ? { attach: { ...p.attach } } : {}),
        ...(p.array ? { array: { ...p.array } } : {}),
        ...(p.rot ? { rot: p.rot.map(v => +Number(v).toFixed(3)) } : {}),
        ...(p.color ? { color: p.color } : {})
      });
    }
    process.push({ room: step.room, action: step.action, seconds: step.seconds, part: partRef });
  }
  return { parts, process };
}

/* When there is no model to reflect with, this is still a real skill —
   just one with mechanical labels. Offline builds learn too. */
export function deterministicReflection(request, plan, solved, corrections) {
  const tokens = tokenize(request);
  const CLASSES = [
    [/\b(lamp|light|lantern|sconce|shade)\b/, 'lamp'],
    [/\b(table|desk|bench|workbench)\b/, 'table'],
    [/\b(chair|stool|seat)\b/, 'chair'],
    [/\b(shelf|shelve|rack|bookcase)\b/, 'shelf'],
    [/\b(rocket|missile|launch)\b/, 'rocket'],
    [/\b(plane|aircraft|glider|drone|wing)\b/, 'aircraft'],
    [/\b(car|truck|rover|cart|vehicle|chassis)\b/, 'vehicle'],
    [/\b(robot|droid|bot|mech)\b/, 'robot'],
    [/\b(box|crate|case|enclosure|housing|bin)\b/, 'enclosure'],
    [/\b(bracket|mount|stand|frame|tower|bridge)\b/, 'bracket'],
    [/\b(guitar|speaker|amp|instrument|drum)\b/, 'instrument'],
    [/\b(gear|clock|mechanism|machine)\b/, 'mechanism']
  ];
  const cls = (CLASSES.find(([re]) => re.test(request.toLowerCase())) || [null, 'assembly'])[1];

  const shapes = [...new Set(solved.instances.map(i => i.shape))];
  const lessons = [];
  for (const c of (corrections || []).slice(0, 2)) lessons.push(c);
  if (!lessons.length) {
    lessons.push(`A ${cls} came out right as ${solved.instances.length} parts: ${shapes.join(', ')}.`);
  }

  return {
    name: plan.title.slice(0, 48),
    object_class: cls,
    keywords: [...new Set([cls, ...tokens])].slice(0, 10),
    summary: plan.summary || `A ${cls} built in ${plan.steps.length} operations.`,
    roles: solved.instances.map((inst, i) => ({ i: inst.src, role: inst.name })).filter((r, i, a) => a.findIndex(x => x.i === r.i) === i),
    lessons: lessons.slice(0, 4),
    reuse_when: `Another ${cls}.`
  };
}

/* ------------------------------------------------------------------ */
/* what a human changed on the bench                                   */
/* ------------------------------------------------------------------ */
/* When someone corrects a build by hand in the CAD view, the diff IS the
   lesson, and it is a far better one than anything the model would write
   about its own work. "the shade is a cone, not a box" is exactly the
   sentence that stops the next lamp coming out wrong. */
export function describeEdits(before, after) {
  const out = [];
  const nameOf = (list, i) => (list[i] ? (list[i].name || list[i].shape) : `part ${i}`);
  const n = Math.min(before.length, after.length);

  for (let i = 0; i < n; i++) {
    const a = before[i], b = after[i];
    const label = b.name || b.shape;

    if (a.shape !== b.shape) out.push(`The ${label} has to be a ${b.shape}, not a ${a.shape}.`);
    if (a.material !== b.material) out.push(`The ${label} is ${b.material}, not ${a.material}.`);

    const grew = [0, 1, 2].filter(ax => Math.abs((a.size?.[ax] ?? 0) - (b.size?.[ax] ?? 0)) > 0.06);
    if (grew.length) {
      const dim = ['wide', 'tall', 'deep'][grew[0]];
      out.push(`The ${label} is ${b.size[grew[0]].toFixed(2)}m ${dim}, not ${(a.size?.[grew[0]] ?? 0).toFixed(2)}m — the proportion matters.`);
    }

    const fa = a.attach, fb = b.attach;
    if (!fa && fb) out.push(`The ${label} bolts to the ${fb.face} of the ${nameOf(after, fb.to)} — it does not stand on the pedestal by itself.`);
    else if (fa && !fb) out.push(`The ${label} stands on the pedestal on its own.`);
    else if (fa && fb && (fa.to !== fb.to || fa.face !== fb.face)) {
      out.push(`The ${label} belongs on the ${fb.face} of the ${nameOf(after, fb.to)}.`);
    }

    const ca = a.array?.count || 1, cb = b.array?.count || 1;
    const ma = a.array?.mode || 'none', mb = b.array?.mode || 'none';
    if (ma !== mb || ca !== cb) {
      out.push(cb > 1
        ? `There are ${cb} of the ${label}, arranged ${mb.replace('_', ' ')} — not ${ca === 1 ? 'one' : ca}.`
        : `There is only one ${label}.`);
    }
  }

  for (let i = n; i < after.length; i++) {
    const b = after[i];
    out.push(`It needs a ${b.name || b.shape} — a ${b.shape} in ${b.material}${b.attach ? ` on the ${b.attach.face} of the ${nameOf(after, b.attach.to)}` : ''}.`);
  }
  for (let i = n; i < before.length; i++) {
    out.push(`The ${before[i].name || before[i].shape} was not needed.`);
  }

  return dedupeLessons(out).slice(0, 5);
}

const nowISO = () => new Date().toISOString();

/* Fold a finished build into the library: update the skill of the same
   class if there is one, otherwise start a new one. */
export function learn(skills, { request, plan, solved, reflection, corrections, clean, taught }) {
  const cls = String(reflection.object_class || 'assembly').toLowerCase().replace(/[^a-z]/g, '').slice(0, 24) || 'assembly';
  const recipe = recipeFrom(plan, reflection.roles);
  const keywords = [...new Set([
    cls,
    ...(reflection.keywords || []).map(k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(k => k.length > 2),
    ...tokenize(request)
  ])].slice(0, 14);

  const lessons = (reflection.lessons || [])
    .map(l => String(l).trim().slice(0, 180))
    .filter(l => l.length > 8);

  const existing = skills.find(s => s.class === cls);
  const out = skills.slice();

  if (existing) {
    const merged = dedupeLessons([...lessons, ...(existing.lessons || [])]).slice(0, 6);
    const stats = existing.stats || { uses: 1, cleanFirstPass: 0, corrections: 0 };
    const updated = {
      ...existing,
      name: reflection.name?.slice(0, 48) || existing.name,
      keywords: [...new Set([...keywords, ...(existing.keywords || [])])].slice(0, 16),
      summary: reflection.summary?.slice(0, 200) || existing.summary,
      reuse_when: reflection.reuse_when?.slice(0, 160) || existing.reuse_when,
      lessons: merged,
      // the recipe on file is always the most recent one that came off the
      // floor — corrections included. That is the whole learning signal.
      recipe,
      stats: {
        uses: (stats.uses || 1) + (taught ? 0 : 1),
        cleanFirstPass: (stats.cleanFirstPass || 0) + (clean ? 1 : 0),
        corrections: (stats.corrections || 0) + (corrections?.length || 0),
        taught: (stats.taught || 0) + (taught ? 1 : 0)
      },
      confidence: taught ? Math.max(existing.confidence ?? 0.4, 0.88) : bump(existing.confidence ?? 0.4, clean),
      taughtAt: taught ? nowISO() : existing.taughtAt || null,
      sourceRequests: [...new Set([request, ...(existing.sourceRequests || [])])].slice(0, 6),
      updatedAt: nowISO()
    };
    out[out.indexOf(existing)] = updated;
    return { skills: out, skill: updated, isNew: false };
  }

  const fresh = {
    id: `${cls}-${Date.now().toString(36)}`,
    name: (reflection.name || plan.title).slice(0, 48),
    class: cls,
    keywords,
    summary: (reflection.summary || plan.summary || '').slice(0, 200),
    reuse_when: (reflection.reuse_when || '').slice(0, 160),
    recipe,
    lessons: dedupeLessons(lessons).slice(0, 6),
    stats: { uses: 1, cleanFirstPass: clean ? 1 : 0, corrections: corrections?.length || 0, taught: taught ? 1 : 0 },
    // a recipe a person corrected by hand and signed off is worth more than
    // one the model merely failed to object to
    confidence: taught ? 0.88 : bump(0.4, clean),
    taughtAt: taught ? nowISO() : null,
    sourceRequests: [request],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  out.unshift(fresh);
  return { skills: out.slice(0, MAX_SKILLS), skill: fresh, isNew: true };
}

const bump = (c, clean) => Math.max(0.15, Math.min(0.97, c + (clean ? 0.2 : 0.06)));

function dedupeLessons(list) {
  const seen = new Set(), out = [];
  for (const l of list) {
    const k = l.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/* A build of a class Rivet already knows that comes back needing the same
   correction twice means the stored lesson is not working. Worth knowing. */
export function repeatedFault(skill, corrections) {
  if (!skill || !corrections?.length) return null;
  const known = (skill.lessons || []).map(l => l.toLowerCase());
  const again = corrections.find(c => known.some(l => overlapWords(l, c.toLowerCase()) > 0.4));
  return again || null;
}

function overlapWords(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/* ------------------------------------------------------------------ */
/* folding someone else's library into this one                        */
/* ------------------------------------------------------------------ */
/* Import is a merge, not a replace: a shop that has already learned to
   build a lamp should not lose it by taking someone else's shelf recipe.
   One skill per class stays the rule, so a collision is decided on
   confidence — and a hand-taught recipe, at 0.88, beats almost anything
   that was merely never objected to.

   Whichever recipe wins, the losing side's lessons and source requests are
   kept. Those are cheap, they are the part a person wrote, and dropping
   them is how a merge quietly loses the only sentence that stopped the
   shade coming out as a box. */
export function mergeLibraries(current, incoming) {
  const out = sanitize(current).slice();
  const add = sanitize(incoming);
  let added = 0, replaced = 0, kept = 0;

  for (const s of add) {
    const at = out.findIndex(x => x.class === s.class);
    if (at < 0) {
      out.unshift(s);
      added++;
      continue;
    }
    const have = out[at];
    const win = (s.confidence || 0) > (have.confidence || 0) ? s : have;
    const lose = win === s ? have : s;
    const merged = {
      ...win,
      lessons: dedupeLessons([...(win.lessons || []), ...(lose.lessons || [])]).slice(0, 6),
      keywords: [...new Set([...(win.keywords || []), ...(lose.keywords || [])])].slice(0, 16),
      sourceRequests: [...new Set([...(win.sourceRequests || []), ...(lose.sourceRequests || [])])].slice(0, 6),
      stats: {
        uses: Math.max(win.stats?.uses || 1, lose.stats?.uses || 1),
        cleanFirstPass: Math.max(win.stats?.cleanFirstPass || 0, lose.stats?.cleanFirstPass || 0),
        corrections: Math.max(win.stats?.corrections || 0, lose.stats?.corrections || 0),
        taught: Math.max(win.stats?.taught || 0, lose.stats?.taught || 0)
      },
      updatedAt: nowISO()
    };
    out[at] = merged;
    if (win === s) replaced++; else kept++;
  }

  return { skills: out.slice(0, MAX_SKILLS), added, replaced, kept };
}

/* ------------------------------------------------------------------ */
/* sanity — a skill file is user-editable and comes off disk           */
/* ------------------------------------------------------------------ */
export function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(s => s && typeof s === 'object' && s.class && s.recipe)
    .map(s => ({
      id: String(s.id || `${s.class}-${Math.random().toString(36).slice(2)}`),
      name: String(s.name || s.class).slice(0, 48),
      class: String(s.class).toLowerCase().slice(0, 24),
      keywords: Array.isArray(s.keywords) ? s.keywords.map(String).slice(0, 16) : [],
      summary: String(s.summary || '').slice(0, 200),
      reuse_when: String(s.reuse_when || '').slice(0, 160),
      recipe: {
        parts: Array.isArray(s.recipe?.parts) ? s.recipe.parts.slice(0, 12) : [],
        process: Array.isArray(s.recipe?.process) ? s.recipe.process.slice(0, 20) : []
      },
      lessons: Array.isArray(s.lessons) ? s.lessons.map(String).slice(0, 6) : [],
      stats: {
        uses: Number(s.stats?.uses) || 1,
        cleanFirstPass: Number(s.stats?.cleanFirstPass) || 0,
        corrections: Number(s.stats?.corrections) || 0,
        taught: Number(s.stats?.taught) || 0
      },
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.4)),
      taughtAt: s.taughtAt ? String(s.taughtAt) : null,
      sourceRequests: Array.isArray(s.sourceRequests) ? s.sourceRequests.map(String).slice(0, 6) : [],
      createdAt: String(s.createdAt || nowISO()),
      updatedAt: String(s.updatedAt || nowISO())
    }))
    .slice(0, MAX_SKILLS);
}
