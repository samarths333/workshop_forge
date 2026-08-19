/* ------------------------------------------------------------------ *
 * cadscript.js — the shop's other way of making something
 * ------------------------------------------------------------------ *
 *
 * Everything else in this app builds an object out of PRIMITIVES on an
 * attach tree. That is a deliberate, good decision for what it does: it
 * is deterministic, it needs nothing installed, it runs headless, and it
 * is what the robots on the floor can actually act out. It is also,
 * unavoidably, a heap of boxes and cylinders. There is no fillet, no
 * boolean, no thread, no draft, no shell. Ask it for a hex bolt and you
 * get a cylinder with a fat cylinder on top, because a hex bolt is not
 * expressible in the vocabulary at all.
 *
 * So there is a second path. The model writes PYTHON against `build123d`
 * — a real B-rep kernel, OpenCascade underneath — and the kernel makes
 * the geometry. Suddenly `fillet()`, `chamfer()`, `Mode.SUBTRACT`,
 * `revolve()`, `loft()`, `PolarLocations` and a STEP export are all on
 * the table, and a hex bolt is six lines that produce an actual hex bolt.
 *
 * THE IDEA WORTH STEALING, and it is not the kernel: it is that THE
 * KERNEL IS THE VERIFIER. A fillet radius too large for the edge does not
 * quietly come out wrong, it throws, and the traceback says exactly what
 * is wrong in a way no critique prompt ever manages. Running the script
 * and feeding the error back is a far stronger correction signal than
 * asking a model to look at a description of its own work.
 *
 * THE IDEA WORTH NOT STEALING is executing whatever the model wrote.
 * `subprocess.run([sys.executable, script])` on generated code is one
 * bad completion away from `shutil.rmtree(os.path.expanduser("~"))`, and
 * a model does not have to be malicious to write that — it only has to
 * be asked to "clean up the output directory first". So nothing reaches
 * the kernel without getting past `gateScript` below.
 *
 * This file imports nothing. The gate is the security boundary of the
 * whole feature and it is pure string work, which means every escape it
 * is supposed to stop is tested in node in a millisecond.
 */

/* ------------------------------------------------------------------ */
/* what a CAD script is allowed to be                                  */
/* ------------------------------------------------------------------ */
/* An allowlist, not a blocklist. A blocklist is the wrong shape for this
   problem: you have to think of every dangerous name, and the day you
   forget one you find out from the outside. Here the rule is that a line
   may only mention things on this list, and anything unrecognised is a
   refusal — which fails closed, and fails LOUDLY enough that the model
   gets told what it may use instead. */

/* The kernel's own vocabulary. Not exhaustive against build123d — it is
   the set worth having, and adding to it is a deliberate edit rather than
   something a generated script can talk its way into. */
const BUILD123D = [
  // contexts
  'BuildPart', 'BuildSketch', 'BuildLine', 'Builder',
  // solid primitives
  'Box', 'Cylinder', 'Cone', 'Sphere', 'Torus', 'Wedge', 'CounterBore', 'CounterSink', 'Hole',
  // sketch primitives
  'Rectangle', 'RectangleRounded', 'Circle', 'Ellipse', 'Polygon', 'RegularPolygon',
  'Triangle', 'Trapezoid', 'SlotOverall', 'SlotCenterToCenter', 'SlotArc', 'Text',
  // lines
  'Line', 'Polyline', 'Spline', 'Bezier', 'CenterArc', 'ThreePointArc', 'RadiusArc',
  'TangentArc', 'EllipticalCenterArc', 'JernArc', 'FilletPolyline', 'PolarLine', 'Helix',
  // operations
  'extrude', 'revolve', 'loft', 'sweep', 'offset', 'fillet', 'chamfer', 'mirror', 'scale',
  'split', 'make_face', 'make_hull', 'make_brake_formed', 'thicken', 'project', 'trace',
  'add', 'section', 'sweep_helix', 'full_round',
  // placement
  'Location', 'Locations', 'GridLocations', 'PolarLocations', 'HexLocations', 'Rotation',
  'RotationLike', 'Plane', 'Axis', 'Pos', 'Rot',
  // enums and selectors
  'Mode', 'Align', 'Kind', 'Keep', 'Select', 'SortBy', 'GeomType', 'Side', 'Transition',
  'LengthMode', 'PageSize', 'Unit', 'AngularDirection', 'CenterOf', 'FontStyle',
  // geometry types
  'Vector', 'VectorLike', 'Vertex', 'Edge', 'Wire', 'Face', 'Shell', 'Solid', 'Compound',
  'Part', 'Sketch', 'Curve', 'Color', 'BoundBox', 'Matrix',
  // methods reached by attribute, listed so the checker knows them
  'edges', 'faces', 'vertices', 'wires', 'solids', 'shells', 'filter_by', 'filter_by_position',
  'sort_by', 'sort_by_distance', 'group_by', 'first', 'last', 'center', 'bounding_box',
  'volume', 'area', 'length', 'radius', 'part', 'sketch', 'line', 'wrapped', 'moved',
  'move', 'rotate', 'translate', 'located', 'locate', 'clean', 'is_valid', 'size',
  'to_tuple', 'X', 'Y', 'Z', 'XY', 'XZ', 'YZ', 'min', 'max', 'diagonal', 'thicken'
];

