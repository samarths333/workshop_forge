# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app (macOS). ONE open shop floor rendered in Three.js, with six stations across it
— Software · Metal · Assembly · Light materials · Electronics · Machine shop — and a crew of six
cardboard robots who work it at the same time.

The chain of command is the architecture:

    person → Jarvis → Gaffer (floor manager) → five specialists
                                            ← the finished object

Jarvis takes the request and owns the conversation. Gaffer decomposes it into a WORK ORDER — a small
frame, a set of named mount points on that frame, and one assignment per trade. Every specialist then
plans its OWN subassembly, at the same time as the others, against those mount points and inside its
own materials. Their answers are merged into one plan, the deterministic solver turns it into a
standing object, the crew plays it out on the floor, and Gaffer carries it to the pedestal and hands
it to Jarvis.

Why it is built that way: the old shop asked one model for the whole object in one call, and the whole
object is the thing a model is worst at — structure, skin, electronics and proportion all held at once,
producing a heap with roughly the right silhouette. Four small briefs against a fixed frame is a
question a 3B model can answer well. **The mount points are the load-bearing idea**: a specialist
never gives coordinates and never refers to another trade's parts, it says "this bolts to `mast_top`",
and the merge resolves that. That is what makes parallel work produce one object instead of four.

Each finished build is still distilled into a reusable skill and recalled on the next similar request.

## Commands

```bash
npm install          # electron + three
npm start             # run app
npm run dev            # run app with --dev (opens detached DevTools)
npm test                # solver, geometry, learning, crew and wiring checks — no renderer, no window
npm run make             # electron-builder --mac --dir  → dist/mac/Workshop Forge.app
npm run dmg               # electron-builder --mac        → dist/Workshop Forge-1.0.0.dmg
```

No linter configured. Built app is unsigned — first launch needs right-click → Open.

## Architecture

**The crew is data (`renderer/roles.js`).** Who works here, what each of them may touch, and what
each is for. The shape of a role is lifted from Jarvis (usejarvis.dev): a `description` that becomes a
system prompt, `responsibilities`, `autonomous` actions, `approval`-gated ones, a communication style
and an `authority` level. What is added for a workshop is a MATERIAL ENVELOPE — in a shop, authority
is not only what you are permitted to do, it is what you actually know how to make. `materials` and
`owns` answer different questions and conflating them is a real bug: `materials` is the envelope
(`clampMaterial` enforces it), `owns` is the routing (who a part of this material belongs to when
nobody said). The electrical specialist WORKS in plastic and OWNS none of it, because an electrical
part is routed by being a component. `owns` is a partition over `MATERIALS`, and `crew.test.mjs`
fails if two trades claim the same one. `STATION_X` lives here too — the optimiser prices walks off
it and cannot import world.js.

**The work order is written before anybody picks up a tool (`renderer/workorder.js`).** 1–4 frame
parts, up to 8 named mounts, one assignment per trade. `validateOrder` is the contract exactly as
`validatePlan` is: every frame attachment points backwards, part 0 has no attach, every mount lands on
a frame part that exists, no trade is assigned twice, nobody is over budget, and controls never gets a
parts budget. A work order that gets past it is guaranteed mergeable, and `crewplan.js` assumes all of
that. `splitPlan` is the other half — with no engine, it takes the plan the offline planner already
knows and hands it out by trade rather than letting five robots improvise. `crew.test.mjs` asserts
every archetype survives that split part for part, because an offline build getting worse would be a
crew that is a downgrade wearing an org chart.

**The merge is where the whole thing is won or lost (`renderer/crewplan.js`).** Every specialist
numbers its parts from zero. `mergeSubplans` lays the frame down first, then walks the crew in a FIXED
order, offsetting each block: a local `attach.to` becomes `offset + to`, a `mount` name becomes a real
attachment on a real frame part, and every wire pin is shifted with the parts that own it. Get that
renumbering wrong and nothing throws — half the object silently reparents onto the wrong thing, solves
fine, renders fine, and is quietly the wrong object. Same failure class as `reindexAttachments`, tested
the same way: on indices, not on the absence of a crash.

**The floor takes the model as an argument (`renderer/shopfloor.js`).** `ShopFloor` is handed an `ask`
function and never knows what an LLM is, which is what lets the entire pipeline run end to end under
node against a scripted model — the merge arithmetic is checked there, not by looking at a window. The
delegation ledger is Jarvis's task manager: work is launched rather than awaited one at a time, every
task carries queued → running → delivered | failed | denied, and lifecycle events are published so the
crew panel is a subscriber rather than a special case. `denied` is its own state on purpose: a task
that was refused was never sent, and telling that apart from "the model is down" is the difference
between a broken engine and the manager asking the wrong trade.

**Nothing stops the floor.** Manager call fails → the order is split from the offline plan. One
specialist fails → `fallbackSubplan` puts something plausible in the right material at the right
mount, because a hole in the object is worse than a dull part in it. Everything fails → the archetype,
decomposed. All four paths are exercised in `crew.test.mjs`.

**One machine per robot (`renderer/crew.js`).** The old executor was one state machine over one list
of steps. Five robots are not five sequential jobs, so each has its own small machine (next → walk →
work) and the floor has a phase over them: `working` (everyone at once, the foreman supervising) →
`haul` (the foreman collects what they made) → `finishing` (his own steps) → `done`. Two details do
real work: every robot has a LANE so five of them do not walk through each other, and the foreman
sorts his armful by part index before setting parts down — five robots finish in whatever order they
finish in, and a roof landing before its walls reads as a bug even when the geometry is identical.

**Every step has an owner, and an unowned step is a build that stops halfway.** `validatePlan` clamps
`step.by` to a real role; `crewplan.attributePlan` fills it in for anything the crew did not write
(the offline planner, a bench edit, an optimiser patch) from the material; `Crew.load` dispatches on
it and falls through to the foreman. A step nobody owns is a step no robot is scheduled to walk to.

**Engines are DATA, not code (`renderer/providers.js`).** The shop used to know
about exactly two: `callNIM`, `callOllama`, an if/else, and a fallback order typed into an array.
Nine now, plus a generic OpenAI-compatible row for everything not on the list, and adding one is
adding a row. Each declares its address, its auth style, its max-tokens key, HOW TO MAKE IT RETURN
JSON, and where the answer is in the reply. Four transport shapes cover the world: OpenAI's
chat-completions, Anthropic (system at the top level, no `response_format` at all — the schema goes
through a FORCED TOOL CALL and the answer is the tool's arguments), Gemini (`contents`, a
query-string key, and a schema dialect that has to be stripped down first), and Ollama (a nested
options bag). `main.js` has one `callProvider` that reads the row; the renderer never fetches
anything, exactly as with the reference lookup. Everything about the shaping is checked in node,
because every one of those differences fails SILENTLY: a wrong max-tokens key is a 400 the user
reads as "the model is broken", and JSON forced the wrong way returns prose, throws in the parser,
and drops the build to the offline planner with no explanation.

