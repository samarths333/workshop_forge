/* The CAD gate, and what comes back from the kernel.

   This file is mostly about ONE thing: `gateScript` is the security
   boundary of the whole build123d feature. Everything downstream — the
   restricted namespace, the guarded __import__, the text check in
   kernel.py — is defence in depth, and defence in depth is worth having
   precisely because the outer fence will one day have a hole in it. But
   the outer fence is the one that is supposed to hold, so it is the one
   tested hardest.

   The shape of the testing is deliberate and matches the optimiser's:
   every escape tried, and every LEGITIMATE script allowed. A gate that
   refuses good CAD is not "safe", it is broken — it burns a retry, and
   three of those and the build fails for no reason.

     node test/cadscript.test.mjs
*/
import {
  gateScript, stripFences, cadSystemPrompt, cadUserPrompt, repairPrompt,
  checkSolid, wantsKernel
} from '../renderer/cadscript.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const allowed = code => {
  const r = gateScript(code);
  assert(r.ok, `refused a legitimate script: ${r.reasons.join('; ')}`);
  return r;
};
const refused = (code, expect) => {
  const r = gateScript(code);
  assert(!r.ok, 'this got through the gate:\n' + code.slice(0, 160));
  if (expect) {
    assert(r.reasons.some(x => expect.test(x)),
      `refused, but for the wrong reason: ${r.reasons.join('; ')}`);
  }
  assert(r.code === '', 'a refused script still handed back code to run');
  return r;
};

/* The script the whole file is measured against: real CAD, nothing odd. */
const GOOD = `from build123d import *

with BuildPart() as p:
    Box(60, 40, 20)
    Cylinder(12, 20, mode=Mode.SUBTRACT)
    with GridLocations(44, 26, 2, 2):
        Cylinder(3, 20, mode=Mode.SUBTRACT)
    fillet(p.edges().filter_by(Axis.Z), radius=4)

result_part = p.part`;

/* ================================================================== */
/* the gate lets real work through                                     */
/* ================================================================== */
check('a real CAD script is allowed', () => {
  const r = allowed(GOOD);
  assert(r.code.includes('BuildPart'), 'the code came back mangled');
  assert(!r.reasons.length, 'a clean script produced complaints');
});

check('the things that make a kernel worth having are all allowed', () => {
  allowed(`from build123d import *
with BuildPart() as p:
    with BuildSketch() as s:
        RegularPolygon(radius=10, side_count=6)
    extrude(amount=8)
    with PolarLocations(20, 6):
        Cylinder(2, 8, mode=Mode.SUBTRACT)
    chamfer(p.edges().group_by(Axis.Z)[-1], length=0.8)
result_part = p.part`);

  allowed(`from build123d import *
with BuildPart() as p:
    with BuildSketch(Plane.XZ) as profile:
        Rectangle(20, 4)
    revolve(axis=Axis.Z)
result_part = p.part`);

  allowed(`from build123d import *
with BuildPart() as p:
    with BuildSketch() as a:
        Circle(20)
    with BuildSketch(Plane.XY.offset(30)) as b:
        Rectangle(10, 10)
    loft()
result_part = p.part`);
});

check('maths and numpy are allowed, because a shape needs arithmetic', () => {
  allowed(`from build123d import *
import math
import numpy as np

n = 8
r = 25.0
with BuildPart() as p:
    Cylinder(r, 10)
    for i in range(n):
        a = 2 * math.pi * i / n
        with Locations((r * math.cos(a), r * math.sin(a))):
            Cylinder(2, 10, mode=Mode.SUBTRACT)
result_part = p.part`);
});

check('local variables, loops, functions and lambdas are allowed', () => {
  allowed(`from build123d import *

def wall(t):
    return max(2.0, t)

thickness = wall(3)
sizes = [10, 20, 30]
with BuildPart() as p:
    for i, s in enumerate(sizes):
        with Locations((i * 40, 0, 0)):
            Box(s, s, thickness)
    tallest = p.edges().sort_by(lambda e: e.length)[-1]
result_part = p.part`);
});

/* ================================================================== */
/* and refuses everything it is supposed to                            */
/* ================================================================== */
check('the standard library is not reachable', () => {
  refused('import os\nos.system("rm -rf ~")\nresult_part = 1', /standard library|imported/);
  refused('import subprocess\nresult_part = 1', /standard library|imported/);
  refused('from pathlib import Path\nresult_part = 1', /imported/);
  refused('import shutil\nshutil.rmtree("/")\nresult_part = 1', /standard library|imported/);
  refused('import socket\nresult_part = 1', /standard library|imported/);
});