/* Maths, and the handful of builtins a shape calculation genuinely needs.
   Note what is NOT here: open, eval, exec, compile, input, __import__,
   getattr, globals, locals, vars, dir, type, super, object. */
const SAFE_BUILTINS = [
  'abs', 'min', 'max', 'sum', 'round', 'len', 'range', 'enumerate', 'zip', 'sorted',
  'reversed', 'int', 'float', 'bool', 'str', 'list', 'tuple', 'dict', 'set', 'all', 'any',
  'True', 'False', 'None', 'and', 'or', 'not', 'if', 'else', 'elif', 'for', 'while', 'in',
  'is', 'def', 'return', 'with', 'as', 'from', 'import', 'lambda', 'pass', 'break',
  'continue', 'try', 'except', 'raise', 'ValueError', 'print'
];

const SAFE_MODULES = ['build123d', 'math', 'numpy', 'np'];

const MATH_NAMES = [
  'math', 'np', 'pi', 'tau', 'e', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'pow', 'exp', 'log', 'log10', 'floor', 'ceil', 'radians', 'degrees', 'hypot',
  'sign', 'array', 'linspace', 'arange', 'deg2rad', 'rad2deg', 'cross', 'dot', 'norm'
];

const ALLOWED = new Set([...BUILD123D, ...SAFE_BUILTINS, ...MATH_NAMES, ...SAFE_MODULES, 'result_part']);

/* Things that are never acceptable in a CAD script, checked as raw text
   before anything else. The allowlist would catch most of these anyway;
   these are here so the REASON is specific — "you tried to open a file"
   is a far better message to hand back to a model than "unknown name". */