**`num_predict`.** Ollama caps generation at 128 tokens unless told otherwise. Every structured
reply this app asks for is longer than that, so without it the JSON arrived truncated mid-object,
every time, on the one provider that needs no key. `providers.test.mjs` asserts it is there.

**Tiers — which engine does which job.** Ported from Jarvis and it fits this app better than it fits
a chat assistant, because a build is not one call any more. The work order and the critique are two
calls that want real reasoning (`high`); the four specialist briefs are small, tightly-schema'd and
go out at once (`low`). `TIER_FOR_ROLE` maps the crew onto that, `preload` carries WHO IS ASKING
into `llm:plan`, and `routeFor` puts the tier's engine first and the rest of the chain behind it —
a tier is a preference, not a single point of failure. An unset tier falls up, so one engine needs
no wiring at all.

**`renderer/package.json` exists and is load-bearing.** It contains `{"type":"module"}` and nothing
else. The browser knows the renderer is ESM from `<script type="module">`; Node does not — it reads
the nearest package.json, and the app's own has no `type` because main.js is CommonJS. Without that
file main.js's `import()` of the provider table fails with `Unexpected token 'export'` and the app
boots to a black window with the error only in a stream nobody is reading. Node 22 sniffs the syntax
and recovers, which is exactly why the test suite passed while the app did not.

**The command surface is a registry (`renderer/actions.js`, `renderer/palette.js`).** Every
capability is a row: id, label, group, the words somebody would reach for it by, an authority level,
and whether it needs confirming. ⌘K is a view over the registry; the keyboard shortcuts are a view
over the registry; `HANDLERS` in app.js binds one function per row and `wiring.test.mjs` fails if
the two disagree, because a palette row with nothing behind it is worse than no row. Two rules the
palette does not bend: an unavailable action is shown GREYED WITH THE REASON rather than hidden (a
list that changes under you is a list nobody learns), and authority is visible BEFORE enter — "uses
a key", "writes a file", "destructive" — not discovered afterwards. Ranking is written out rather
than pulling in a fuzzy-search dependency, and is tested against the three things people actually
type: the start of a label, a word from the middle, the initials. Availability is a PENALTY, not an
ordering — sorting available-first outright means typing "stl" on an empty pedestal lands on "Stand
back and watch the floor".

**The apprenticeship is scored, not a cascade (`renderer/apprentice.js`).** It used to be a strict
priority list, which could not weigh a strong signal against a weak one of a "higher" kind, and
could not see the crew at all. Every candidate is now priced by what it would teach and penalised by
how recently it was attempted. Four things that are new and each fix something the cascade could not
express: DRILLS (a trade that keeps having parts coerced or failing to deliver gets practice on an
object that cannot be built without it), `needs` on curriculum rungs (a comment saying the
electrical rungs come last does not stop anything; a prerequisite does), spaced review (a recipe
that is never re-tested is a recipe nobody has checked, and confidence only moves when something is
built), and FAIL_STREAK_STOP (practice fixes a bad recipe; it does not fix a wrong key or a model
that will not emit JSON, and from in there those look identical — so it stops rather than spending
the night proving it). `apprentice.test.mjs` runs a hundred cycles and asserts on the SPREAD,
because scoring has its own version of grinding: a bonus set too high is a fixed point.

**Process split.** `main.js` is the only place network calls happen (fetch to NVIDIA NIM / Ollama),
the only place the API key lives, and the only place that touches disk. Settings and the skill
library are both JSON files in `app.getPath('userData')`; neither path ever crosses into the
renderer. `preload.js` exposes `window.forge` via contextBridge — five top-level methods plus a
`skills` sub-object; renderer runs with `contextIsolation: true`, `nodeIntegration: false`.

**LLM routing (`main.js` `ipcMain.handle('llm:plan', ...)`).** Provider order for `auto` is
`['nim', 'ollama']`, each wrapped in try/catch so failure falls through to the next; if both fail
(or provider is `offline`) the renderer's `agent.js` builds a plan from keyword heuristics instead
(`offlinePlan`) — the app always produces a build, never blocks on network. NIM gets
`response_format: json_object`; Ollama gets the actual JSON Schema in `format`, which is why a 3B
model is viable there — the schema constrains the decoder, the model only has to pick sensible steps.

**Reference lookup runs before planning.** `ipcMain.handle('refs:search')` hits the Thingiverse REST
API (primary — openly licensed, documented, needs a free app token, tries a bearer header then falls
back to `access_token=`) and the Printables GraphQL endpoint (backup, unauthenticated, undocumented
so treated as best-effort). Titles, tags and descriptions go into `agent.referenceBlock`, which is
folded into BOTH the planning prompt and the critique prompt — so the inspector can fail a build for
missing a part every real one has. Every failure path returns an empty list; a reference lookup must
never block or fail a build.

**Six-ish LLM calls per build, all optional.** Work order → the specialists IN PARALLEL → critique →
reflect. Every one of them failing degrades to something local: the offline archetype split by trade,
a trade's own defaults, geometry-only inspection, mechanical skill distillation. None of them blocks
the build. The specialists go out in one `Promise.all` — four sequential round-trips would make a
build feel slower than the single prompt it replaced, which would be the wrong trade entirely.

**A request can name more than one thing (`renderer/catalog.js`).** "A car with a V12 engine" is a
HOST and a SUBSYSTEM, and the offline planner could only ever pick one branch — so it built a correct
V12 and no car at all. `compose(hostParts, addParts, mount)` renumbers the subsystem onto the end of
the host (a local `attach.to` of 2 becomes `offset + 2`), bolts its ROOT — which had no attachment,
because it used to stand on the pedestal alone — to a NAMED MOUNT on the host, and scales the whole
block to the room the host has for it. Identical arithmetic to `crewplan.mergeSubplans`, identical
failure if it is wrong: half the engine silently reparents onto whatever the car has at that index,
solves fine, renders fine, and is quietly the wrong object. Tested on indices.

**`engine.fit` is how a catalogue engine survives being mounted.** `validatePlan` re-bodies every
`engine_role` part from `engineParts(sizeEngine(plan.engine))` on EVERY pass, so an engine scaled down
to fit a car would be blown back to full pedestal size the next time anything touched the plan. `fit`
is stored on the spec and multiplies the one scale boundary in `engineParts` — the bore, the stroke
and the deck height are untouched, so the bench still reports a real 12-cylinder engine while the
thing in the engine bay is a fifth of the size.

