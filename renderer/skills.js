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
/* WHAT WENT WRONG BEFORE, because the fix only makes sense against it.

   Scoring used to add up keyword hits and then add a slice of confidence
   on top. A confident skill therefore cleared the bar on ONE incidental
   keyword — and the keywords were polluted, because every token of the
   request that produced a build was filed as a keyword for it. Ask for a
   rover to hold a bookshelf and "bookshelf" is a rover keyword forever;
   ask for a bookshelf a month later and the shop confidently hands the
   planner a rover. Nothing throws. The prompt just quietly describes the
   wrong object, and the build comes out shaped by it.

   So the two kinds of match are now separated and they are not equal:

     IDENTITY   the skill's class, the words that MEAN that class, and its
                own name. This is the only thing that can carry a recall.
     EVIDENCE   its keywords. They corroborate an identity match and they
                sharpen the ranking between two skills that both fit. On
                their own they are never enough, however many there are.

   A skill nobody would name as the thing being asked for is not a lead. */

/* People do not ask for a "vehicle", they ask for a car. The class is the
   identity, so the identity needs the words that mean it — hand-written,
   the same way library.js keeps a vocabulary per engineering domain, and
   inert for any class not listed. */
export const CLASS_WORDS = {
  vehicle: ['car', 'automobile', 'motorcar', 'truck', 'lorry', 'van', 'bus', 'buggy', 'kart',
    'rover', 'wagon', 'tractor', 'trailer', 'chassis', 'jeep'],
  lamp: ['light', 'lantern', 'sconce', 'luminaire', 'lampshade', 'torch', 'nightlight'],
  table: ['desk', 'worktable', 'workbench', 'tabletop', 'sidetable'],
  chair: ['stool', 'seat', 'armchair', 'bench'],
  shelf: ['bookshelf', 'bookcase', 'shelving', 'shelve', 'rack', 'unit'],
  rocket: ['missile', 'booster', 'launcher', 'launchvehicle', 'spacecraft', 'probe'],
  aircraft: ['plane', 'airplane', 'aeroplane', 'glider', 'drone', 'quadcopter', 'uav', 'airframe'],
  enclosure: ['box', 'case', 'housing', 'cabinet', 'crate', 'container', 'shell', 'cover'],
  engine: ['motor', 'powerplant', 'turbofan', 'turbine', 'v8', 'v6', 'inline', 'piston'],
  bracket: ['mount', 'brace', 'gusset', 'hanger', 'support'],
  frame: ['framework', 'skeleton', 'truss', 'gantry', 'stand'],
  robot: ['manipulator', 'arm', 'gripper', 'android', 'bot'],
  tool: ['jig', 'fixture', 'gauge', 'clamp', 'vice', 'vise'],
  circuit: ['torch', 'flashlight', 'blinker', 'led', 'board', 'netlist']
};

/* Words that describe HOW something was made or how big it is, never WHAT
   it is. They arrive as keywords from the reflection and from the request,
   they match nearly everything, and every one of them is a chance to
   recall the wrong object. */
const GENERIC = new Set(('model models scale mini miniature small large big custom simple basic plain'
  + ' thing object part parts piece pieces assembly build built making made design designed project'
  + ' printed printable print sturdy strong light heavy metal wooden plastic cardboard steel'
  + ' functional working real proper nice neat tidy standard generic version type kind style'
  + ' four three two five six eight top bottom side front back left right').split(/\s+/));

/* A keyword arrives from two places and both need cleaning up. The
   reflection hands back phrases, and they used to be squashed by stripping
   the spaces — "metal lamp desk foldable arm" became one keyword of
   thirty-eight characters that could never match anything anybody typed.
   And the request's own tokens are filed wholesale, which is where the
   cross-object pollution comes from. Split, drop what describes nothing,
   and cap it. */