const FORBIDDEN = [
  [/\b__\w+__/, 'dunder attributes are not available'],
  [/\bimport\s+(?!build123d|math|numpy)\w+/, 'only build123d, math and numpy may be imported'],
  [/\bfrom\s+(?!build123d|math|numpy)\w+\s+import/, 'only build123d, math and numpy may be imported'],
  [/\b(open|eval|exec|compile|input|breakpoint)\s*\(/, 'that builtin is not available'],
  [/\b(getattr|setattr|delattr|globals|locals|vars|dir)\s*\(/, 'reflection is not available'],
  [/\b(os|sys|subprocess|shutil|pathlib|socket|requests|urllib|http|ctypes|pickle|marshal|importlib)\b/,
    'the standard library is not available — a CAD script only makes geometry'],
  [/\bexport_\w*\s*\(/, 'do not export: the shop writes the files, and it needs to know where they went'],
  [/\bwith\s+open\b/, 'a CAD script does not touch the filesystem'],
  [/[;&|]\s*(rm|del|curl|wget|chmod|mv)\b/, 'shell commands are not available']
];

/* ------------------------------------------------------------------ */
/* the gate                                                            */
/* ------------------------------------------------------------------ */
/* Returns { ok, code, reasons }. `code` is the script as it will be run —
   fences stripped, whitespace normalised — and is only ever set when ok.
   `reasons` are written AT THE MODEL, because they go straight back into
   the repair prompt and a vague one wastes a whole retry. */
export function gateScript(raw) {
  const reasons = [];
  const code = stripFences(raw);

  if (!code.trim()) return { ok: false, code: '', reasons: ['the script was empty'] };
  if (code.length > 12000) return { ok: false, code: '', reasons: ['the script is too long — keep it under 12000 characters'] };

  /* Strings and comments go first, and everything below reads the
     stripped text. A comment saying "no os module in here" is not an
     escape attempt, and refusing it would be maddening — it costs a
     retry and teaches the model nothing. */
  const stripped = stripStringsAndComments(code);

  for (const [re, why] of FORBIDDEN) {
    const hit = stripped.match(re);
    if (hit) reasons.push(`${why} (found "${hit[0].trim().slice(0, 40)}")`);
  }

  const assigned = new Set();
  /* Every name on the left of an `=` or a `for ... in`, including the
     tuple forms — `for i, s in enumerate(x)` binds BOTH, and binding only
     the first is how a gate ends up refusing an ordinary loop. */
  for (const m of stripped.matchAll(/^[ \t]*(?:for\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:=(?!=)|\bin\b)/gm)) {
    for (const n of m[1].split(',')) assigned.add(n.trim());
  }
  // names bound by `with ... as x` and `def f(x, y)`
  for (const m of stripped.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) assigned.add(m[1]);
  for (const m of stripped.matchAll(/\bdef\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
    assigned.add(m[1]);
    for (const p of m[2].split(',')) {
      const n = p.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_]\w*$/.test(n)) assigned.add(n);
    }
  }
  for (const m of stripped.matchAll(/\blambda\s+([^:]*):/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_]\w*$/.test(n)) assigned.add(n);
    }
  }

  const unknown = new Set();
  for (const m of stripped.matchAll(/[A-Za-z_]\w*/g)) {
    const name = m[0];
    if (ALLOWED.has(name) || assigned.has(name)) continue;
    /* `Mode.SUBTRACT`, `Axis.Z`, `p.part`, `e.length` — an identifier
       reached through a dot is an attribute of something already
       allowed, not a fresh name. Enumerating every enum member of
       build123d would be a maintenance treadmill that fails closed on
       the next release, and it would buy nothing: the only attributes
       worth fearing are dunders, and those are refused outright above. */
    const before = stripped.slice(Math.max(0, m.index - 1), m.index);
    if (before === '.') continue;
    // a keyword argument is a parameter name, not a lookup
    const after = stripped.slice(m.index + name.length, m.index + name.length + 3);
    if (/^\s*=(?!=)/.test(after)) continue;
    unknown.add(name);
  }
  if (unknown.size) {
    reasons.push(`these are not available: ${[...unknown].slice(0, 8).join(', ')}`
      + ' — use only build123d, math and numpy');
  }

  /* Structural: the shop has to be able to find the result, and it will
     do the exporting itself. */
  if (!/\bresult_part\s*=/.test(stripped)) {
    reasons.push('assign the finished solid to a variable called result_part');
  }

  return reasons.length ? { ok: false, code: '', reasons } : { ok: true, code, reasons: [] };
}

/* ```python … ``` around the answer, or the whole thing if there is no
   fence. Models do both and neither is worth a retry. */
export function stripFences(raw) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:python)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : s).replace(/\r\n/g, '\n').trim();
}