**The archetypes are checked by BUILDING them.** 31 objects, each a hand-written attach tree, and
every way one goes wrong is silent: a part hung off an arrayed parent that does not pair lands on
instance one; a `row` array on a left or right face has its offset thrown away by the face placement
and four shelves come out in the same place; a part with nothing under it gets dropped somewhere
nobody drew. So `catalog.test.mjs` solves every archetype and fails on the SOLVER'S OWN REPORT —
nothing floated, nothing toppled, and an arrayed part came out in as many PLACES as it has instances.

**Anything of a part's own that reaches below it holds it up (`assembly.js settle`).** Only a child on
the `bottom` face used to count, so a car's chassis dropped straight through its own wheels onto the
pedestal and a crate's floor through its own walls. The rule SKIPS settling such a parent rather than
resting it on the child's top — a motor's rotor is `inside` its stator and reaches past both ends of
it, and resting the stator on that would stand the motor on itself. `solver.test.mjs`'s "nothing
floats" invariant learned the same exception, or a crate has to sit on its own floor.

**A paired ring array must not add its radius twice.** Instance n of a child attaches to instance n of
its parent, so the direction is already expressed by which parent it landed on; adding the ring's own
offset on top walks it another radius out at every level, and a drone came out with its propellers
orbiting outside its own motors. Zeroed for a paired ring on a top or bottom face only — on a SIDE
face the offset is a bearing rather than a translation and is what makes a ring radial at all.

**`moves` is the tag that says a part turns**, and it has been dropped by the merge exactly the way
`engine_role` and the dx/dy/dz standoffs were: `validatePlan` and `mergeSubplans` both rebuild a part
from the fields they know about, so an untaught tag disappears in silence and the object comes back
complete, correct, and welded solid. `catalogMotion` returns the same shape `engineMotion` does, so a
car's wheels and its crankshaft turn off one list and world.js knows about neither.

**Three files work out what a request is ABOUT, and none of them can import the others.**
`skills.headNoun`, `library.headTerm` and `catalog.headWord` are the same rule written three times
because all three files are import-free by design; `wiring.test.mjs` checks they agree. Matching an
archetype adds two rules on top: only the SUBJECT is scored (everything before the first preposition —
"a lamp for a workbench" is a lamp, and scoring the whole sentence matched `workbench` and offered a
table), and SPECIFICITY leads with the head noun breaking ties — head-first, "a loudspeaker cabinet"
matched `cabinet` and offered shelving.

**The model does not do arithmetic.** This is the central design decision. A part says what it is
bolted to (`attach: {to, face, dx, dy, dz}`) and whether there are several of it
(`array: {mode, count, radius, spacing}`), never where it is. `renderer/assembly.js` resolves that
into transforms: expand arrays → walk the attach tree → lift the assembly so its lowest point rests
on the pedestal → settle anything unsupported down onto what is below it → separate interpenetration
along the true MTV → scale to fit the pedestal → find contact patches for weld beads and bolts.
Asking the model for coordinates instead produced floating slabs, which is what the whole solver
exists to stop.

**Hitboxes follow the shape, not the shape's box.** `assembly.halfExtents` special-cases anything
round about its local +Y — cylinder, rod, cone, torus, gear — and spheres. Rotating the box a cone
fits inside inflates it by up to 41% for a spin that does not move the cone at all, and the solver
then shoves the neighbours away from a part that has not moved. `cad/
  kernel.py      the sidecar: restricted builtins, guarded import, measures and exports
  requirements.txt
test/geometry.test.mjs` measures
real rotated meshes vertex by vertex and fails if the solver's bounds are either smaller than the
mesh (parts intersect) or more than 35% larger (phantom shoving). The CAD selection box uses
`setFromObject(mesh, true)` for the same reason.

**Nudges are world-axis offsets applied AFTER the face places the part.** They used to be folded into
the placement and then discarded on any face whose normal they ran along, which is why `dx` did
nothing to anything on a left or right face. A non-zero `dy` also sets `fixed`, or gravity would undo
a deliberate standoff the instant it was typed.

**An arrayed child of an arrayed parent is paired, and pairing consumes the offset.** Four pistons
on four cylinders: instance n of one attaches to instance n of the other, which is what makes the
firing order line up without matching anything by name. Its own row offset is then ALREADY expressed
by which cylinder it landed on, and applying it again spreads the children at twice the pitch — the
outer ones walk clean out of the parts they live in, solve fine and render fine. A ring keeps its
offset, because there the direction is what says which way the part faces.

**`inside` is a statement of intent, and the separation pass honours it.** A shaft down the middle of
a motor or a piston in its bore is deliberately interpenetrating. The parent/child pair is spared
anyway, but the thing a part lives inside is often a SIBLING — the shaft hangs off the stator and
runs through the rotor — and shoving it out sideways there put the shaft alongside the motor and
toppled the assembly with nothing thrown.

**Arrays are the highest-leverage part of the prompt.** Models reliably omit the second, third and
fourth leg but reliably remember to say "four legs" when given a field for it.

**`assembly.js` and `skills.js` import nothing.** No three.js, no DOM. That is deliberate and worth
preserving: it is what makes the entire planning and layout path testable in node. `test/wiring.test.mjs`
asserts `assembly.js` has no local imports; if you need three.js in there, you have put something in
the wrong file.

**A shape is DATA, and the drawn size is normalised (`renderer/shapelib.js`).** Nine shapes used to
be nine arms of a switch in `shapes.js`, so a tenth was a code change and a shape somebody wanted was
a shape they could not have. A shape is now a PROFILE plus a rule for sweeping it — `revolve` (a
half-section spun about +Y: dome, vase, funnel, spool, pipe) or `extrude` (an outline pushed along +Z
with holes: angle, channel, I-beam, arch, ring plate). 25 ship, and anyone can save their own to
`userData/shapes.json`. THE RULE THAT MAKES IT SAFE: every profile is authored in a unit box and the
finished mesh is stretched onto exactly `[w, h, d]` (`fitToBox` in shapes.js). So `effectiveSize`
returns the size it was handed and IS RIGHT — assembly.js needs no special case, and the drift
`geometry.test.mjs` exists to catch cannot happen for a shape nobody wrote code for. Give up a little
control over the exact section, get an invariant that holds for shapes that do not exist yet.

**`SHAPE_ENUM` is one array, mutated in place.** The JSON schema handed to the model is built once at
module load and holds a reference to it. Register a saved shape by REPLACING the array and every
schema built before that moment keeps yesterday's vocabulary — the shape is in the picker, absent from
the enum, and silently coerced to a box on the way through `validatePlan`. So `registerShapes` empties
and refills the same array. `shapelib.test.mjs` asserts the identity, not just the contents.