check('the escape hatches in the language are not reachable', () => {
  refused('__import__("os").system("x")\nresult_part = 1', /dunder/);
  refused('result_part = ().__class__.__mro__[-1].__subclasses__()', /dunder/);
  refused('from build123d import *\neval("1")\nresult_part = Box(1,1,1)', /builtin/);
  refused('from build123d import *\nexec("x=1")\nresult_part = Box(1,1,1)', /builtin/);
  refused('from build123d import *\ng = globals()\nresult_part = Box(1,1,1)', /reflection/);
  refused('from build123d import *\ngetattr(Box, "x")\nresult_part = Box(1,1,1)', /reflection/);
});

check('the filesystem is not reachable', () => {
  refused('from build123d import *\nopen("/etc/passwd").read()\nresult_part = Box(1,1,1)', /builtin|filesystem/);
  refused('from build123d import *\nwith open("x","w") as f:\n    f.write("y")\nresult_part = Box(1,1,1)', /filesystem|builtin/);
});

check('the script does not get to decide where files go', () => {
  /* The shop writes the files. Letting the script export means
     string-replacing a path into generated code afterwards, which is
     fragile, and it is the only reason generated code would ever have a
     legitimate excuse to touch the disk. */
  refused(GOOD.replace('result_part = p.part',
    'result_part = p.part\nexport_stl(result_part, "output.stl")'), /export/);
  refused(GOOD.replace('result_part = p.part',
    'result_part = p.part\nexport_step(result_part, "/tmp/x.step")'), /export/);
});

check('an unknown name is a refusal, not a hope', () => {
  const r = refused('from build123d import *\nsneaky_helper()\nresult_part = Box(1,1,1)', /not available/);
  assert(/sneaky_helper/.test(r.reasons.join(' ')), `it did not say which name: ${r.reasons}`);
});

check('the result has to be findable', () => {
  refused('from build123d import *\nwith BuildPart() as p:\n    Box(1,1,1)', /result_part/);
  refused('from build123d import *\nfinal = Box(1,1,1)', /result_part/);
});

check('a comment mentioning os is not an escape attempt', () => {
  /* The gate strips strings and comments before looking for names — a
     refusal here would be maddening and would teach nobody anything. */
  allowed(`from build123d import *
# no os module in here, and no open() either
label = "subprocess"
with BuildPart() as p:
    Box(10, 10, 10)
result_part = p.part`);
});

check('empty, enormous and missing input are all refused calmly', () => {
  refused('', /empty/);
  refused('   \n  ', /empty/);
  refused('from build123d import *\n' + 'x = 1\n'.repeat(4000) + 'result_part = 1', /too long/);
  assert(!gateScript(null).ok && !gateScript(undefined).ok, 'null input threw or passed');
});

/* ================================================================== */
/* fences                                                              */
/* ================================================================== */
check('a fenced answer and a bare one both work', () => {
  const bare = 'from build123d import *\nresult_part = Box(1,1,1)';
  assert(stripFences('```python\n' + bare + '\n```') === bare, 'python fence not stripped');
  assert(stripFences('```\n' + bare + '\n```') === bare, 'bare fence not stripped');
  assert(stripFences(bare) === bare, 'unfenced code was mangled');
  assert(stripFences('Here you go:\n```python\n' + bare + '\n```\nHope that helps')
    === bare, 'prose around the fence was kept');
});

/* ================================================================== */
/* is what came out of the kernel any good                             */
/* ================================================================== */
check('a sound solid passes', () => {
  const f = checkSolid({ volume: 36415, size: [60, 40, 20], solids: 1, valid: true });
  assert(!f.filter(x => x.severity === 'fault').length,
    `it invented faults in a good part: ${f.map(x => x.id)}`);
});

check('a script that ran but made nothing is a fault', () => {
  assert(checkSolid(null).some(x => x.id === 'no-solid'), 'no solid at all was accepted');
  assert(checkSolid({ volume: 0, size: [10, 10, 0] }).some(x => x.id === 'empty'),
    'a zero-volume result was accepted — that is a surface, not a part');
});

check('a units mistake in either direction is caught', () => {
  /* Both of these are the same mistake — thinking in metres or in
     inches — and both produce a script that runs perfectly. */
  assert(checkSolid({ volume: 1e9, size: [2000, 500, 500] }).some(x => x.id === 'huge'),
    'a two-metre part was accepted');
  assert(checkSolid({ volume: 0.1, size: [2, 2, 2] }).some(x => x.id === 'tiny'),
    'a 2mm part was accepted');
  // and the ordinary case is not called a units mistake
  assert(!checkSolid({ volume: 8000, size: [20, 20, 20] }).some(x => /huge|tiny/.test(x.id)),
    'a 20mm cube was called a units mistake');
});