/* A comment saying "no os module here" must not be read as using it. */
function stripStringsAndComments(code) {
  return code
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

/* ------------------------------------------------------------------ */
/* what the model is told                                              */
/* ------------------------------------------------------------------ */
/* Written as constraints rather than a tutorial, because the model
   already knows build123d and what it does not know is the SHOP'S rules:
   millimetres, centred, one named result, no exporting, and a size the
   pedestal can take. The naming note is there because every model reaches
   for the PascalCase 1.x API first and every one of those is a wasted
   round trip. */
export function cadSystemPrompt() {
  return `You are writing a Python script with the build123d library. It runs in
a locked-down process that has build123d, math and numpy and NOTHING else.

THE RULES
  1  Start with: from build123d import *
  2  Assign the finished solid to a variable called EXACTLY result_part.
  3  Do NOT export anything. Do not call export_stl, export_step or open().
     The shop writes the files and needs to know where they went.
  4  Do NOT import os, sys, subprocess, pathlib or anything else. There is
     no filesystem and no network. A script that reaches for one is refused
     before it runs.
  5  Millimetres. Centre the part near the origin. Keep the largest
     dimension between 10mm and 400mm.
  6  Use the lowercase operation names — fillet(), chamfer(), extrude(),
     revolve(), loft(), sweep(), offset(), make_face(). The PascalCase
     versions are the old 1.x API and will not exist.

WHAT THIS BUYS YOU — use it
This is a real B-rep kernel, so make something a heap of primitives cannot be:
  · fillet(part.edges().filter_by(Axis.Z), radius=2)   real rounded edges
  · Cylinder(4, 30, mode=Mode.SUBTRACT)                a real hole
  · with PolarLocations(20, 6): Cylinder(3, 10)        six bolt holes on a circle
  · revolve(profile, Axis.Z)                           a real turned profile
  · loft([a, b])  ·  sweep(path, section)              real transitions
Boolean cuts, threads, shells, draft, counterbores — all of it is available
and all of it is the reason to write code instead of stacking boxes.

FILLETS AND CHAMFERS ARE THE THING THAT FAILS
A radius too large for the edge it is applied to raises an exception and the
whole script fails. Keep them well under half the thinnest wall they touch,
and select edges deliberately (filter_by, group_by, sort_by) rather than
filleting everything and hoping.

Worked example — a flanged bearing block
from build123d import *

with BuildPart() as p:
    Box(60, 40, 20)
    Cylinder(12, 20, mode=Mode.SUBTRACT)
    with GridLocations(44, 26, 2, 2):
        Cylinder(3, 20, mode=Mode.SUBTRACT)
    fillet(p.edges().filter_by(Axis.Z), radius=4)

result_part = p.part

Return one python code block and nothing else.`;
}

export function cadUserPrompt(request, { recalled, read, refs } = {}) {
  const bits = [`Design this in build123d: ${request}`];

  if (recalled?.script) {
    bits.push(`
YOU HAVE BUILT THIS BEFORE, AND THIS SCRIPT WORKED
${recalled.hand ? 'A person corrected this one by hand. Follow it closely — the corrections are not suggestions.' : 'Adapt it rather than starting over.'}

\`\`\`python
${String(recalled.script).slice(0, 4000)}
\`\`\``);
  }

  const named = (read || []).flatMap(r => r.structure || []).slice(0, 10);
  if (named.length) bits.push(`\nParts a real one has, from pages read just now: ${named.join(', ')}.`);

  const dims = (read || []).flatMap(r => r.dimensions || []).slice(0, 6);
  if (dims.length) bits.push(`Sizes people quote for it: ${dims.map(d => `${d.mm}mm`).join(', ')}.`);

  const titles = (refs || []).slice(0, 5).map(r => r.title).filter(Boolean);
  if (titles.length) bits.push(`Published designs for reference: ${titles.join('; ')}.`);

  return bits.join('\n');
}

/* The repair prompt. The traceback is the whole point — it is a precise,
   machine-generated statement of what is wrong with the geometry, which
   is worth more than anything a critique could say. Kept short: the last
   few lines carry the error, and the rest is stack noise that costs
   tokens and helps nobody. */
export function repairPrompt(code, problem, request) {
  return `That script did not work.

\`\`\`python
${code.slice(0, 6000)}
\`\`\`

${problem.trim().split('\n').slice(-12).join('\n').slice(0, 1200)}

Fix it and return the whole corrected script. Same rules as before:
result_part, no exports, no imports beyond build123d, math and numpy.
Original request: ${request}`;
}

/* ------------------------------------------------------------------ */
/* is the thing it made any good                                       */
/* ------------------------------------------------------------------ */
/* The kernel answers "did it run", which is not the same question as
   "is it right". A script can succeed and hand back an empty compound, a
   part four metres across, or a shell with no volume at all — all of
   which exit zero. These are the checks that a build actually has to
   pass, and they are the reason the kernel is not trusted on its own.

   Returns findings in the same shape optimize.js produces, so a CAD
   fault lands in the same list on the bench as a toppling assembly. */
export function checkSolid(m) {
  const F = (id, severity, title, why, gain) => ({ id, kind: 'cad', severity, title, why, gain, patch: null });
  const out = [];
  if (!m) return [F('no-solid', 'fault', 'The kernel produced nothing', 'the script ran but there was no solid to take away', 'rewrite it so result_part is a Part')];

  const big = Math.max(...(m.size || [0, 0, 0]));
  const small = Math.min(...(m.size || [0, 0, 0]));

  if (!(m.volume > 0)) {
    out.push(F('empty', 'fault', 'It has no volume',
      'the result is a surface or an empty compound, not a solid',
      'extrude, revolve or loft the sketch into a Part before assigning result_part'));
  }
  if (big > 600) {
    out.push(F('huge', 'fault', `It is ${Math.round(big)}mm across`,
      'that is bigger than anything the shop can hold, and far bigger than it was asked for',
      'scale the whole thing so the longest dimension is under 400mm'));
  }
  if (big > 0 && big < 8) {
    out.push(F('tiny', 'fault', `It is only ${big.toFixed(1)}mm across`,
      'a part this small is almost certainly a units mistake — build123d works in millimetres',
      'check whether the dimensions were meant to be mm rather than cm or metres'));
  }
  if (m.volume > 0 && big > 0) {
    // a solid whose volume is a rounding error next to its own box is a
    // shell somebody forgot to close, or a stack of coincident faces
    const boxVol = (m.size[0] || 0) * (m.size[1] || 0) * (m.size[2] || 0);
    if (boxVol > 0 && m.volume / boxVol < 0.004) {
      out.push(F('sliver', 'improvement', 'It is almost entirely empty space',
        `${Math.round(m.volume)}mm³ of material inside a ${m.size.map(v => Math.round(v)).join('×')}mm box`,
        'if it was meant to be hollow this is fine; if not, the solid did not close'));
    }
  }
  if (small > 0 && big / small > 200) {
    out.push(F('wafer', 'improvement', 'One dimension is vanishingly thin',
      `${big.toFixed(0)}mm against ${small.toFixed(2)}mm`,
      'nothing will print or machine at that thickness — give it a real wall'));
  }
  return out;
}

/* Which way to build. A request that wants real geometry — holes,
   fillets, threads, a profile — is worth the kernel; a request for
   something the robots should be seen making is not. Deliberately
   conservative: the primitive path is the one that always works, so the
   kernel has to be asked for or clearly warranted. */
const WANTS_KERNEL = /\b(bracket|mount|adapter|flange|bolt|screw|nut|thread|gear|bearing|housing|enclosure|clip|hinge|knob|handle|jig|fixture|spacer|standoff|coupler|pulley|cam|manifold|fitting|clamp|holder|insert|bushing|gasket|washer|plate)\b/i;
const ASKS_FOR_CAD = /\b(cad|parametric|machined|printable|precise|tolerance|fillet|chamfer|counterbore|countersunk|threaded|to spec|manufacturable|step file)\b/i;

export function wantsKernel(request, { available = true, forced = null } = {}) {
  if (!available) return { use: false, why: 'the CAD kernel is not installed' };
  if (forced === true) return { use: true, why: 'asked for' };
  if (forced === false) return { use: false, why: 'the shop floor was asked for' };
  const s = String(request || '');
  if (ASKS_FOR_CAD.test(s)) return { use: true, why: 'this asks for real CAD geometry' };
  if (WANTS_KERNEL.test(s)) return { use: true, why: 'a part like this needs holes and fillets, not stacked boxes' };
  return { use: false, why: 'the shop floor can build this one' };
}