**An id that collides with an alias is never reached.** `partGeometry`'s switch answers to `tube`,
`plate`, `bar`, `ball` and `ring` as aliases for primitives, and it catches those before the
definition path — a shape defined as `tube` draws a solid cylinder and looks like a profile that came
out wrong. That is why the hollow one is called `pipe`, and why there is a test for it.

**`shapelib.js` imports nothing**, for the same reason `engine.js` and `circuit.js` do not: it decides
what a shape IS, it reads a user-editable file off disk, and it hands its vocabulary to a model. The
one place a definition becomes geometry is `shapes.js` — `cad.js`'s live preview goes through
`previewGeometry`, the same builder, because a preview with its own drawing code can be right about a
shape the floor then builds wrong. `wiring.test.mjs` fails if cad.js grows a `LatheGeometry`.

**The nine primitives are listed twice on purpose.** `assembly.js SHAPES` (it has size opinions about
each) and `shapelib.js PRIMITIVE_SHAPES` (it does not, and cannot import assembly.js because
assembly.js imports nothing). Both tests check they are the same list — same treatment as `STATION_X`.

**Size has exactly one definition.** `assembly.effectiveSize` says how big the solver thinks a part
is; `shapes.partGeometry` builds the mesh. A panel is thinned on its smallest axis, a rod is drawn a
third of its stated width, a torus reads `[outer diameter, thickness]` and lies flat. Both files read
those rules from `assembly.js`, and `test/geometry.test.mjs` measures real three.js meshes against
`effectiveSize` for every shape at six sizes. If they ever drift, parts hover or sink and nothing
errors — hence the test.

**Never trust the model.** Every LLM response goes through `parsePlan` (strip fences, extract the
`{...}` span, `JSON.parse`) then `validatePlan` (`renderer/agent.js`), which clamps every field:
unknown room → `cardboard`, unknown action → first valid action for that room, action's clip room
overrides the stated room, `seconds` clamped to [1.5, 9], `attach.to` must reference an EARLIER part
(which also makes attachment cycles impossible), array modes and counts clamped, plan capped at 18
steps, and a `present` step appended in `finished` if the plan doesn't end there. `skills.sanitize`
does the same job for the skill file, which is user-editable and comes off disk.

**Animation system is data, not mocap.** `renderer/animations.js`: each clip is `A(id, label, opts)` —
a base pose (`BASE_POSE`) plus sine oscillators (`osc: [{ j: joint, a: axis, amp, f, p }]`) evaluated
per-frame and blended 0.22s on clip change. Clips also declare `prop` (hand tool from `props.js`),
`gear` (headgear), and `fx` (spark/dust/steam/etc., consumed by `character.js`). To add a clip: add
one `A(...)` call — it's live in the LLM's action enum immediately. Clips marked `internal: true`
(`pick_up`, `set_down`, `walk_carry`) are excluded from `ACTION_IDS` and `ACTIONS_BY_ROOM` because
the executor plays them itself; nobody asks a robot to "pick_up".

**Reach IK, not a pose library.** `character.applyReach` runs two-bone CCD on `foreR`/`armR` toward
`wp.contact`, the point on the material the tool should be touching, blended in at ~0.5 weight and
clamped to arm length. CCD rather than an analytic solve because it is self-correcting and
sign-agnostic — an analytic solve with a wrong sign fails silently and can only be caught by looking
at it. The clip still owns the character of the motion.

**Executor is a state machine over two loops.** `renderer/app.js`: the step loop
(`next → walk → work → next`) and the haul loop (`goto → lift → carry → place`). A haul is triggered
when the plan reaches a `finished` step with parts still on a rack, and again at the end of the plan.
Parts are staged at the station that made them and only ever move in the foreman's arms — `world.stagePart`,
`rivet.carry`, `rivet.takeCarried`, `world.placeInstance`. There is no flight code; if you find
yourself adding a tween from a bench straight to the pedestal, that is the thing this replaced.

**The bench (`renderer/cad.js`).** A CAD workspace over the SAME canvas and GL context as the shop —
`cad.render()` scissors itself into the gap between its two panels, and `world.render()` resets the
viewport before drawing. There is no second WebGLRenderer. Everything in the properties panel is
live: a keystroke calls `agent.editPart` (which clamps, exactly like `validatePlan` — the DOM is not
the contract), then `inspectPlan` re-solves, then `world.rebuildAssembly` re-places the pedestal but
only once `buildSettled()` — mid-build the pedestal is half empty on purpose. `addPart`/`removePart`
renumber every `attach.to` that pointed past the change; getting that wrong silently reparents half
the assembly, hence the tests.

**Hand corrections outrank the model.** `skills.describeEdits` diffs the plan as-planned against the
plan as-edited and turns it into sentences ("the shade has to be a cone, not a box"). `learn(...,
{taught: true})` files the corrected recipe at 0.88 confidence without inflating the build count, and
`agent.recalledBlock` gives a taught skill different prompt wording — follow this closely, these
corrections are not suggestions. This is the loop for when the model simply cannot get an object
right on its own.