check('a solid that did not close is noticed', () => {
  const f = checkSolid({ volume: 20, size: [100, 100, 100] });
  assert(f.some(x => x.id === 'sliver'), 'a shell with no material was accepted');
  assert(!checkSolid({ volume: 40000, size: [60, 40, 20] }).some(x => x.id === 'sliver'),
    'a solid block was called empty space');
});

check('a wafer is flagged, a plate is not', () => {
  assert(checkSolid({ volume: 1, size: [200, 200, 0.4] }).some(x => x.id === 'wafer'),
    'a 0.4mm wafer was accepted');
  assert(!checkSolid({ volume: 5000, size: [100, 100, 3] }).some(x => x.id === 'wafer'),
    'a 3mm plate was called a wafer');
});

check('every CAD finding is shaped like every other finding', () => {
  /* They land in the same list on the bench as a toppling assembly, so
     they have to carry the same fields or the panel breaks. */
  for (const f of checkSolid({ volume: 0, size: [2000, 1, 1] })) {
    assert(f.kind === 'cad', `kind is ${f.kind}`);
    assert(['fault', 'improvement', 'note'].includes(f.severity), `severity is ${f.severity}`);
    assert(f.id && f.title && f.why && f.gain, `${f.id} is missing a field`);
  }
});

/* ================================================================== */
/* which way to build                                                  */
/* ================================================================== */
check('a part that needs real geometry goes to the kernel', () => {
  for (const ask of ['a motor mount bracket', 'a hex bolt', 'a bearing housing',
    'a pulley for a 6mm shaft', 'a hinge', 'a threaded insert']) {
    assert(wantsKernel(ask).use, `"${ask}" was sent to the primitive path`);
  }
  assert(wantsKernel('a desk lamp with a fillet on the base').use, 'an explicit fillet request');
  assert(wantsKernel('a parametric phone stand').use, 'an explicit CAD request');
});

check('a thing worth watching a robot build does not', () => {
  for (const ask of ['a desk lamp', 'a model rocket with fins', 'a wooden stool',
    'a bookshelf', 'a rover with a mast']) {
    assert(!wantsKernel(ask).use, `"${ask}" was sent to the kernel unnecessarily`);
  }
});

check('the choice can be forced either way, and the kernel is never assumed', () => {
  assert(wantsKernel('a desk lamp', { forced: true }).use, 'could not force the kernel on');
  assert(!wantsKernel('a hex bolt', { forced: false }).use, 'could not force the shop floor');
  const off = wantsKernel('a hex bolt', { available: false });
  assert(!off.use && /not installed/.test(off.why),
    'it would have tried to use a kernel that is not there');
});

/* ================================================================== */
/* what the model is told                                              */
/* ================================================================== */
check('the prompt states the rules that actually get broken', () => {
  const p = cadSystemPrompt();
  assert(/result_part/.test(p), 'never says what to call the result');
  assert(/[Dd]o NOT export/.test(p), 'does not say the shop owns the files');
  assert(/millimet/i.test(p), 'never states the units');
  assert(/fillet/i.test(p) && /too large/i.test(p),
    'does not warn about the operation that actually fails');
  assert(/lowercase/i.test(p), 'does not head off the PascalCase 1.x API');
});

check('a script that worked before is handed back as the starting point', () => {
  const u = cadUserPrompt('a bearing block', {
    recalled: { script: 'from build123d import *\nresult_part = Box(1,1,1)', hand: true }
  });
  assert(/BuILT THIS BEFORE|BUILT THIS BEFORE/i.test(u), 'the recalled script is not announced');
  assert(/result_part = Box/.test(u), 'the script itself is missing');
  assert(/not suggestions/.test(u), 'a hand-corrected script is not marked as authoritative');
});

check('what was read off the web reaches the CAD prompt too', () => {
  const u = cadUserPrompt('a bandsaw fence', {
    read: [{ structure: ['hardwood face', 'cam clamp'], dimensions: [{ mm: 600 }, { mm: 100 }] }],
    refs: [{ title: 'Shop-made bandsaw fence' }]
  });
  assert(/hardwood face/.test(u), 'part names did not reach the CAD prompt');
  assert(/600mm/.test(u), 'quoted sizes did not reach the CAD prompt');
  assert(/Shop-made/.test(u), 'references did not reach the CAD prompt');
});

check('the repair prompt leads with the traceback and stays short', () => {
  const long = Array.from({ length: 60 }, (_, i) => `  File "x", line ${i}`).join('\n')
    + '\nValueError: fillet radius too large for edge';
  const r = repairPrompt(GOOD, long, 'a bearing block');
  assert(/fillet radius too large/.test(r), 'the actual error was trimmed away');
  assert(r.length < 9000, `the repair prompt is ${r.length} characters — mostly stack noise`);
  assert(/result_part/.test(r), 'the rules are not restated, so it will break them again');
  assert(/a bearing block/.test(r), 'the original request was dropped');
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
