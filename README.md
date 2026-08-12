# Workshop Forge

A macOS desktop app. Four connected rooms — **Software → Cardboard → Finished → Metal** — and a
cardboard robot called **Rivet** who walks between them and physically builds whatever you ask for,
using the tools and materials in each room.

You type a build request. An LLM turns it into an ordered list of shop operations. Rivet executes
them: walks to the right room, picks up the right tool, puts on the right headgear, works the actual
material on the bench, sets each finished part on the rack, then hauls the lot to the gallery in his
arms and assembles them on the pedestal. Nothing teleports and nothing floats.

When the job is done he writes down what he learned. The next request for the same kind of thing
starts from that instead of from nothing. And when he gets it wrong — he will — there is a CAD bench
where you fix it yourself, and the fix is what he learns.

---

## Run it

```bash
cd workshop-forge
npm install          # pulls electron + three
npm start
npm test             # solver, geometry and wiring checks — no renderer needed
```

To build a real double-clickable `.app`:

```bash
npm run make         # → dist/mac/Workshop Forge.app
npm run dmg          # → dist/Workshop Forge-1.0.0.dmg
```

Unsigned, so the first launch needs right-click → Open.

---

## Rivet's brain

Open **Engine** in the title bar. Routing is `auto` by default:

**1 — NVIDIA NIM (primary).**
Free key at [build.nvidia.com](https://build.nvidia.com) — join the developer program, no credit
card. OpenAI-compatible endpoint at `integrate.api.nvidia.com/v1`. Rate limit sits around 40
requests/minute, which is enormous compared to what this app needs (one call per build).

Default model is `openai/gpt-oss-120b`: fast, free, and reliable at emitting a JSON object.
Press **Test both** in the Engine panel — it hits `/v1/models` and populates the dropdown with
whatever your key can actually reach today, so you're picking from the live catalog instead of a
hardcoded guess. `deepseek-ai/deepseek-v3.2` and the GLM family are also good picks here.

**2 — Ollama (fallback).**
Triggers on a missing key, an HTTP error, or a 60s timeout.

```bash
ollama pull llama3.2:3b
```

**Use `llama3.2:3b`.** ~2 GB on disk, ~3 GB resident, 28–35 tok/s on an M2 Air, runs on an 8 GB
machine without touching swap. The reason a 3B model is enough: the Ollama request sends a JSON
Schema in the `format` field, which constrains the decoder directly. The model cannot emit malformed
JSON or an action name that doesn't exist. It only has to pick sensible steps, not also remember to
close its braces.

If you have 16 GB and want better step ordering, `qwen2.5:7b` (~4.5 GB) is the upgrade. Anything
larger is wasted on this task.

**3 — Offline planner.**
If both are unreachable the app still works. A keyword matcher builds an 18-step plan from the
request. It's obviously dumber, and the log says so.

The API key lives in the Electron main process and never enters the renderer. Network calls happen
main-side, which is also why this is an app and not a web page — no CORS wall between you and
`localhost:11434`.

---

## The bench

Press **Bench** in the title bar, or **B**. The shop view is replaced by a CAD workspace on the same
canvas — the assembly on its own, on a 100mm grid, with the pedestal footprint marked so you can see
what has to fit.

| | |
|---|---|
| **Browser** | the attach tree, nested by what is bolted to what. Arrays collapse to one row with a count. Click to select, click the dot to hide. |
| **Explode** | drag and the parts pull apart along their attach vectors. This is the fastest way to see why something does not read as a lamp. |
| **View cube** | bottom right, clickable. Or `1` `2` `3` `4` for front, top, right, iso. |
| **Ortho** | snapped views go orthographic automatically. Proportions are a lie in perspective — a rocket that looks fine in 3/4 is obviously wrong from the front. |
| **Shaded / Edges / Wire / X-ray** | `X` toggles x-ray, which shows parts buried inside other parts. |

Orbit with left-drag, pan with shift-drag or the middle button, scroll to zoom, `F` to fit.

### Fixing it, and making the fix stick

Every field in the properties panel is live. Change a shape, a size, a rotation, what a part is
bolted to and which face, how many there are — the assembly re-solves as you type, and if the build
has already finished, the pedestal in the shop updates with it. **Add part** and **Scrap this part**
work too; attachments are renumbered underneath so nothing is left pointing at a part that no longer
exists.

**Undo** (⌘Z, ⇧⌘Z to redo) covers all of it, including a scrapped part. Because the panel fires on
every keystroke, typing `0.42` into a size field is one undo, not four — edits to the same field in
quick succession fold together, so stepping back undoes the thing you did rather than the events the
browser happened to emit. The stack starts fresh with each new job: you cannot undo your way out of
this build and into the last one.

Then press **Teach Rivet this**. Your corrected geometry becomes the stored recipe for that class,
and the *diff* becomes the lessons:

```
learns: The shade has to be a cone, not a box.
learns: The shade is 0.44m wide, not 0.20m — the proportion matters.
learns: There are 4 of the leg, arranged quad — not one.
```

A hand-corrected skill is marked ✋ in the library, is trusted at 88% against the 40–75% a model-only
build earns, and is handed to the planner with different wording: *a person corrected this by hand,
follow its structure closely, these corrections are not suggestions.*

That is the loop that actually fixes "it doesn't look right". The model gets a lamp wrong; you spend
thirty seconds on the bench making it a lamp; every lamp after that starts from yours.

---

## Reference designs

Before planning anything, Rivet goes and looks at how people actually make the thing you asked for.

**Thingiverse first** — everything on it is openly licensed, and the REST API is documented and
stable. It wants a free App Token: create an app at
[thingiverse.com/developers/apps](https://www.thingiverse.com/developers/apps) and paste the token
into **Engine → Reference designs**. **Printables** is the backup and needs no token, but the
endpoint it uses is the one their own front end talks to rather than a published contract, so it is
treated as best-effort. A failed lookup never blocks a build.

What comes back — real titles, tags and descriptions — goes straight into the planning prompt:

```
HOW PEOPLE ACTUALLY MAKE THIS
  · Adjustable Phone Stand with Cable Slot   [thingiverse, 4200 likes]
      tags: phone, stand, adjustable, desk
      "60 degree back rest with a lip at the front and a slot for the cable"
```

This is the cheapest fix for output that doesn't look right, because the failure mode it addresses
is the model guessing. "A phone stand" is two words; a model with nothing else to go on produces a
wedge. A model that has just read eight real ones knows there is a back at an angle, a lip at the
front and a cable slot, and knows what those parts are called. The same list goes to the inspector,
which is then allowed to fail a build for *missing a part that every real one has*.

It is reference, not instruction — the prompt is explicit that what you actually asked for wins
where the two disagree, and that titles are not to be copied.

Press **Test both** in the Engine panel to check the lookup works before relying on it.

---

## What Rivet learns

Every finished build leaves a **skill** behind, filed under a one-word class — `lamp`, `table`,
`rocket`, `vehicle`. A skill holds three things:

* the **recipe** — the parts in the shop's own attach/array vocabulary, lifted from the geometry
  that actually passed inspection, so it can be replayed as a plan
* the **process** — the order of operations that produced it
* the **lessons** — what inspection had to correct, in one sentence each

On the next request the closest skill is scored on keyword and class overlap and, if it is close
enough, the proven structure is injected into the planner's prompt: *you have built this before,
here is what worked, adapt it.* The badge in the title bar tells you when that happens.

The split is deliberate. The **model** supplies semantics — what to call this, which words should
recall it, what the lesson was. The **code** supplies geometry, always taken from the solved
assembly, never from the model's description of it. A model that hallucinated its own past work
would poison the memory inside three builds.

Confidence goes up faster for a build that needed no corrections. A rebuild of a known class
replaces the stored recipe with the newer, corrected one — that replacement *is* the learning. If
the same fault comes back twice, the log says so, because it means the lesson on file is not
landing.

It works offline too. Build a lamp once with a model reachable, and the keyword planner will build
a proper lamp from the learned recipe with no network at all.

Skills live in `skills.json` next to `settings.json` in Electron's `userData`, and there are Export
and Import buttons under the job traveler.

---

## The animations

**63 clips**, indexed by room:

| room | count | examples |
|---|---|---|
| software | 5 | `type` `mouse_click` `read_screen` `boot_pc` `cable_plug` |
| cardboard | 10 | `cut_scissors` `score_fold` `glue` `tape` `measure` `punch_hole` |
| metal | 15 | `weld` `grind` `hammer_anvil` `saw_metal` `drill` `bend_metal` `quench` `rivet` |
| finished | 9 | `sand` `paint` `spray_paint` `polish` `assemble` `inspect` `present` |
| any | 25 | `walk` `run` `crouch` `think` `shrug` `facepalm` `celebrate` `trip` |

Three of those are marked `internal` — `pick_up`, `set_down`, `walk_carry` are played by the
executor at the moments they belong to and are deliberately kept off the menu the planner sees.

32 of them put a specific tool in Rivet's hand — welding stinger, angle grinder, hacksaw, hole
punch, bone folder, spray can, magnifier, 28 in total. 7 put on headgear: the welding mask drops
for `weld`, goggles for `grind`/`drill`/`quench`, a dust mask for `sand` and `spray_paint`.
16 emit particles: sparks, swarf, dust, paint mist, steam, flame, glue drip. `weld` and `braze` also
drive a flickering coloured point light off his hand.

Clips are **procedural, not mocap**: each is a static pose plus a set of sine oscillators on named
joints, blended over 0.22s on transition. `weld` is nine lines of config. That's how you get 63 of
them and can add a 64th in about a minute — open `renderer/animations.js` and add an `A(...)` entry.
It will immediately be available to the LLM, because the action enum in the prompt and the JSON
schema are both generated from that file.

---

## Files

```
main.js                  Electron main — window, settings, LLM transport, skill library on disk
preload.js               contextBridge surface, no node in renderer
renderer/
  assembly.js            the solver: attach graph, arrays, gravity, separation, joints
  shapes.js              part spec → three.js geometry, chamfered
  world.js               4 rooms, staging racks, pedestal, seams, baked environment map
  character.js           Rivet's rig, two-bone reach IK, carrying, particles, clip playback
  animations.js          the 63 clips + evaluator
  props.js               28 hand tools + 5 headgear, all from primitives
  textures.js            procedural canvas textures — no external assets, works offline
  agent.js               prompts, JSON schemas, validator, plan editing, offline planner
  cad.js                 the bench — CAD viewport, attach tree, editable properties
  skills.js              distil / score / recall / reinforce / merge a learned build
  history.js             undo on the bench — whole plans, coalesced by field
  export3d.js            triangles → binary STL and OBJ
  critic.js              solve the plan and audit what comes out
  app.js                 executor state machine + UI
test/
  solver.test.mjs        the solver and the skill library, plus the whole offline pipeline
  geometry.test.mjs      real three.js meshes measured against what the solver assumed
  learning.test.mjs      offline build → skill → recall → reinforce, undo, and the exporters
  wiring.test.mjs        imports, DOM ids, IPC bridge, CSP hash, clip coverage
```

`assembly.js`, `skills.js`, `history.js` and `export3d.js` import nothing — no three.js, no DOM —
which is why the whole planning, layout, memory and export path can be tested in node with
`npm test` and no window on screen. 137 checks, about a second.

Zero downloaded assets. Every texture — the corrugation, the flute edges, the marker-drawn hanging
signs, Rivet's face — is drawn into a `<canvas>` at startup.

---

## How a part actually gets made

Every operation with a `part` puts real stock on the bench first, so the tool has something to
meet. `ACTION_FAMILY` in `world.js` maps the action to what it does to the material: a `cut` bites
in and the offcut tumbles off the bench, a `bend` creases around a hinge with a little springback, a
`forge` squashes down a notch per hammer blow, a `join` closes two halves and fuses them, `coat`
sweeps colour across, `quench` cools from glowing to cold.

While that runs, a two-bone CCD solver in `character.js` bends Rivet's shoulder and elbow so the
tool tip lands on the work. The clip still supplies the character of the motion — the rhythm of a
hacksaw, the twitch of a welder — and the IK only corrects it enough that he is working the piece
instead of sawing air half a metre to its left.

The finished part slides to the staging rack in that room. It stays there. When the plan reaches
the gallery, Rivet walks to each rack, crouches, picks up an armful, carries them across the shop
and sets them down one at a time on the pedestal. Four legs cut in one operation go down as four
legs, out of the same armful.

## How it ends up looking like the thing

The planner never gives coordinates. It says what each part is bolted to:

```json
{ "name": "leg", "shape": "rod", "size": [0.12, 0.68, 0.12],
  "attach": { "to": 0, "face": "bottom" },
  "array":  { "mode": "quad", "radius": 0.44 } }
```

`assembly.js` resolves that: expands the array into four legs, walks the attach tree, stands the
assembly on the pedestal, drops anything unsupported onto whatever is below it, pushes apart
anything driven into itself, scales the whole thing to fit the pedestal, and finds every contact
patch. Steel meeting steel gets a weld bead, cardboard gets a glue fillet, everything else gets
bolts. Nothing floats regardless of what the model claimed, and models claim a lot.

The arrays are the part that matters most in practice. Models reliably forget the second, third and
fourth leg, but they never forget to *say* "four legs" if there is somewhere to say it.

## Taking it out of the shop

Under the job traveler: **Plan**, **STL**, **OBJ**. The first is the plan and the solved layout as
JSON. The other two are the object itself, straight off the pedestal — every part, plus the weld
beads and bolts collapsed into one `seams` object, with each part kept as its own solid so the
assembly opens as an assembly.

Two conventions, because getting either wrong gives you a file that opens fine and is useless:

- **Millimetres.** The shop thinks in metres and STL carries no units at all, so a slicer assuming
  millimetres would import a 0.4m part as a speck. Everything is scaled ×1000 on the way out.
- **STL is Z-up, OBJ is Y-up.** three.js is Y-up and printers are Z-up, so the STL is swung round
  and lands flat in a slicer instead of on its side. OBJ is read by modellers that are mostly Y-up,
  so it is left alone.

Degenerate facets — tessellating a cone tip reliably makes a few — are dropped before writing, and
`learning.test.mjs` checks the byte layout, the facet count, the units, the rotation and the vertex
sharing rather than trusting that a file which opens is a file that is right.

The ↻ on any card in **What Rivet has learned** builds that thing again: the request goes back in
the box, which is what makes the recall fire, so it is a real rebuild from the stored recipe rather
than a replay of a recording. With no engine reachable it still works — that is the whole point of
keeping the recipe in the shop's own vocabulary.

## What this is not

Rivet's output is **representative, not literal.** The LLM picks a shape, material, and rough
dimensions per part, and the app renders that primitive. It is not doing CAD — asking for a desk
lamp gets you a cone, a rod and a base, correctly proportioned, correctly stacked, welded at the
joints and sequenced through the rooms with the correct tools. It is not a manufacturable lamp.
Wiring the plan output into the Fluteworks cut-file generator is the obvious next move and is not
built.

Parts touch, stack, hang off each other and get welded where they meet. They are not constrained,
there is no mating, and a hinge is a rod next to a hole rather than a hinge.