**Recall is IDENTITY first, evidence second (`renderer/skills.js`).** Scoring used to add up keyword
hits and add a slice of confidence on top, so a confident skill cleared the bar on ONE incidental
keyword — and the keywords were polluted, because every token of the request that produced a build was
filed as a keyword for it. Ask for a rover to carry a bookshelf and `bookshelf` is a rover keyword
forever; ask for a bookshelf next month and the planner is handed a rover. Nothing throws — the prompt
just describes the wrong object. Now: IDENTITY (the class, `CLASS_WORDS` for that class, and the
name's HEAD NOUN) is the only thing that can carry a recall; KEYWORDS corroborate and never carry, so
no identity and fewer than two keyword hits scores exactly zero. Confidence MULTIPLIES agreement
instead of being added to it. `CLASS_WORDS` exists because nobody types "vehicle", they type car —
without it a library full of good recipes never gets used.

**Three channels filed other objects' nouns, and all three are closed.** `learn` filed
`tokenize(request)` wholesale; `deterministicReflection` did the same and also tokenised `plan.title`,
which is the request with the verb trimmed off; and `identityWords` tokenised the skill's NAME, which
offline IS that same sentence — the worst of the three, because identity is the half that can carry a
recall alone. All three now take the HEAD NOUN only. `cleanKeywords` also splits phrases instead of
squashing them (a reflection keyword of "metal lamp desk foldable arm" became one 38-character
keyword that could never match anything anybody typed) and drops `GENERIC` words like `model`,
`simple`, `printed` — the ones that match everything and mean nothing.

**`domain` on a skill is a demotion, never a promotion.** The caller passes what `classifyRequest`
made of the request; a mismatch costs a skill 0.45 and blocks it outright if there was no identity
match. It cannot promote anything: classification is a regex over a sentence and is not authoritative
enough to invent a match. A skill with no domain on file (an older library) is unaffected.

**Classification weighs evidence rather than taking the first match (`renderer/library.js`).**
`DOMAINS` is an ordered table and the ORDER used to decide: "a car with an engine" met the propulsion
vocabulary on `engine` before the vehicle vocabulary was tried, so the shop reasoned about a car as a
powerplant and searched NASA for it. Now every domain is scored on how much of its vocabulary is
present, how SPECIFIC each hit is (a two-word term is evidence, a three-letter one is a coincidence)
and how EARLY it appears, because the thing being asked for is named before the things on it.
Electronics keeps its thumb on the scale via `DOMAIN_BONUS` — "a circuit that runs a motor" must not
be routed to turbofans — but it is now a stated bonus rather than a side effect of list order.

**A reference has to be ABOUT the thing (`relevanceOf`).** Ranking kept anything sharing one token
with the search terms, which is how a listing called "Model Rocket Engine Holder" survived a request
for a car with an engine and went into the planning AND critique prompts as an example of the object.
The head noun is worth 1.0, another term 0.45, and a `WEAK` word (`mount`, `remix`, `v2`, `printable`)
nothing at all; `RELEVANCE_FLOOR` is 0.9, so a reference must name the object or match two real words
that are not it. Likes are the tie-break and never the argument — the most printed thing on the
internet is not evidence about what somebody just asked for.

**The head noun rule is written twice on purpose.** `skills.headNoun` and `library.headTerm` are the
same rule in two files that cannot import each other, since both are import-free by design.
`wiring.test.mjs` checks the two agree on a set of phrases — a recall that thinks the request is about
a car and a lookup that thinks it is about an engine disagree silently, and the symptom is a good
recipe alongside irrelevant references.

**The skill loop.** After a build, `buildReflectMessages` asks the model for semantics only — name,
class, keywords, part roles, lessons. `skills.recipeFrom` takes the geometry from the plan's part
specs (which are what the solver verified), never from the model's description. `skills.learn`
merges by class: same class updates in place, replaces the stored recipe with the newer corrected
one, and raises confidence more for a build that needed no corrections. `skills.recall` scores
keyword + class overlap on the next request and `agent.recalledBlock` folds the winner into the
prompt. `offlinePlan(request, recalled)` will instantiate a learned recipe directly, so a shop that
has built a lamp once can build a proper lamp with no network.

**Reference lookup is routed, and the routing is pure (`renderer/library.js`).** `classifyRequest`
decides whether a request is a maker object or an engineering one (propulsion, aerospace, mechanism,
structure, vehicle, robotics); `sourcesFor` picks the sources; `main.js` only executes the named
lookups (Thingiverse, Printables, Wikipedia, Commons, NTRS, Openverse), all in one
`Promise.allSettled` so four sequential timeouts cannot stall a build. Every engineering domain also
carries a hand-written parts vocabulary and a paragraph of how the real thing goes together — that
is what `technicalBlock` folds into the planning AND critique prompts, and what `domainParts` turns
into real specs so `offlinePlan` can build an engine with the network down. `wiring.test.mjs` fails
if `library.js` names a source `main.js` cannot fetch.

**The bench reports engineering numbers (`renderer/metrics.js`).** Volume, area, mass by material
density, centre of mass, and whether the centre of mass sits inside the ground footprint — the last
one is the check that catches a build the solver is perfectly happy with and which falls over the
moment it is real. Everything derives from `effectiveSize`, so a mass always describes the object on
screen rather than the raw spec; `metrics.js` is allowed exactly one import (`assembly.js`) and the
wiring test enforces it. The panel is in millimetres and the spec stays in metres — `cad.fieldToSpec`
owns that conversion, because cad owns which unit is on screen.

**The open web is read, not listed (`refs:read` in `main.js`, `minePages` in `library.js`).** The print
sites and the encyclopedias between them cover maybe half of what people ask for; there is no
Thingiverse entry for a bandsaw fence and Wikipedia has a paragraph on a quadcopter arm. So `web` is a
source on every route, backed by SearXNG (own instance via `searxBase`, then public instances, then
two DuckDuckGo endpoints), and the best three results are FETCHED AND STRIPPED TO TEXT main-side.
`minePages` then takes the two things a title cannot carry: the part names people actually use
(`structureFrom`) and the sizes they actually quote (`dimensionsFrom`, everything normalised to mm,
with a 1mm–6000mm sanity band that throws out years and like counts). `readingBlock` folds that into
the planning AND critique prompts as its own section, kept separate from `technicalBlock` because one
is what the shop knows and the other is what somebody who built it wrote down. `pageValue` scores a
page on how much making-language it contains and drops anything under 1.2 — a news article about
bandsaws is not a bandsaw fence build. Main owns every fetch; `library.js` never has a `fetch` in it
and the wiring test enforces that.

**Search is the one part of the stack that fails silently.** A dead lookup leaves every build slightly
worse with no error anywhere, so `llm:probe` tests it alongside NIM and Ollama and the Engine panel
reports which backend answered. Public SearXNG instances mostly ship with the JSON API off and now sit
behind bot checks — the dependable configuration is a local instance
(`docker run -d -p 8888:8080 searxng/searxng`), and the settings text says so.

**A circuit is a graph, and the rest of the app is a tree (`renderer/circuit.js`).** That is the whole
reason electronics gets its own file. A part may carry `component` + `value`; the plan carries a
top-level `wires` list of pin pairs (`"1.+" → "2.a"`). Union-find turns those into nets, `solveCircuit`
traces the loop from the supply's + back to its −, and `analyseCircuit` applies Ohm's law plus the
checks that actually matter on a bench: no supply, a short, a loop that does not close, an LED with no
series resistor, a part over its current or power rating, a floating pin, and how long the battery
lasts. Findings come back in exactly the `optimize.js` shape, so an electrical fault lands in the same
bench list and applies through the same edit path. `assembly.js` never sees a wire and `circuit.js`
never sees a transform — `wiring.test.mjs` fails if either learns about the other. NO nodal analysis:
the geometry is representative, so exact answers about it would be a category error.

**A component's body comes from the catalogue, never from the model.** `validatePlan` overwrites
shape, size and material from `COMPONENTS` the moment `component` is set — otherwise a part that
arrived without a material takes the default and the shop reports a cardboard resistor. The same
override is in `addPart`, so a resistor the optimiser drops in is a resistor and not a 400mm cube.

**Components are exempt from every structural rule in `optimize.js`.** A resistor is drawn as a 260mm
barrel so it reads from across the shop; weighed as solid stock that is kilos, and the load-path rule
would spend all day insisting a board cannot hold its own components. The rendered body is a symbol.
`loadPath` skips them entirely, and soldering a component is not "the wrong tool for the material".

**`nearestE12` always rounds UP.** Every value it is asked for is a current limit, and a limiter
rounded down passes more current than was asked for — which is the exact failure it exists to prevent.

**An engine is a kinematic chain with a governing dimension set (`renderer/engine.js`).** That is
the third thing in this app that is not a tree — assembly.js solves a tree of attachments, circuit.js
solves a graph of nets, and nothing about an engine is a free choice. Give a piston engine a bore, a
stroke, a rod and a chamber volume and every other number falls out: displacement, compression ratio,
deck height, bore spacing, block length and width at that bank angle, mean piston speed at the
redline, the firing order. Give a turbofan a mass flow, a bypass ratio and an overall pressure ratio
and the annulus area at every station falls out of compressible flow, and the hub and tip diameters
fall out of that. So the shop asks WHICH ENGINE and does the arithmetic itself — the same rule as a
component's body coming from `COMPONENTS`, and worth far more here, because a crankshaft the model
sized has no relationship at all to the bore it is meant to serve and nothing about that throws.
`engine.js` imports nothing: the sizing, the fault rules and the kinematics are all checked in node
against engines anybody can look up (a 2JZ is 2997cc, a Merlin is 27 litres).

**Where the numbers came from.** Reciprocating architecture is lifted from the engine definitions in
ange-yaghi/engine-sim — bore, stroke, rod length, compression height, chamber volume, bank angle,
journal angles, redline, for a Hayabusa, a 2JZ, a GM LS, an F136, a Merlin and a nine-cylinder
radial. Turbofan sizing is RohitNag11/JetEngineDesigner: `A = ṁ/(ρVx)` with static density recovered
from stagnation through the axial Mach number, hub and tip from the mean radius and the annulus area,
stage counts from a per-stage pressure ratio, and the validity list out of `Engine.__check_validity`.
Electric machines have no source repo, so `sizeMotor` is hand-written and says so in a comment. The
catalogue is indexed maker → model, which is the one good idea in the carspecs API — a lookup, not a
dependency.

**The compression ratio and the chamber volume are the same fact.** Only one of them can be the
input. A catalogue entry gives the RATIO, because that is how an engine is quoted and what anybody
can check; a spec off the bench gives the CHAMBER, because that is the dimension somebody machines.
`validateEngine` converts whichever arrives into the chamber, once, and stores that — keeping both
and letting them drift is how the bench ends up reporting a compression ratio the engine does not
have. Same reason `LIMITS.crBoosted` exists: a Merlin runs 6:1 BECAUSE it is supercharged, and an
engineer who fails a Merlin is an engineer nobody listens to again.

**Motion is kinematics, not animation.** `engineMotion` says what turns, how fast and about which
axis, and `pistonAt` is the exact slider-crank — `r·cosθ + √(l² − r²sin²θ)`, not a sine, because the
second term is what makes the travel asymmetric and is the whole reason a short rod is hard on an
engine. world.js turns that into transforms and is the only thing that knows what a transform is.
Pistons are arrayed exactly like the cylinders they run in, so instance n of one is instance n of the
other and the firing order lines up without matching anything by name; a V's second bank slices its
own quarter of the phase list, or both banks fire on the same four cylinders. They are inside the
bores and therefore invisible in the shaded view, which is correct — the bench has an x-ray and a
section for exactly this.

**The sixth robot owns `alloy`, and that is not cosmetic.** `owns` is a partition, and all six
materials were taken. Cast and machined aluminium is genuinely not welded steel plate — it is what a
block, a head, a piston, a casing and a compressor disc actually are — so the powerplant trade gets
its own material rather than sharing one. Routing follows: a part carrying `engine_role` goes to
`powerplant` whatever it is made of (a crankshaft is steel, and routing it by material would hand the
rotating assembly to the trade that makes things stand still), exactly as a `component` goes to
electrical whatever it is made of. Its budget is [2, 12] rather than [2, 6] because a V8 is ten parts
before anybody has asked for anything, and a budget that cannot hold one deletes the object.

**An engine is sized BEFORE anybody is briefed.** `shopfloor.run` classifies the request and sizes
the engine itself; the manager does not decide the bore and neither does the specialist. Every trade
then works against numbers that already agree with each other, the powerplant brief is told the
sizing is already done, and `fallbackSubplan` for that trade hands back the real parts — so a dead
model costs the engine nothing at all. A manager who forgets to assign the engine gets it forced onto
the order, the same way controls is, because some things about a build are not the model's call.

**The optimiser is the engineer's second look (`renderer/optimize.js`).** `critic.js` asks whether a
build reads as the thing that was ordered; `analyse(plan, solved)` asks whether it will stand, whether
the material takes the load sitting on it, whether there is stock doing no work, whether four identical
parts are really four operations, and how far the crew walks to make it. All arithmetic, so none of it is
in a prompt. Every finding carries a gain in real units and a patch that goes through `editPart` /
`removePart` — the same path the properties panel uses — so an optimisation is clamped by the same
rules as a keystroke and lands on the undo stack. The design constraint is NO FALSE POSITIVES: every
rule in `engineer.test.mjs` is tested twice, once on a build with the fault and once on a build
without it, because an optimiser that cries wolf gets switched off and then nobody is listening the
time it was right. `loadPath` only counts a `top` attachment — something on a side face is hanging,
not pressing.

**The apprenticeship (`renderer/apprentice.js`).** Idle for 45s and `nextProject` picks something:
repair a class below 0.5 confidence, climb the next rung of `CURRICULUM` (ordered so each needs a
solver feature the last did not), stretch into an untried engineering domain, vary a class he knows to
see whether the recipe generalises, or take a target off the back of a reference lookup. `COOLDOWN`
stops grinding. The repair threshold MUST sit below `SELF_TAUGHT_CEILING` or he repairs a class, files
it at the ceiling, finds it still under the bar and repairs it forever.

**Self-study cannot rot the library (`skills.js`).** `SELF_TAUGHT_CEILING = 0.6`. A study build never
overwrites a hand-taught recipe and never moves a hand-taught confidence in either direction; a study
build that failed inspection or has a fault open files lessons and no geometry at all
(`studyOutcome().keepRecipe`). This ceiling is the entire reason leaving the app running overnight
makes the library better rather than worse — an agent that files its own unchecked output as ground
truth drifts, fastest exactly when it is most confident. `interrupt()` is bound to pointerdown,
keydown and wheel at capture: study time ends the instant the person does anything.

**Undo keeps whole plans, not diffs (`renderer/history.js`).** A plan is a few kilobytes of JSON and
a re-solve costs more than a clone, so there is nothing to win by inverting operations — and an
inverse that applies backwards slightly wrong is a far worse bug than a fat stack. Two details make
it usable: edits carrying the same `key` within `COALESCE_MS` fold into one entry (the panel fires
per keystroke, so "0.42" is otherwise four undos), and a state identical to the one on top is
dropped rather than consuming a slot. `startJob` resets the stack — you cannot undo out of this
build into the last one.

**Export writes bytes, not geometry (`renderer/export3d.js`).** It is handed triangles three.js
already tessellated (`world.assemblyMeshes()` returns raw typed arrays plus a matrix, so the
exporter never imports three) and it writes them. Two conventions, both the classic way an export
"works" and is still useless if got wrong: everything is scaled ×1000 because the shop thinks in
metres and every slicer assumes millimetres, and STL is swung Y-up → Z-up because printers are Z-up
while OBJ is left alone because DCC tools are not. Seam beads collapse into one `seams` object;
degenerate facets — a cone tip reliably makes a few — are dropped before writing.

**The shop with nobody in it (`--forge`, `renderer/forge.js`).** `electron . --forge "a desk lamp"
--out DIR --json` runs the whole pipeline in a hidden window — same agent.js, same solver, same
critic, same optimiser, same exporter — renders three views to PNG, writes STL/OBJ/plan/BOM and prints
one result object to stdout. It exists because Bob (the Python assistant next door) wants the object,
not four minutes of a robot walking. The window is hidden rather than absent because three.js needs a
real GL context; `canvas.toDataURL()` beats `capturePage` and offscreen mode for reliability. The
hard rule is that forge.js REUSES the shop rather than reimplementing any of it — the moment it grows
its own solver the two drift apart silently, and `wiring.test.mjs` fails if its imports disappear. It
also cannot hang: a 5-minute `setTimeout` finishes the process, because something is waiting on it.

**There are two ways to make something, and they are good at different things.** The whole app so far
builds an object out of PRIMITIVES on an attach tree — deterministic, needs nothing installed, runs
headless, and it is what the robots can actually be seen doing. It also cannot express a fillet, a
boolean, a thread or a draft angle. Ask it for a hex bolt and you get a cylinder with a fat cylinder
on top, because a hex bolt is not in the vocabulary.

So `renderer/cadscript.js` + `renderer/cadbuild.js` + `cad/kernel.py` add a second path: the model
writes PYTHON against `build123d` (OpenCascade underneath) and a real B-rep kernel makes the geometry.
`wantsKernel` routes to it — a bracket, a bolt, a bearing housing, anything asking for tolerances or a
STEP file — and everything else still goes to the floor. A kernel build that fails falls back to the
primitive path, and a machine without build123d never notices the feature exists.

**THE IDEA WORTH TAKING IS NOT THE KERNEL, IT IS THAT THE KERNEL IS THE VERIFIER.** Everywhere else in
this app the correction signal is a model looking at a description of its own work and being asked
whether it looks right, which is weak — a model that made a bad part will describe it as a good one.
`fillet()` with too large a radius does not come out subtly wrong, it RAISES, and the traceback names
the operation and the reason. `buildWithKernel` feeds that back and tries again. That is a compiler
error, not a critique, and models are enormously better at fixing those.

**The gate runs BEFORE the kernel, and that ordering is the security boundary.** `gateScript` is an
ALLOWLIST — a script may name build123d, math, numpy and nothing else — plus specific refusals for
imports, `open`, `eval`, reflection, dunders and exporting. A refusal costs no process and no seconds,
which is why it comes first. `wiring.test.mjs` fails if `run()` is ever called before `gateScript()`.
The kernel then checks the text AGAIN and runs with a restricted `__builtins__` and a `guarded_import`
that knows three modules, because one fence is never enough and the day the gate has a hole in it is
the day the second one matters. Both fences are tested independently.

**The script does not get to export.** The obvious design is to let it call `export_stl` and
string-replace the path afterwards, which is fragile (quoting, Windows escapes, a model that writes
the path twice) AND it is the only reason generated code would ever have a legitimate excuse to touch
the disk. Taking the export away removes both problems: the script's one job is to leave a solid in
`result_part`, and `kernel.py` does everything after that.

**Running is not working.** A script can succeed and hand back an empty compound, a part four metres
across, or a shell that never closed — all exit zero. `checkSolid` asks whether it is actually a part
and a fault there goes round the repair loop exactly like a traceback does. This is what ADA's version
does not do, and it is why "it compiled" is never mistaken for "it is right".

**A working script is the best thing the library can remember.** `cadRecipe` files it, `recallScript`
hands it back, and a hand-corrected one is marked authoritative in the prompt — the same rule as a
hand-corrected assembly. It turns a cold generation into an edit, which is the difference between
"design me a bearing block" working sometimes and working every time.

**STEP is the point.** The primitive path could only ever produce a mesh. A kernel build writes real
B-rep that opens in Fusion or SolidWorks as editable geometry with faces and edges — which is what
actually separates a CAD tool from a mesh generator.

## File map

```
main.js          Electron main — window, settings, skill library on disk, LLM transport
preload.js       contextBridge surface, no node access in renderer
renderer/
  roles.js       THE CREW. who works here, their materials, authority, and the floor plan. No imports.
  providers.js   THE ENGINES. nine of them plus a generic one, as data. No imports.
  actions.js     THE COMMAND SURFACE. every capability as a row, with authority. No imports.
  palette.js     ⌘K — the view over the registry. Owns its DOM and nothing else.
  workorder.js   the manager's decomposition — frame, mounts, assignments. And splitPlan.
  crewplan.js    the specialists' briefs, their clamping, and THE MERGE.
  shopfloor.js   the delegation ledger and the run: order → four trades at once → merge.
  crew.js        six robots on the floor, one state machine each, plus the haul.
  assembly.js    THE SOLVER. attach graph, arrays, gravity, separation, fit, joints. No imports.
  shapelib.js    THE SHAPE VOCABULARY as data — profiles, validation, the live registry. No imports.
  catalog.js     THE PARTS CATALOGUE — 31 archetypes, their mounts, and the merge. No imports.
  shapes.js      part spec → three.js geometry. The nine by hand, everything else from a profile.
  world.js       the bay, the six stations, lighting, camera, racks, workpieces, seams, env map
  character.js   a robot's rig, reach IK, carrying, props, particles, playback. Five instances.
  animations.js  the clip library (A(...) entries) + evaluator; source of truth for ACTION_IDS
  props.js       hand tools + headgear meshes, built from primitives
  textures.js    procedural canvas textures
  agent.js       system prompts, schemas, parsePlan/validatePlan, plan editing, offlinePlan
  cad.js         the bench — CAD viewport over the shop canvas, attach tree, live editing
  skills.js      distil / score / recall / reinforce / merge / sanitize a skill. No imports.
  history.js     bounded undo stack of whole plans, with coalescing. No imports.
  export3d.js    triangles → binary STL / OBJ. No imports.
  library.js     source routing, domain vocabularies, structure mining. No imports.
  circuit.js     components, netlist, Ohm's law, the electrical faults. No imports.
  engine.js      THE ENGINEER'S ARITHMETIC. catalogues, sizing, faults, kinematics. No imports.
  optimize.js    the engineer's second look — findings + applicable patches. assembly/metrics/agent.
  apprentice.js  what he studies when idle, and what a study build is worth. No imports.
  metrics.js     volume / mass / centre of mass / clearance / BOM / units. assembly.js only.
  critic.js      solve a plan and audit the result — the bridge from agent to assembly
  app.js         the pipeline, the crew panel, the traveller, UI wiring
  cadscript.js   THE GATE, the build123d prompt, and what makes a solid usable. No imports.
  cadbuild.js    gate → run → check → repair. Takes ask and run, so the loop is testable.
  forge.js       the headless build — plan, solve, render, export, for another program
test/
  crew.test.mjs      the register, the work order, THE MERGE, the floor end to end, offline parity
  providers.test.mjs every provider's body, JSON forcing, reply field, tiers and routing
  apprentice.test.mjs the study policy, run for a hundred cycles, and the runaway guard
  palette.test.mjs   the registry, and what typing three letters actually finds
  solver.test.mjs    solver fixtures, skill library, whole offline pipeline end to end
  geometry.test.mjs  real three.js meshes measured against the solver's assumptions
  shapelib.test.mjs  the profile format, the live registry, and a saved shape through the shop
  catalog.test.mjs   every archetype BUILT and checked, and the host/subsystem merge on indices
  learning.test.mjs  offline build → skill → recall → reinforce, undo, and the exporters
  bench.test.mjs     mass and clearance arithmetic, units, BOM, source routing, prompt blocks
  engineer.test.mjs  every optimiser rule fired and kept quiet, study selection, the drift ceiling
  circuit.test.mjs   netlist, Ohm's law by hand, every electrical fault fired and kept quiet
  engine.test.mjs    displacement against real engines, the turbofan sums, every engine fault
  reading.test.mjs   page scoring, dimension extraction, what reaches the prompt
  cadscript.test.mjs every escape the gate stops, and every real script it must allow
  cadbuild.test.mjs  the repair loop on a scripted model, then against the real kernel
  wiring.test.mjs    imports, DOM ids, IPC bridge, CSP hash, clip coverage
```

## Notes for changes

- Representative, not CAD: the LLM picks shape/material/rough dimensions per part; the app renders
  that primitive. Parts touch, stack, hang off each other and get welded where they meet — they are
  not constrained and there is no mating. Don't try to make output dimensionally exact (see README
  "What this is not").
