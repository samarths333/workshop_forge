# Workshop Forge

A macOS desktop app. **One shop floor**, six stations across it, and a crew of six cardboard robots
who work it at the same time.

    you  →  Jarvis  →  Gaffer, the floor manager  →  five specialists
                                                  ←  the finished object

| | | |
|---|---|---|
| **Vulcan** | Structures & Metal | frames, chassis, brackets, axles — anything that carries a load |
| **Kraft** | Light Materials | cardboard, wood, plastic — panels, skins, shells, covers |
| **Ampere** | Electrical | components, values, the netlist, the power budget |
| **Mach** | Powerplant & Machining | engines — bore, stroke, rod, annulus, and everything that turns |
| **Byte** | Software & Controls | no parts at all — the requirements everyone else builds against |
| **Gaffer** | Floor Manager | writes the work order, fits it together, hands it over |

You type a build request. **Jarvis** hands the whole of it to **Gaffer**, who writes a *work order*:
the frame everything hangs off, a handful of named mount points on that frame, and one brief per
trade. Then all five specialists plan their own piece **at the same time**, each inside its own
materials, each bolting to a named mount rather than to coordinates. Their answers merge into one
plan, a deterministic solver turns it into a standing object, and the crew builds it on the floor —
walking to their own benches, working the actual material, stacking parts on their racks. Gaffer
collects the lot, carries it to the assembly bay in his arms, fits it together and hands it to Jarvis.
Nothing teleports and nothing floats.

**Why a crew and not one robot.** The old shop asked one model for the whole object in one call, and
the whole object is exactly what a model is worst at — structure, skin, electronics and proportion all
held at once, which comes out as a heap with roughly the right silhouette. Five small briefs against a
frame that is already decided is a question even a 3B model answers well. The mount points are what
make it merge: a specialist never says where its parts are, only what they bolt to.

When the job is done the floor writes down what it learned. The next request for the same kind of
thing starts from that instead of from nothing. And when it gets it wrong — it will — there is a CAD
bench where you fix it yourself, and the fix is what it learns.

---

## Run it

```bash
cd workshop-forge
npm install          # pulls electron + three
npm start
npm test             # solver, geometry, crew, engines, apprentice and wiring — no renderer needed
```

To build a real double-clickable `.app`:

```bash
npm run make         # → dist/mac/Workshop Forge.app
npm run dmg          # → dist/Workshop Forge-1.0.0.dmg
```

Unsigned, so the first launch needs right-click → Open.

---

## ⌘K

Press it anywhere. Everything the shop can do is in one list — build, stop, jump to a station, open
the bench, measure, export an STL, teach it a correction, practise something, add an API key — found
by typing the start of a label, a word from the middle, or the initials.

Two things it does that a menu does not. An action that cannot run right now is shown **greyed with
the reason** rather than hidden, so the shape of the app stays learnable. And what an action *costs*
is visible before you press enter: `uses a key`, `writes a file`, `destructive`. The one action that
destroys something asks every time, with no "don't ask again".

---

## The floor's brain

Open **Engine** in the title bar, or press ⌘K and type "api key".

**Nine engines, and anything else that speaks the OpenAI protocol.**

| | |
|---|---|
| **Anthropic** | Claude. No `response_format` exists, so the schema is forced through a tool call. Works with a Claude-compatible gateway — put the origin in Base and it switches to bearer auth. |
| **OpenAI** | Takes the JSON Schema directly. The strongest structured output on the list. |
| **Google Gemini** | Key rides in the query string; its schema dialect is a subset of JSON Schema, so the schema is stripped down on the way out. |
| **Groq** | The fastest thing here by a distance. Rate limited per minute, which a build of six calls can reach. |
| **OpenRouter** | One key, every model. |
| **NVIDIA NIM** | Free developer tier, no card. |
| **Ollama** | Local, no key, and the actual JSON Schema is pushed into the decoder — which is why a 3B model is enough. |
| **LM Studio** | Local, start the server and leave the key blank. |
| **Any OpenAI-compatible endpoint** | vLLM, llama.cpp, LiteLLM, Together, DeepSeek, Mistral, a company gateway. If it is not on the list, it goes here. |

Tick as many as you like. The shop tries them in order and moves on the moment one will not answer —
and a failure comes back **classified**, so "the key was rejected" and "could not reach it" are two
different sentences instead of two HTTP numbers. With no key at all it still builds, offline, from
what it already knows.