export function cleanKeywords(list, { cls = '', limit = 14 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    for (const word of String(raw).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 3 || word.length > 18) continue;
      const w = word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word;
      if (STOP.has(w) || GENERIC.has(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  }
  /* The class always belongs, and always first — it is the identity. */
  const c = String(cls || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c && !seen.has(c)) out.unshift(c);
  return out.slice(0, limit);
}

/* The thing being asked for, as opposed to what it is attached to or made
   of. "a car with an engine" is a car; "a stand for a lamp" is a stand.
   Blunt on purpose — the first content word before any preposition is
   right far more often than it is wrong, and it only ever WEIGHTS a match
   that the identity rules already allowed. */
export function headNoun(request) {
  const words = String(request || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/);
  const cut = words.findIndex(w => ['with', 'for', 'that', 'which', 'holding', 'carrying', 'on', 'to'].includes(w));
  const head = (cut > 0 ? words.slice(0, cut) : words).filter(w => w.length > 2 && !STOP.has(w));
  const last = head[head.length - 1] || '';
  return last.endsWith('s') && last.length > 4 ? last.slice(0, -1) : last;
}

/* Everything a skill would answer to: its class, the words that mean that
   class, and what it is CALLED.

   The name contributes its head noun and nothing else. Offline, the name
   is the request with the verb trimmed off — "a rover to carry a bookshelf
   across a room" — so tokenising all of it put `bookshelf` into the
   identity of a rover, which is the same pollution as the keywords had and
   worse, because identity is the half that can carry a recall on its own. */
export function identityWords(skill) {
  const cls = String(skill?.class || '').toLowerCase();
  return new Set([cls, ...(CLASS_WORDS[cls] || []), headNoun(skill?.name)].filter(Boolean));
}

/* IDENTITY carries, EVIDENCE corroborates, and the gate is the whole
   point: no identity and fewer than two keywords is not a lead, whatever
   the confidence. Confidence MULTIPLIES what agreement there is instead of
   being added to it — a skill nobody is sure about and a skill everybody
   is sure about are both wrong if the request is about something else. */
export function scoreSkill(skill, tokens, opts = {}) {
  if (!skill || !tokens?.length) return 0;
  const ident = identityWords(skill);
  const cls = String(skill.class || '').toLowerCase();
  const kw = new Set(cleanKeywords(skill.keywords, { cls, limit: 24 }));
  const head = opts.head || '';

  let identity = 0, evidence = 0, hits = 0;
  for (const t of new Set(tokens)) {
    if (ident.has(t)) {
      const weight = t === cls ? 1.6 : 1.15;
      identity = Math.max(identity, t === head ? weight * 1.3 : weight);
    } else if (kw.has(t)) {
      hits++;
      evidence += 0.3;
    }
  }
  evidence = Math.min(evidence, 0.9);

  /* The gate. */
  if (!identity && hits < 2) return 0;

  /* A domain the caller worked out, against the domain this was learned
     in. Only a demotion, never a promotion: classification is a regex over
     a request and it is not authoritative enough to invent a match. */
  let domainPenalty = 0;
  if (opts.domain && skill.domain && opts.domain !== skill.domain) {
    if (!identity) return 0;
    domainPenalty = 0.45;
  }

  const agreement = identity + evidence - domainPenalty;
  if (agreement <= 0) return 0;

  const conf = 0.6 + 0.4 * (skill.confidence ?? 0.4);
  const proven = Math.min(0.2, 0.05 * ((skill.stats?.uses || 1) - 1));
  return agreement * conf + proven;
}

export const RECALL_FLOOR = 1.0;

/* The best skill for a request, or null if nothing is close enough that
   handing it over would help more than it would mislead. `domain` is what
   the caller's own classification made of the request — passed in rather
   than worked out here, because this file imports nothing and is going to
   keep it that way. */
export function recall(skills, request, opts = {}) {
  const tokens = tokenize(request);
  if (!tokens.length || !skills?.length) return null;
  const head = headNoun(request);
  let best = null;
  for (const s of skills) {
    const score = scoreSkill(s, tokens, { ...opts, head });
    if (score > 0 && (!best || score > best.score)) best = { skill: s, score };
  }
  if (!best || best.score < RECALL_FLOOR) return null;
  const ident = identityWords(best.skill);
  const kw = new Set(cleanKeywords(best.skill.keywords, { cls: best.skill.class, limit: 24 }));
  const matched = tokens.filter(t => ident.has(t) || kw.has(t));
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
    /* The class, what the thing is called, and the names of its own parts.
       NOT the whole request: "a rover to carry a bookshelf" is a rover,
       and filing `bookshelf` against it is what made the shop answer a
       bookshelf request with a rover a month later. */
    keywords: cleanKeywords([
      cls,
      headNoun(request),
      /* the title is the request with the verb trimmed off, so it carries
         the same sentence and the same other-object nouns with it */
      headNoun(plan.title || ''),
      ...solved.instances.map(i => i.name)
    ], { cls, limit: 10 }),
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
/* What a build is worth depends on who watched it.

   A person correcting geometry by hand and signing it off is ground
   truth. A model build a person sat through is evidence. A build Rivet
   ran on his own at three in the morning, judged by his own inspector, is
   a hypothesis — and an agent that files its own hypotheses as ground
   truth drifts, fastest exactly when it is most confident.

   So self-study is capped below a watched build, it can never overwrite a
   recipe a person taught, and a study build that did not come out sound
   contributes lessons and no geometry at all. This ceiling is the reason
   leaving the app running overnight makes the library better instead of
   worse. */
export const SELF_TAUGHT_CEILING = 0.6;

export function learn(skills, { request, plan, solved, reflection, corrections, clean, taught, self, domain: askedDomain, keepRecipe = true }) {
  const cls = String(reflection.object_class || 'assembly').toLowerCase().replace(/[^a-z]/g, '').slice(0, 24) || 'assembly';
  const recipe = recipeFrom(plan, reflection.roles);
  /* Two things used to go wrong right here. A reflection keyword of "metal
     lamp base" had its spaces STRIPPED rather than split on, producing one
     keyword thirty-odd characters long that could never match anything a
     person typed. And every token of the request was filed as a keyword,
     so "a rover to carry a bookshelf" tagged the rover with bookshelf and
     the shop recalled a rover for the next bookshelf. Both are the same
     mistake — treating the words AROUND the object as words FOR it. */
  const keywords = cleanKeywords([
    cls,
    ...(reflection.keywords || []),
    /* The request contributes only its head noun. That is the word the
       object is, and the rest of the sentence is context. */
    headNoun(request)
  ], { cls });

  const lessons = (reflection.lessons || [])
    .map(l => String(l).trim().slice(0, 180))
    .filter(l => l.length > 8);

  /* What the caller's classification made of the request. Stored so a
     later recall can tell a propulsion skill from a furniture one without
     this file having to know what a domain is. */
  const domain = String(askedDomain || '').toLowerCase().replace(/[^a-z]/g, '') || undefined;

  const existing = skills.find(s => s.class === cls);
  const out = skills.slice();

  if (existing) {
    const merged = dedupeLessons([...lessons, ...(existing.lessons || [])]).slice(0, 6);
    const stats = existing.stats || { uses: 1, cleanFirstPass: 0, corrections: 0 };
    const updated = {
      ...existing,
      name: reflection.name?.slice(0, 48) || existing.name,
      keywords: cleanKeywords([...keywords, ...(existing.keywords || [])], { cls, limit: 16 }),
      domain: domain || existing.domain,
      summary: reflection.summary?.slice(0, 200) || existing.summary,
      reuse_when: reflection.reuse_when?.slice(0, 160) || existing.reuse_when,
      lessons: merged,
      /* The recipe on file is always the most recent one that came off the
         floor — corrections included. That is the whole learning signal.
         Two exceptions, and both are about not letting Rivet overwrite
         something better than what he just made: a study build never
         replaces a recipe a person taught, and a study build that failed
         inspection never replaces anything at all. */
      recipe: (self && (existing.stats?.taught || !keepRecipe)) ? existing.recipe : recipe,
      stats: {
        uses: (stats.uses || 1) + (taught ? 0 : 1),
        cleanFirstPass: (stats.cleanFirstPass || 0) + (clean ? 1 : 0),
        corrections: (stats.corrections || 0) + (corrections?.length || 0),
        taught: (stats.taught || 0) + (taught ? 1 : 0),
        studied: (stats.studied || 0) + (self ? 1 : 0)
      },
      /* Practice cannot move a hand-taught skill at all — not up, because
         he did not earn it, and emphatically not down, because a ceiling
         applied to somebody else's 0.88 is a demotion for work that was
         already right. */
      confidence: taught ? Math.max(existing.confidence ?? 0.4, 0.88)
        : self ? (existing.stats?.taught
          ? (existing.confidence ?? 0.88)
          : Math.min(SELF_TAUGHT_CEILING, bump(existing.confidence ?? 0.4, clean && keepRecipe)))
          : bump(existing.confidence ?? 0.4, clean),
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
    domain,
    summary: (reflection.summary || plan.summary || '').slice(0, 200),
    reuse_when: (reflection.reuse_when || '').slice(0, 160),
    // a study build that did not come out sound leaves its lessons and no
    // geometry — there is nothing here worth repeating
    recipe: (self && !keepRecipe) ? { parts: [], process: recipe.process } : recipe,
    lessons: dedupeLessons(lessons).slice(0, 6),
    stats: { uses: 1, cleanFirstPass: clean ? 1 : 0, corrections: corrections?.length || 0, taught: taught ? 1 : 0, studied: self ? 1 : 0 },
    // a recipe a person corrected by hand and signed off is worth more than
    // one the model merely failed to object to, which is worth more than
    // one Rivet marked his own homework on
    confidence: taught ? 0.88 : self ? Math.min(SELF_TAUGHT_CEILING, bump(0.3, clean && keepRecipe)) : bump(0.4, clean),
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
      /* Cleaned on the way in, not only on the way out. A library written
         under the old rule is full of squashed phrases and other objects'
         nouns, and it gets better the first time it is opened rather than
         only after the next build overwrites it. */
      keywords: cleanKeywords(Array.isArray(s.keywords) ? s.keywords : [], { cls: s.class, limit: 16 }),
      domain: typeof s.domain === 'string' ? s.domain.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || undefined : undefined,
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
        taught: Number(s.stats?.taught) || 0,
        studied: Number(s.stats?.studied) || 0
      },
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.4)),
      taughtAt: s.taughtAt ? String(s.taughtAt) : null,
      sourceRequests: Array.isArray(s.sourceRequests) ? s.sourceRequests.map(String).slice(0, 6) : [],
      createdAt: String(s.createdAt || nowISO()),
      updatedAt: String(s.updatedAt || nowISO())
    }))
    .slice(0, MAX_SKILLS);
}
