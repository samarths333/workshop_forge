/* The repair loop.

   `buildWithKernel` takes `ask` and `run` as arguments for exactly this
   reason: the whole loop can be driven against a scripted model and a
   scripted kernel, so every branch — refused by the gate, thrown by the
   kernel, ran-but-useless, gave up — is checked in a millisecond with no
   network and no Python.

   Then, at the bottom, the same loop is run against the REAL build123d
   kernel, because a loop that works against a fake is not evidence that
   it works.

     node test/cadbuild.test.mjs
*/
import {
  buildWithKernel, cadRecipe, recallScript, describeAttempts, MAX_ATTEMPTS
} from '../renderer/cadbuild.js';
import { gateScript } from '../renderer/cadscript.js';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const out = [];
const check = async (name, fn) => {
  try { await fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const GOOD_SCRIPT = `from build123d import *
with BuildPart() as p:
    Box(40, 30, 12)
    Cylinder(6, 12, mode=Mode.SUBTRACT)
result_part = p.part`;

/* A model that says whatever it is told to, in order. */
const scriptedModel = (...replies) => {
  let i = 0;
  const seen = [];
  const ask = async messages => {
    seen.push(messages);
    const r = replies[Math.min(i++, replies.length - 1)];
    return r === null ? { ok: false } : { ok: true, text: r, engine: 'scripted' };
  };
  ask.seen = seen;
  return ask;
};

/* A kernel that answers however the test needs. */
const scriptedKernel = (...answers) => {
  let i = 0;
  const ran = [];
  const run = async code => { ran.push(code); return answers[Math.min(i++, answers.length - 1)]; };
  run.ran = ran;
  return run;
};

const SOUND = {
  ok: true,
  metrics: { volume: 12000, size: [40, 30, 12], faces: 9, edges: 21, solids: 1, valid: true },
  files: { stl: '/tmp/x.stl', step: '/tmp/x.step' },
  mesh: [0, 0, 0]
};

/* ================================================================== */
/* the happy path                                                      */
/* ================================================================== */
await check('a good script first time runs once and keeps the script', async () => {
  const ask = scriptedModel('```python\n' + GOOD_SCRIPT + '\n```');
  const run = scriptedKernel(SOUND);
  const r = await buildWithKernel('a bracket', { ask, run });

  assert(r.ok, `it failed: ${r.error}`);
  assert(r.attempts === 1, `${r.attempts} attempts for a script that was fine`);
  assert(run.ran.length === 1, `the kernel was called ${run.ran.length} times`);
  assert(r.script.includes('BuildPart'), 'the working script was not kept');
  assert(r.files.step, 'the STEP file was dropped');
  assert(r.metrics.volume === 12000, 'the measurements were dropped');
});

await check('the fences come off before anything runs', async () => {
  const run = scriptedKernel(SOUND);
  await buildWithKernel('a bracket', {
    ask: scriptedModel('Here you go:\n```python\n' + GOOD_SCRIPT + '\n```\nHope that helps!'), run
  });
  assert(!run.ran[0].includes('```'), 'a fence reached the kernel');
  assert(!/Hope that helps/.test(run.ran[0]), 'prose reached the kernel');
});

/* ================================================================== */
/* the gate runs FIRST, and costs nothing                              */
/* ================================================================== */
await check('a dangerous script never reaches the kernel at all', async () => {
  /* This is the whole reason the gate is before the run rather than
     after it. A refusal has to cost no process and no seconds. */
  const ask = scriptedModel(
    'import os\nos.system("rm -rf ~")\nresult_part = 1',
    GOOD_SCRIPT
  );
  const run = scriptedKernel(SOUND);
  const r = await buildWithKernel('a bracket', { ask, run });

  assert(r.ok, 'it never recovered');
  assert(run.ran.length === 1, `the kernel was called ${run.ran.length} times — the bad script was executed`);
  assert(!run.ran[0].includes('os.system'), 'the dangerous script reached the kernel');
  assert(r.history[0].stage === 'gate', `first failure was recorded as ${r.history[0].stage}`);
});

await check('the model is told exactly why it was refused', async () => {
  const ask = scriptedModel('import subprocess\nresult_part = 1', GOOD_SCRIPT);
  await buildWithKernel('a bracket', { ask, run: scriptedKernel(SOUND) });

  const repair = ask.seen[1].at(-1).content;
  assert(/refused/i.test(repair), 'the repair prompt does not say it was refused');
  assert(/standard library|imported/i.test(repair),
    `the reason is not specific enough to act on:\n${repair.slice(0, 200)}`);
});

/* ================================================================== */
/* the traceback is the correction signal                              */
/* ================================================================== */
await check('a kernel exception goes back to the model verbatim', async () => {
  /* The entire argument for this feature: a fillet that is too big does
     not come out subtly wrong, it raises, and that message is worth more
     than any critique. */
  const ask = scriptedModel(GOOD_SCRIPT, GOOD_SCRIPT);
  const run = scriptedKernel(
    {
      ok: false, stage: 'execute',
      error: 'StdFail_NotDone: BRep_API: command not done',
      traceback: 'Traceback (most recent call last):\n  File "<cad_script>", line 5\n'
        + '    fillet(p.edges(), radius=20)\nStdFail_NotDone: fillet radius too large for edge'
    },
    SOUND
  );
  const r = await buildWithKernel('a bracket', { ask, run });

  assert(r.ok && r.attempts === 2, `attempts: ${r.attempts}, ok: ${r.ok}`);
  const repair = ask.seen[1].at(-1).content;
  assert(/fillet radius too large/.test(repair),
    `the actual kernel error did not reach the model:\n${repair.slice(0, 300)}`);
  assert(/result_part/.test(repair), 'the rules were not restated, so it will break them again');
});

await check('the model sees what it already tried', async () => {
  const ask = scriptedModel(GOOD_SCRIPT, GOOD_SCRIPT);
  await buildWithKernel('a bracket', {
    ask, run: scriptedKernel({ ok: false, stage: 'execute', error: 'boom' }, SOUND)
  });
  const second = ask.seen[1];
  assert(second.some(m => m.role === 'assistant' && /BuildPart/.test(m.content)),
    'the failed script was not put back in the conversation');
});

await check('the conversation does not grow without bound', async () => {
  const ask = scriptedModel(GOOD_SCRIPT, GOOD_SCRIPT, GOOD_SCRIPT);
  await buildWithKernel('a bracket', {
    ask, run: scriptedKernel({ ok: false, stage: 'execute', error: 'boom' })
  });
  // opening brief + the last exchange, never a full transcript of every failure
  for (const messages of ask.seen) {
    assert(messages.length <= 4, `${messages.length} messages — the transcript is accumulating`);
  }
});

/* ================================================================== */
/* ran is not the same as worked                                       */
/* ================================================================== */
await check('a script that runs and makes nothing goes back round', async () => {
  const ask = scriptedModel(GOOD_SCRIPT, GOOD_SCRIPT);
  const run = scriptedKernel(
    { ok: true, metrics: { volume: 0, size: [10, 10, 0], faces: 1, solids: 0 }, files: {}, mesh: [] },
    SOUND
  );
  const r = await buildWithKernel('a bracket', { ask, run });

  assert(r.ok && r.attempts === 2, 'an empty result was accepted as a build');
  const repair = ask.seen[1].at(-1).content;
  assert(/no volume|not usable/i.test(repair), `it was not told what was wrong:\n${repair.slice(0, 200)}`);
});

await check('a units mistake is caught even though the script ran perfectly', async () => {
  const ask = scriptedModel(GOOD_SCRIPT, GOOD_SCRIPT);
  const run = scriptedKernel(
    { ok: true, metrics: { volume: 8e9, size: [2000, 2000, 2000], faces: 6, solids: 1 }, files: {}, mesh: [] },
    SOUND
  );
  const r = await buildWithKernel('a bracket', { ask, run });
  assert(r.attempts === 2, 'a two-metre part was accepted');
  assert(/across/.test(ask.seen[1].at(-1).content), 'it was not told the part was too big');
});

/* ================================================================== */
/* giving up                                                           */
/* ================================================================== */
await check('it stops after three, and says what went wrong', async () => {
  const ask = scriptedModel(GOOD_SCRIPT);
  const run = scriptedKernel({ ok: false, stage: 'execute', error: 'StdFail_NotDone' });
  const r = await buildWithKernel('a bracket', { ask, run });

  assert(!r.ok, 'it claimed success after three failures');
  assert(run.ran.length === MAX_ATTEMPTS, `the kernel ran ${run.ran.length} times`);
  assert(r.history.length === MAX_ATTEMPTS, 'the history is incomplete');
  assert(/StdFail/.test(describeAttempts(r)), `the summary hides the reason: ${describeAttempts(r)}`);
});

await check('no engine means no run at all', async () => {
  const run = scriptedKernel(SOUND);
  const r = await buildWithKernel('a bracket', { ask: scriptedModel(null), run });
  assert(!r.ok && /no engine/i.test(r.error), r.error);
  assert(run.ran.length === 0, 'it ran the kernel with nothing to run');
});

await check('a kernel that will not start is a failure, not a crash', async () => {
  const r = await buildWithKernel('a bracket', {
    ask: scriptedModel(GOOD_SCRIPT),
    run: async () => { throw new Error('python is not installed'); }
  });
  assert(!r.ok, 'it claimed success');
  assert(r.history.some(h => /python/.test(h.problem)), 'the reason was swallowed');
});

/* ================================================================== */
/* what gets remembered                                                */
/* ================================================================== */
await check('a working script is what goes in the library', async () => {
  const r = await buildWithKernel('a bearing block', {
    ask: scriptedModel(GOOD_SCRIPT), run: scriptedKernel(SOUND)
  });
  const recipe = cadRecipe(r, 'a bearing block');
  assert(recipe.kind === 'cad', 'not filed as a CAD recipe');
  assert(recipe.script.includes('BuildPart'), 'the script itself was not kept');
  assert(recipe.volume_mm3 === 12000 && recipe.size_mm.join() === '40,30,12',
    'the measurements were not kept alongside it');
  assert(cadRecipe({ ok: false }, 'x') === null, 'a failed build was filed anyway');
});

await check('a remembered script comes back, and a hand-taught one says so', async () => {
  const skill = { recipe: { cad: { script: GOOD_SCRIPT } }, confidence: 0.55, stats: {} };
  const got = recallScript({ skill });
  assert(got.script === GOOD_SCRIPT, 'the script did not come back');
  assert(got.hand === false, 'a model-built script was marked as hand-taught');

  const taught = recallScript({ skill: { ...skill, stats: { taught: 1 } } });
  assert(taught.hand === true, 'a hand-corrected script was not marked as authoritative');

  // a primitive recipe has no script, and must not pretend otherwise
  assert(recallScript({ skill: { recipe: { parts: [{ name: 'base' }] } } }) === null,
    'a primitive recipe was offered as a CAD script');
  assert(recallScript(null) === null, 'null threw');
});

await check('a remembered script is handed to the model as the starting point', async () => {
  const ask = scriptedModel(GOOD_SCRIPT);
  await buildWithKernel('a bearing block', {
    ask, run: scriptedKernel(SOUND),
    recalled: { script: 'from build123d import *\nresult_part = Box(9,9,9)', hand: true }
  });
  const opening = ask.seen[0].at(-1).content;
  assert(/Box\(9,9,9\)/.test(opening), 'the remembered script was not offered');
  assert(/not suggestions/.test(opening), 'a hand-taught script was not marked as authoritative');
});

/* ================================================================== */
/* and now against the real thing                                      */
/* ================================================================== */
/* Everything above is a fake kernel. This is the same loop against real
   build123d, because a loop that only works against a fake is not
   evidence of anything. Skipped with a loud note if the kernel is not
   installed — the whole feature is optional by design. */
let havePython = false;
try {
  execFileSync('python3', ['-c', 'import build123d'], { stdio: 'ignore' });
  havePython = true;
} catch { /* no kernel here */ }

if (!havePython) {
  out.push('  --    build123d is not installed, so the real-kernel checks were skipped');
} else {
  /* The kernel exits non-zero when the script failed, which is correct —
     and it means the answer arrives on stdout of a process that "failed".
     execFileSync throws on a non-zero exit, so the output has to be read
     off the error. main.js uses spawn and reads the code directly for the
     same reason. */
  const realKernel = async code => {
    const job = JSON.stringify({ code, out: '/tmp/wf-cadtest', stem: 'test', mesh: false });
    let raw;
    try {
      raw = execFileSync('python3', [`${root}/cad/kernel.py`], { input: job, encoding: 'utf8' });
    } catch (e) {
      raw = e.stdout || '';
      if (!raw.trim()) throw new Error(`the kernel said nothing: ${String(e.stderr || '').slice(-200)}`);
    }
    return JSON.parse(raw.trim().split('\n').pop());
  };

  await check('the real kernel builds a real part through the whole loop', async () => {
    const r = await buildWithKernel('a bearing block', {
      ask: scriptedModel('```python\n' + GOOD_SCRIPT + '\n```'),
      run: realKernel
    });
    assert(r.ok, `the real kernel refused it: ${r.error}`);
    // 40 × 30 × 12 = 14400, less a Ø12 bore through 12 = π·36·12 = 1357.2
    const expect = 40 * 30 * 12 - Math.PI * 36 * 12;
    assert(Math.abs(r.metrics.volume - expect) < 1,
      `volume came out ${r.metrics.volume.toFixed(1)}, worked by hand it is ${expect.toFixed(1)}`);
    assert(r.files.step && r.files.stl, `it did not write both files: ${Object.keys(r.files)}`);
    assert(r.metrics.solids === 1, `${r.metrics.solids} solids — that is not one part`);
  });

  await check('a real kernel error drives a real repair', async () => {
    /* A fillet far too large for the edge. build123d raises, the loop
       feeds the traceback back, and the second attempt succeeds — the
       whole argument for the feature, end to end. */
    const tooBig = `from build123d import *
with BuildPart() as p:
    Box(20, 20, 4)
    fillet(p.edges(), radius=50)
result_part = p.part`;
    const ask = scriptedModel(tooBig, GOOD_SCRIPT);
    const r = await buildWithKernel('a plate', { ask, run: realKernel });

    assert(r.attempts === 2, `attempts: ${r.attempts} — the oversized fillet should have failed`);
    assert(r.ok, `it never recovered: ${r.error}`);
    const repair = ask.seen[1].at(-1).content;
    assert(repair.length > 100, 'nothing was fed back');
    assert(/error|fail|Std|not done|Traceback/i.test(repair),
      `the kernel error did not reach the model:\n${repair.slice(0, 300)}`);
  });

  await check('the real kernel refuses to run what the gate would refuse', async () => {
    /* Defence in depth: kernel.py checks the text again, because the day
       the gate has a hole in it is the day this matters. */
    const r = await realKernel('import os\nos.system("echo pwned")\nresult_part = 1');
    assert(!r.ok, 'the kernel executed a script the gate would have refused');
    assert(r.stage === 'refused', `it failed at ${r.stage} rather than refusing outright`);
  });

  await check('a sketch that was never extruded is named as the problem', async () => {
    const r = await realKernel(`from build123d import *
with BuildSketch() as s:
    Circle(10)
result_part = s.sketch`);
    assert(!r.ok || (r.metrics && r.metrics.volume === 0),
      'a flat sketch was accepted as a solid part');
  });
}

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