- Run `npm test` before and after touching `assembly.js`, `shapes.js`, `skills.js`, `agent.js`,
  `history.js`, `export3d.js`, `shapelib.js`, `roles.js`, `workorder.js` or `crewplan.js`. 482 checks, about a
  second, and they catch the silent failures — a part that hovers 2cm above its support does not
  throw, an attachment renumbered onto the wrong parent does not throw, a specialist's block merged
  at the wrong offset does not throw, and an STL that exports in metres opens fine and prints 1mm
  across.
- `roles.js`, `providers.js`, `actions.js`, `workorder.js`, `crewplan.js` and `shopfloor.js` must
  never reach for three.js, the DOM or the network. That is what keeps the whole planning layer — who does what, what the interfaces
  are, how four answers become one object — checkable in node against a scripted model.
- There is ONE floor plan (`roles.js STATION_X`) and world.js and optimize.js both read it. The
  optimiser used to keep its own copy and it went stale the moment the walls came down, pricing every
  plan against a shop that had been demolished. Nothing threw.
- Anything that produces a plan has to give every step an owner, or go through `attributePlan`.
- A new capability is a row in `actions.js` AND a handler in `app.js`'s `HANDLERS`. Neither alone.
- A new object the shop can build is a row in `catalog.js` — parts, mounts, and one line saying how
  it goes together. Run the archetype gate afterwards; a hand-written attach tree that is wrong does
  not throw, it just comes out as a heap.
