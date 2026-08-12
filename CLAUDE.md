# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app (macOS). Four connected rooms — Software → Cardboard → Finished → Metal —
rendered in Three.js. A cardboard robot, Rivet, walks between rooms, works material on the bench,
carries the parts he makes to the gallery and assembles them on a pedestal. User types a build
request; an LLM turns it into an ordered list of shop steps (room + action + optional part); a
deterministic solver turns the parts into a standing object; Rivet's executor plays it out. Each
finished build is distilled into a reusable skill and recalled on the next similar request.

## Commands

```bash
npm install          # electron + three
npm start             # run app
npm run dev            # run app with --dev (opens detached DevTools)
npm test                # solver, geometry and wiring checks — no renderer, no window
npm run make             # electron-builder --mac --dir  → dist/mac/Workshop Forge.app
npm run dmg               # electron-builder --mac        → dist/Workshop Forge-1.0.0.dmg
```

No linter configured. Built app is unsigned — first launch needs right-click → Open.

## Architecture

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

**Three LLM calls per build, all optional.** Plan → critique → reflect. Any of them failing degrades
to something local: keyword planning, geometry-only inspection, mechanical skill distillation. None
of them blocks the build.

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
then shoves the neighbours away from a part that has not moved. `test/geometry.test.mjs` measures
real rotated meshes vertex by vertex and fails if the solver's bounds are either smaller than the
mesh (parts intersect) or more than 35% larger (phantom shoving). The CAD selection box uses
`setFromObject(mesh, true)` for the same reason.

**Nudges are world-axis offsets applied AFTER the face places the part.** They used to be folded into
the placement and then discarded on any face whose normal they ran along, which is why `dx` did
nothing to anything on a left or right face. A non-zero `dy` also sets `fixed`, or gravity would undo
a deliberate standoff the instant it was typed.

**Arrays are the highest-leverage part of the prompt.** Models reliably omit the second, third and
fourth leg but reliably remember to say "four legs" when given a field for it.

**`assembly.js` and `skills.js` import nothing.** No three.js, no DOM. That is deliberate and worth
preserving: it is what makes the entire planning and layout path testable in node. `test/wiring.test.mjs`
asserts `assembly.js` has no local imports; if you need three.js in there, you have put something in
the wrong file.

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
the executor plays them itself; nobody asks Rivet to "pick_up".

**Reach IK, not a pose library.** `character.applyReach` runs two-bone CCD on `foreR`/`armR` toward
`wp.contact`, the point on the material the tool should be touching, blended in at ~0.5 weight and
clamped to arm length. CCD rather than an analytic solve because it is self-correcting and
sign-agnostic — an analytic solve with a wrong sign fails silently and can only be caught by looking
at it. The clip still owns the character of the motion.

**Executor is a state machine over two loops.** `renderer/app.js`: the step loop
(`next → walk → work → next`) and the haul loop (`goto → lift → carry → place`). A haul is triggered
when the plan reaches a `finished` step with parts still on a rack, and again at the end of the plan.
Parts are staged in the room that made them and only ever move in Rivet's arms — `world.stagePart`,
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

**The skill loop.** After a build, `buildReflectMessages` asks the model for semantics only — name,
class, keywords, part roles, lessons. `skills.recipeFrom` takes the geometry from the plan's part
specs (which are what the solver verified), never from the model's description. `skills.learn`
merges by class: same class updates in place, replaces the stored recipe with the newer corrected
one, and raises confidence more for a build that needed no corrections. `skills.recall` scores
keyword + class overlap on the next request and `agent.recalledBlock` folds the winner into the
prompt. `offlinePlan(request, recalled)` will instantiate a learned recipe directly, so a shop that
has built a lamp once can build a proper lamp with no network.

## File map

```
main.js          Electron main — window, settings, skill library on disk, LLM transport
preload.js       contextBridge surface, no node access in renderer
renderer/
  assembly.js    THE SOLVER. attach graph, arrays, gravity, separation, fit, joints. No imports.
  shapes.js      part spec → three.js geometry. Chamfered boxes, flat-lying tori.
  world.js       rooms, dressing, lighting, camera, staging racks, workpieces, seams, env map
  character.js   Rivet's rig, reach IK, carrying, prop/headgear swapping, particles, playback
  animations.js  the clip library (A(...) entries) + evaluator; source of truth for ACTION_IDS
  props.js       hand tools + headgear meshes, built from primitives
  textures.js    procedural canvas textures
  agent.js       system prompts, schemas, parsePlan/validatePlan, plan editing, offlinePlan
  cad.js         the bench — CAD viewport over the shop canvas, attach tree, live editing
  skills.js      distil / score / recall / reinforce / sanitize a learned build. No imports.
  critic.js      solve a plan and audit the result — the bridge from agent to assembly
  app.js         executor state machine + UI wiring
test/
  solver.test.mjs    solver fixtures, skill library, whole offline pipeline end to end
  geometry.test.mjs  real three.js meshes measured against the solver's assumptions
  wiring.test.mjs    imports, DOM ids, IPC bridge, CSP hash, clip coverage
```

## Notes for changes

- Representative, not CAD: the LLM picks shape/material/rough dimensions per part; the app renders
  that primitive. Parts touch, stack, hang off each other and get welded where they meet — they are
  not constrained and there is no mating. Don't try to make output dimensionally exact (see README
  "What this is not").
- Run `npm test` before and after touching `assembly.js`, `shapes.js`, `skills.js` or `agent.js`.
  66 checks, under a second, and they catch the silent failures — a part that hovers 2cm above its
  support does not throw, and neither does an attachment renumbered onto the wrong parent.
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
  a torn write costs the user everything Rivet has learned.