### Which engine does which job

A build is not one call. The floor manager writes the work order and the inspector checks the result
— two calls that want real reasoning. The five specialists answer small, tightly-schema'd briefs all
at once — five calls that want speed and not much else.

```
high     the work order, the inspection      →  your best model
medium   reflection, naming, lessons         →  anything
low      the five specialist briefs          →  your fastest and cheapest
```

Point them at different engines and you get a better object for less. Leave a job unset and it falls
up to the next one that is set, so a single engine needs no wiring at all.

Your existing NIM key and Ollama model are carried over automatically — growing a provider list is
not a reason to make anybody re-paste a key.

Press **Test both** in the Engine panel to check the lookup works before relying on it.

---

## Engines are not guessed at

Ask for an engine and **Mach** does not pick sizes — he does the arithmetic. An engine is a kinematic
chain with a governing dimension set: give a piston engine a bore, a stroke, a rod and a chamber and
every other number falls out of those four. Displacement, compression ratio, deck height, bore
spacing, block length and width at the bank angle, mean piston speed at the redline, and the firing
order. Give a turbofan a mass flow, a bypass ratio and an overall pressure ratio and the annulus area
at every station falls out of compressible flow, hub and tip diameters fall out of that, and the
stage counts fall out of a per-stage pressure ratio.

So the shop asks *which engine* and sizes it **before anybody is briefed**. The manager does not
decide the bore and neither does the specialist — every trade then works against numbers that already
agree with each other. Same rule as a resistor's body coming from the component catalogue, and worth
far more here: a crankshaft the model sized has no relationship at all to the bore it is meant to
serve, and nothing about that throws.

```
you: a 2JZ inline six
     2997.34cc (3L) inline6
     86 × 86mm on a 142mm rod, 10.5:1
     firing 1-5-3-6-2-4, 17.2 m/s at 6000rpm
     block 672.52 × 137.6 × 278mm, deck 217.8mm
```