- A new shape is a row in `shapelib.js` — a profile, not code. If it needs a third way of sweeping,
  that is a `kind` and one function in `shapes.js`, never a new arm of `partGeometry`'s switch. Check
  the id against `partGeometry`'s ALIASES first; a collision is silently never drawn.
- A new engine is a row in `providers.js`. If it needs a fifth transport shape, that is a `kind` and
  four functions in that file — never a special case in `main.js`.
- Engine parts are exempt from every structural rule in `optimize.js`, exactly as components are —
  a crankshaft is a long thin rod and a compressor disc is stock with nothing on it, and both are
  correct.
- `assembly.js`, `skills.js`, `history.js` and `export3d.js` import nothing at all. That is what
  keeps the suite headless and instant; `wiring.test.mjs` fails if any of them grows an import.
- When touching the prompt or the schemas in `agent.js`, keep the rules in sync with what
  `validatePlan` actually enforces — the prompt is guidance, `validatePlan` is the contract.
- `main.js` config (`DEFAULTS`) and the Engine settings panel in the renderer must stay in sync on
  field names (`provider`, `nimKey`, `nimModel`, `nimBase`, `ollamaModel`, `ollamaBase`,
  `temperature`, `references`, `thingiverseToken`). `wiring.test.mjs` checks this.
- `renderer/index.html` has a CSP with a sha256 hash for the inline importmap. Editing that script
  without recomputing the hash gives a blank window with a console error and no other clue;
  `wiring.test.mjs` checks it.
- The bench and the shop must never disagree about a build. Anything that mutates `job.plan` has to
  go through `reSolve()` in `app.js`, which re-solves, rebuilds `instByPart` for the executor, and
  re-places the pedestal if the build is already settled.
- Skills are persisted whole on every change. That is intentional — the file is a few kilobytes and
  a torn write costs the user everything the floor has learned.