Three families: piston ICE (inline, V, flat, radial, single), turbofan, and brushless electric. The
reciprocating architecture is lifted from the engine definitions in
[ange-yaghi/engine-sim](https://github.com/ange-yaghi/engine-sim) — a Hayabusa, a 2JZ, a GM LS, an
F136, a Merlin and a nine-cylinder radial, real to the millimetre. Turbofan sizing follows
[RohitNag11/JetEngineDesigner](https://github.com/RohitNag11/JetEngineDesigner), including its
validity list: ground clearance, LPT above HPT on mean radius, LPC inside the inner fan.

Then it is **checked**, arithmetically, in the same bench findings list as the electrical faults — a
compression ratio outside the band for its fuel and induction, a mean piston speed over 25 m/s, a rod
too short for its stroke, cylinders that would intersect, a fan that will not clear the ground, a
cycle whose turbine work cannot drive its own compressor. Every rule is tested twice, once on a build
with the fault and once on a build without it, because an optimiser that cries wolf gets switched off.

And it **turns**. Press **Run** on the bench and the crank spins, the pistons ride the real
slider-crank equation — `r·cosθ + √(l² − r²sin²θ)`, not a sine, because that second term is exactly
what makes the travel asymmetric — and each one is on its own phase from the real firing order, both
banks of a V included.

---

## Shapes are yours to make

The shop shipped with nine primitives — box, panel, cylinder, rod, cone, sphere, torus, wedge, gear —
because each one was an arm of a `switch`. Which meant a tenth was a code change, and a shape you
wanted was a shape you could not have.

A shape is **data** now: a profile, and a rule for sweeping it.

```
revolve   a half-section spun about the upright — anything that came off a lathe
extrude   an outline pushed out to a depth, holes and all — anything cut from sheet
```

**25 more ship with it.** Turned: dome, bowl, barrel, vase, funnel, spool, knob, bottle, pipe, washer,
capsule, nose cone. Sections: hex bar, angle, channel, I-beam, tee, cross. Plate: star, arch, arrow,
gusset, trapezoid, ring plate, slotted plate. The planner is told about all of them, so asking for a
bracket gets you a gusset rather than three boxes pretending.

**And you can make your own.** On the bench, press **✎** beside the shape picker or ⌘K → "make a
shape". You start from one that already exists — nobody authors a profile from an empty list — and
edit it as a list of points, one per line, in a unit square:

```
0.62 0      ← radius, height. Both 0 to 1, bottom to top.
1    0
1    1
0.62 1
0.62 0      that is a pipe: up the outside, across, back down the bore
```

It draws as you type, in the same viewport, using the **same geometry code the floor builds with** —
a preview with its own drawing path is a preview that can be right about a shape the shop then gets
wrong. Name it, save it, and from that moment it is in the shape picker, in the schema the model is
handed, and in the prompt it reads. It lives in `shapes.json` beside what the shop has learned, so it
is there tomorrow.

**The one rule that makes it safe.** Every profile is authored in a unit box and the finished mesh is
stretched onto exactly the width, height and depth the part asked for. So the solver's idea of how big
the part is and the mesh that gets drawn cannot drift — not for the shapes that ship, and not for one
you invent at midnight. That is the failure this whole app is built to avoid: parts hovering a
centimetre above their supports with nothing anywhere reporting an error.

---

## What the floor learns

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


### What it practises when you are not there

Left alone, the floor picks something to build. What it picks is **scored**, not a fixed priority
list, and the four things it weighs are:

* **a recipe that is not right yet** — the worse it is, the more a rebuild is worth
* **the trade that keeps going wrong** — if the electrical specialist has been failing to deliver or
  having its parts pulled back into its own materials, it gets a *drill*: an object that cannot be
  built without it doing real work
* **the next rung of the ladder** — each one needs a solver feature the last did not, and the
  electrical rungs stay locked until it can build the thing a circuit gets mounted in
* **something it has not re-tested in a while** — a recipe nobody re-runs is a recipe nobody has
  checked

Press ⌘K → *What would it practise next?* to see the syllabus and the reason for every item on it.

Two guards. What it teaches itself is capped below what you teach it, and a study build that fell
over files its lessons and no recipe — otherwise a night of practice makes the library worse. And
after three unsound builds in a row it **stops**: practice fixes a bad recipe, it does not fix a
wrong API key or a model that will not emit JSON, and from the inside those look identical.


## The animations

**77 clips**, indexed by room:

| room | count | examples |
|---|---|---|
| software | 5 | `type` `mouse_click` `read_screen` `boot_pc` `cable_plug` |
| cardboard | 10 | `cut_scissors` `score_fold` `glue` `tape` `measure` `punch_hole` |
| metal | 15 | `weld` `braze` `grind` `hammer_anvil` `saw_metal` `bend_metal` `quench` `rivet` |
| electronics | 6 | `solder` `strip_wire` `crimp` `breadboard` `meter_test` `power_up` |
| machining | 8 | `lathe_turn` `mill_cut` `bore_cylinder` `press_fit` `balance_crank` `dial_gauge` |
| finished | 9 | `sand` `paint` `spray_paint` `polish` `assemble` `inspect` `present` |
| any | 21 | `walk` `run` `crouch` `think` `shrug` `facepalm` `celebrate` `trip` |

Three more are marked `internal` — `pick_up`, `set_down`, `walk_carry` are played by the
executor at the moments they belong to and are deliberately kept off the menu the planner sees.

42 of them put a specific tool in a robot's hand — welding stinger, angle grinder, hacksaw, hole
punch, bone folder, spray can, micrometer, dial gauge, torque wrench, boring bar. 12 put on
headgear: the welding mask drops for `weld`, goggles for `grind`/`drill`/`quench`, a dust mask for
`sand` and `spray_paint`.
21 emit particles: sparks, swarf, dust, paint mist, steam, flame, glue drip. `weld` and `braze` also
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
  shapelib.js            THE SHAPE VOCABULARY — profiles as data, and the ones you saved
  catalog.js             THE PARTS CATALOGUE — what things are made of, and what goes inside what
  shapes.js              part spec → three.js geometry, chamfered
  roles.js               THE CREW — who works here, their materials, authority, the floor plan
  providers.js           THE ENGINES — nine of them plus a generic one, as data
  actions.js             THE COMMAND SURFACE — every capability as a row, with authority
  palette.js             ⌘K — the view over the registry
  workorder.js           the manager's decomposition: frame, mount points, one brief per trade
  crewplan.js            the specialists' briefs, their clamping, and the merge back into one plan
  shopfloor.js           the delegation ledger and the run — order → five trades at once → merge
  crew.js                six robots on the floor, one state machine each, plus the haul
  world.js               one bay, six stations, racks, pedestal, seams, baked environment map
  character.js           a robot's rig, two-bone reach IK, carrying, particles, clip playback
  animations.js          the 77 clips + evaluator
  props.js               43 hand tools + 6 headgear, all from primitives
  textures.js            procedural canvas textures — no external assets, works offline
  agent.js               prompts, JSON schemas, validator, plan editing, offline planner
  cad.js                 the bench — CAD viewport, attach tree, editable properties
  skills.js              distil / score / recall / reinforce / merge a learned build
  history.js             undo on the bench — whole plans, coalesced by field
  export3d.js            triangles → binary STL and OBJ
  library.js             source routing, domain vocabularies, structure mining off read pages
  circuit.js             components, netlist, Ohm's law, the electrical faults
  engine.js              THE ENGINEER'S ARITHMETIC — catalogues, sizing, faults, kinematics
  optimize.js            the engineer's second look — findings with real gains, and patches
  metrics.js             volume / mass / centre of mass / clearance / BOM / units
  apprentice.js          what he studies when idle, and what a study build is worth
  critic.js              solve the plan and audit what comes out
  app.js                 the pipeline, the crew panel, the traveller, UI
  forge.js               the headless build — plan, solve, render, export, for another program
test/
  solver.test.mjs        the solver and the skill library, plus the whole offline pipeline
  geometry.test.mjs      real three.js meshes measured against what the solver assumed
  shapelib.test.mjs      the profile format, the live vocabulary, and a saved shape through the shop
  catalog.test.mjs       every archetype built and checked, and the host/subsystem merge
  learning.test.mjs      offline build → skill → recall → reinforce, undo, and the exporters
  crew.test.mjs          the register, the work order, THE MERGE, the floor end to end
  providers.test.mjs     every provider's request body, JSON forcing, reply field, tiers
  apprentice.test.mjs    the study policy over a hundred cycles, and the runaway guard
  palette.test.mjs       the registry, and what typing three letters actually finds
  circuit.test.mjs       netlist, Ohm's law by hand, every electrical fault fired and kept quiet
  engine.test.mjs        displacement against real engines, the turbofan sums, every engine fault
  engineer.test.mjs      every optimiser rule fired and kept quiet, and the drift ceiling
  bench.test.mjs         mass and clearance arithmetic, units, BOM, source routing, prompt blocks
  reading.test.mjs       page scoring, dimension extraction, what reaches the prompt
  wiring.test.mjs        imports, DOM ids, IPC bridge, CSP hash, clip coverage
  wiring.test.mjs        imports, DOM ids, IPC bridge, CSP hash, clip coverage
```

`assembly.js`, `skills.js`, `history.js`, `export3d.js` and `roles.js` import nothing — no three.js,
no DOM — and `workorder.js`, `crewplan.js` and `shopfloor.js` reach for neither the renderer nor the
network. `ShopFloor` takes the model as an argument rather than calling one, so the entire six-agent
pipeline runs end to end in node against a scripted model. That is where the merge arithmetic is
actually checked. `circuit.js` and `engine.js` import nothing either, which is why a compression
ratio and a turbofan annulus area are checked against numbers anybody can look up rather than against
a screenshot. 482 checks, about a second, no window on screen.

Zero downloaded assets. Every texture — the corrugation, the flute edges, the marker-drawn hanging
signs, the robots' faces and their name plates — is drawn into a `<canvas>` at startup.

---

## How a part actually gets made

Every operation with a `part` puts real stock on the bench first, so the tool has something to
meet. `ACTION_FAMILY` in `world.js` maps the action to what it does to the material: a `cut` bites
in and the offcut tumbles off the bench, a `bend` creases around a hinge with a little springback, a
`forge` squashes down a notch per hammer blow, a `join` closes two halves and fuses them, `coat`
sweeps colour across, `quench` cools from glowing to cold.

While that runs, a two-bone CCD solver in `character.js` bends the robot's shoulder and elbow so the
tool tip lands on the work. The clip still supplies the character of the motion — the rhythm of a
hacksaw, the twitch of a welder — and the IK only corrects it enough that he is working the piece
instead of sawing air half a metre to its left.

The finished part slides to the staging rack at that station. It stays there. When every trade has
stopped making things, **Gaffer** walks to each rack, crouches, picks up an armful, carries them
across the floor and sets them down one at a time on the pedestal — sorted by part number, so the
object goes together from the bottom up even though the other robots finished in whatever order they
finished in. Four legs cut in one operation go down as four legs, out of the same armful.

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

The ↻ on any card in **What the floor has learned** builds that thing again: the request goes back in
the box, which is what makes the recall fire, so it is a real rebuild from the stored recipe rather
than a replay of a recording. With no engine reachable it still works — that is the whole point of
keeping the recipe in the shop's own vocabulary.

## It builds the whole thing you asked for

Ask for **a car with a V12 engine** and the shop used to answer with one or the other — usually a
correct V12 and no car, because the planner had one branch per request and a request only got one.
Before that it was worse: a "car" was four parts (a box, two rings and a wedge), and anything not on
a list of eight archetypes came back as the domain's part names stacked vertically on top of each
other, which is how a car arrived as a drum with a wheel balanced on it.

**Thirty-one objects, written out properly.** Car, truck, motorcycle, bicycle, train, tracked vehicle ·
aeroplane, quadcopter, helicopter, rocket, satellite · boat, submarine · table, chair, shelving, bed,
lamp · robot arm, crane, gearbox, wind turbine, pump · bridge, tower · speaker, camera, clock, guitar,
crate, keyboard. Each one is a real parts list in the shop's own attach/array vocabulary — a car is a
chassis, wheels on both ends, a body, a cabin, a bumper, a grille, headlights and an exhaust — and each
one uses the full shape library rather than the six primitives that existed when the first ones were
written.

**And a request can name two things.** Each object keeps named MOUNTS — where an engine goes, where a
circuit goes — with the room it actually has there. Ask for a car with a V12 and the shop builds the
car, sizes a real 60° V12 from its bore and stroke, scales it to the engine bay and bolts it in. The
bench still reports the engine's true numbers: it was made smaller, not made up.

**Then it works.** A part that turns says so, and pressing **Run** turns all of it — the crankshaft on
its firing order, the wheels, a drone's propellers, a crane's turntable. A car with a running engine
and four wheels welded solid is not a car that works.

Everything in the catalogue is checked by **building it**. A hand-written attach tree fails silently —
four shelves land in the same place, a part hangs off the one arrayed sibling that pairs with it,
something with nothing under it gets quietly dropped somewhere else — so the test suite solves all
thirty-one and fails on the solver's own report: nothing floated, nothing toppled, and anything
arrayed came out in as many places as it has copies.

---

## It only pulls what makes sense

Two things go looking for prior work before a build starts — the skill library, and the reference
lookup — and both used to be too eager about it.

**A skill is recalled on what it IS, not on a word it happens to carry.** Every token of a request
used to be filed as a keyword of whatever got built, so a rover built to carry a bookshelf was filed
under `bookshelf` forever, and a confident skill cleared the recall bar on a single keyword hit. Ask
for a bookshelf a month later and the planner was handed a rover. Now the skill's **identity** — its
class, the words that mean that class, and what it is called — is the only thing that can carry a
recall; keywords corroborate and never carry on their own. And because nobody asks for a "vehicle",
identity includes the words people actually use: a car, a truck, a buggy all find the vehicle you
already built.

**A reference has to be about the thing.** Ranking kept anything that shared one word with the
search, which is how a listing called *Model Rocket Engine Holder* came back for "a car with an
engine" — and then went into the prompt as an example of the object being built. What counts now is
*which* word: the thing being asked for is worth far more than a word that merely appears near it, and
`mount`, `remix`, `v2` and `printable` are worth nothing at all. Popularity is the tie-break, never
the argument.

**And the shop works out what the request is about, rather than what it mentions.** The domains were
an ordered list and the order was doing the deciding — "a car with an engine" met the engine
vocabulary first and got sent to NASA. Each domain is now weighed on how much of its vocabulary is
present, how specific each hit is, and how early it appears, because people name the thing before the
things on it. Same request today: *vehicles*, three references instead of twelve, and the rover it
already knows how to build.

---

## What this is not

The floor's output is **representative, not literal.** The LLM picks a shape, material, and rough
dimensions per part, and the app renders that primitive. It is not doing CAD — asking for a desk
lamp gets you a cone, a rod and a base, correctly proportioned, correctly stacked, welded at the
joints and sequenced through the rooms with the correct tools. It is not a manufacturable lamp.
Wiring the plan output into the Fluteworks cut-file generator is the obvious next move and is not
built.

Parts touch, stack, hang off each other and get welded where they meet. They are not constrained,
there is no mating, and a hinge is a rod next to a hole rather than a hinge.
