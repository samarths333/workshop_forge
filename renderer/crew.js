/* THE FLOOR, MOVING.

   The old executor was one state machine driving one robot through one list
   of steps: next → walk → work → next, with a haul loop bolted on. That is
   the wrong shape for six robots, because six robots are not six
   sequential jobs — they are five machines running at once, and the only
   thing that has to be sequenced is the moment the parts come together.

   So this is one small machine PER ROBOT, all ticked from the same frame,
   plus a floor-level phase that says what the shop as a whole is doing:

     working    every specialist runs its own queue, at its own bench, at the
                same time. The foreman walks the floor and watches.
     haul       the specialists are done. The foreman goes round the racks,
                collects what they made and sets it on the pedestal.
     finishing  the foreman's own steps — fitting it together, inspecting it,
                handing it over.
     done

   The parts get placed in PART ORDER even though they were made in whatever
   order six robots happened to finish in, because the solver numbered them
   and the base going down after the roof looks like a mistake even when the
   final geometry is identical.

   Everything that touches the DOM, the log or the pedestal stays in app.js
   and arrives here as a callback. This file knows about robots, benches and
   time. */

import { CREW, roleById, stationOf, makesParts, FOREMAN } from './roles.js';
import { Rivet } from './character.js';
import { ROOMS, PEDESTAL_Z } from './world.js';
import { CLIP_BY_ID } from './animations.js';

/* how many parts one robot can get its arms around in a trip */
export const ARMFUL = 4;

/* Idle loops, split by trade so a floor at rest does not look like five
   copies of the same robot doing the same shrug on the same frame. */
const IDLE_BY_ROLE = {
  structures: ['idle', 'dust_off', 'stretch', 'wipe_brow', 'idle_look'],
  softgoods: ['idle', 'idle_look', 'scratch_head', 'measure', 'stretch'],
  electrical: ['idle', 'think', 'read_screen', 'idle_look', 'sip_coffee'],
  controls: ['type', 'read_screen', 'think', 'sip_coffee', 'idle'],
  foreman: ['idle', 'point', 'inspect', 'idle_look', 'sip_coffee', 'think']
};

/* Where each robot stands when it has nothing to do — off its own bench, out
   of the walkway, and not on top of anybody else. */
function idleSpotOf(roleId, i) {
  const st = ROOMS[stationOf(roleId)];
  return { x: st.x + 2.6, z: 1.4 + (i % 3) * 0.5 };
}

/* Lanes. Six robots walking the same z would walk through each other, and
   the fix is the one a real shop uses: everybody has a lane. */
const laneOf = i => 3.2 + i * 0.55;

export class Crew {
  constructor(world, hooks = {}) {
    this.world = world;
    this.hooks = hooks;
    this.bots = [];
    this.byRole = new Map();

    CREW.forEach((role, i) => {
      const bot = new Rivet(world.scene, {
        role: role.id, name: role.name, trade: role.trade,
        accent: role.accent, tint: role.tint
      });
      const spot = idleSpotOf(role.id, i);
      bot.root.position.set(spot.x, 0, spot.z);
      bot.home = spot;
      bot.lane = laneOf(i);
      bot.queue = [];
      bot.step = null;
      bot.phase = 'idle';
      bot.t = 0;
      bot.wp = null;
      bot.made = 0;
      bot.idleTimer = Math.random() * 4;
      this.bots.push(bot);
      this.byRole.set(role.id, bot);
    });

    this.foreman = this.byRole.get(FOREMAN.id);
    this.phase = 'idle';
    this.haul = null;
    this.plan = null;
    this.partsMade = 0;
  }

  /* ---------------- work allocation ---------------- */

  /* Split the plan across the floor. Order WITHIN a robot's queue is the
     plan's order — a trade still does its own operations in sequence. Order
     BETWEEN robots is not preserved and is not meant to be: that is the
     whole point of having five of them. */
  load(plan) {
    this.plan = plan;
    this.partsMade = 0;
    this.haul = null;
    let partIndex = 0;
    for (const bot of this.bots) { bot.queue = []; bot.step = null; bot.phase = 'idle'; bot.t = 0; bot.made = 0; }

    for (const step of plan.steps) {
      const owner = this.byRole.has(step.by) ? step.by : FOREMAN.id;
      const item = { step, partIndex: step.part ? partIndex++ : null };
      this.byRole.get(owner).queue.push(item);
    }
    /* The foreman's FITTING steps wait until everything is on the pedestal —
       he cannot assemble parts that are still on a rack. His own MAKING
       steps do not wait: paint and glass are his, and holding those back
       until after the haul would leave them on a rack forever with nobody
       coming to collect them.

       So the queue is cut at the last step of his that produces a part:
       everything up to there runs alongside the trades, everything after it
       is held for the fitting. */
    const q = this.foreman.queue;
    let cut = 0;
    for (let i = 0; i < q.length; i++) if (q[i].step.part) cut = i + 1;
    this.foreman.queue = q.slice(0, cut);
    this.foremanQueue = q.slice(cut);

    for (const bot of this.bots) if (bot.queue.length) bot.phase = 'next';
    this.phase = 'working';
    return this;
  }

  stop() {
    for (const bot of this.bots) {
      bot.queue = []; bot.step = null; bot.phase = 'idle'; bot.t = 0;
      bot.reachTarget = null;
      this.world.releaseWork(bot.wp, false);
      bot.wp = null;
      if (bot.carried.length) bot.carried.splice(0).forEach(m => bot.carrySlot.remove(m));
    }
    this.foremanQueue = [];
    this.phase = 'idle';
    this.haul = null;
  }

  get running() { return this.phase !== 'idle' && this.phase !== 'done'; }

  /* Whether every trade has finished making things. The foreman does not
     start collecting until they have, or he walks to a rack that is about to
     have another part put on it. */
  get specialistsDone() {
    return this.bots.every(b => !b.queue.length && b.phase !== 'walk' && b.phase !== 'work');
  }

  busy(roleId) {
    const b = this.byRole.get(roleId);
    return !!b && (b.phase === 'walk' || b.phase === 'work');
  }

  /* What each robot is doing right now, for the crew panel. */
  status() {
    return this.bots.map(b => ({
      role: b.role, name: b.name,
      phase: b.phase, left: b.queue.length,
      made: b.made,
      doing: b.step ? (CLIP_BY_ID[b.step.step.action]?.label || b.step.step.action) : ''
    }));
  }

  /* ---------------- the frame ---------------- */
  tick(dt, t) {
    if (this.phase === 'idle' || this.phase === 'done') { this.idleAll(dt); return; }

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot === this.foreman) continue;
      this.botTick(bot, dt, t);
    }
    this.foremanTick(dt, t);

    if (this.phase === 'working' && this.specialistsDone) {
      const staged = this.world.stagedRooms().length || this.foreman.load;
      this.phase = staged ? 'haul' : 'finishing';
      if (this.phase === 'haul') {
        this.haul = { stage: this.foreman.load ? 'carry' : 'goto', t: 0, room: null };
        this.hooks.onCaption?.(this.foreman, 'collecting', 'Right — bringing it all in.');
      } else {
        this.foreman.queue = this.foremanQueue || [];
        this.foreman.phase = this.foreman.queue.length ? 'next' : 'idle';
      }
    }
  }

  /* ---------------- one specialist ---------------- */
  botTick(bot, dt) {
    if (bot.phase === 'next') {
      bot.step = bot.queue.shift() || null;
      if (!bot.step) { bot.phase = 'idle'; bot.idleTimer = 0; this.hooks.onBotDone?.(bot); return; }
      bot.phase = 'walk'; bot.t = 0;
      return;
    }

    if (bot.phase === 'idle') { this.idleBot(bot, dt); return; }

    const step = bot.step.step;
    const st = this.stationFor(step);

    if (bot.phase === 'walk') {
      const far = Math.abs(bot.pos.x - st.x) > 6;
      bot.play(far ? 'run' : 'walk');
      bot.reachTarget = null;
      /* Cross the shop in your own lane, then turn in to the bench. Walking
         straight at the bench from wherever you were standing is what puts
         two robots through each other in the middle of the floor. */
      const inLane = Math.abs(bot.pos.x - st.x) > 2.2;
      const target = inLane ? { x: st.x, z: bot.lane } : st;
      if (bot.stepTowards(target.x, target.z, dt, far ? 5.4 : 3.2) && !inLane) {
        bot.phase = 'work'; bot.t = 0;
        bot.play(step.action);
        bot.wp = this.world.beginWork(step, step.room);
        bot.reachTarget = bot.wp ? bot.wp.contact : null;
        this.hooks.onStepStart?.(bot, step);
      }
      return;
    }

    if (bot.phase === 'work') {
      const b = ROOMS[step.room].bench;
      bot.faceTowards(b[0], b[1], dt, 5);
      bot.t += dt;
      this.world.updateWork(bot.wp, Math.min(1, bot.t / step.seconds), performance.now() / 1000);
      this.hooks.onProgress?.(bot, bot.t / step.seconds);
      if (bot.t >= step.seconds) {
        const mesh = this.world.releaseWork(bot.wp, !!step.part);
        bot.wp = null;
        bot.reachTarget = null;
        if (mesh) {
          mesh.userData.partIndex = bot.step.partIndex;
          this.world.stagePart(mesh, step.room);
          bot.made++;
          this.partsMade++;
          this.hooks.onPartMade?.(bot, step, bot.step.partIndex);
        }
        bot.phase = 'next';
      }
    }
  }

  /* ---------------- the foreman ---------------- */
  foremanTick(dt, t) {
    const f = this.foreman;

    if (this.phase === 'working') {
      /* He has parts of his own on some builds — the paint, the glass, the
         fitted trim — and those are made alongside everybody else's. */
      if (f.queue.length || f.phase === 'walk' || f.phase === 'work' || f.phase === 'next') {
        this.botTick(f, dt, t);
        if (f.phase !== 'idle') return;
      }
      /* Otherwise he is not idle while the trades work, he is supervising:
         walk to whoever is actually cutting metal and watch them do it. It
         costs nothing and it is the difference between a manager and a
         statue. */
      f.idleTimer -= dt;
      if (f.idleTimer <= 0) {
        f.idleTimer = 4 + Math.random() * 4;
        const busy = this.bots.filter(b => b !== f && b.phase === 'work');
        f.watch = busy.length ? busy[Math.floor(Math.random() * busy.length)] : null;
      }
      if (f.watch && f.watch.phase === 'work') {
        const wx = f.watch.pos.x + 2.0;
        if (f.stepTowards(wx, f.lane, dt, 2.4)) {
          f.faceTowards(f.watch.pos.x, f.watch.pos.z, dt, 3);
          f.play('inspect');
        } else f.play('walk');
      } else {
        this.idleBot(f, dt);
      }
      return;
    }

    if (this.phase === 'haul') { this.haulTick(dt); return; }

    if (this.phase === 'finishing') {
      this.botTick(f, dt, t);
      if (f.phase === 'idle' && !f.queue.length) {
        this.phase = 'done';
        this.hooks.onFloorDone?.();
      }
    }
  }

  /* ---------------- the haul ---------------- */
  haulTick(dt) {
    const f = this.foreman;
    const h = this.haul;
    h.t += dt;

    if (h.stage === 'goto') {
      const racks = this.world.stagedRooms();
      if (!racks.length) { this.endHaul(); return; }
      racks.sort((a, b) => Math.abs(a.x - f.pos.x) - Math.abs(b.x - f.pos.x));
      h.room = racks[0].room;
      const rack = this.world.racks[h.room];
      const far = Math.abs(f.pos.x - rack.x) > 6;
      f.play(far ? 'run' : 'walk');
      this.hooks.onCaption?.(f, far ? 'crossing the floor' : 'walking', `Going for the ${h.room} parts.`);
      if (f.stepTowards(rack.x, rack.z + 1.15, dt, far ? 5.4 : 3.2)) { h.stage = 'lift'; h.t = 0; }
      return;
    }

    if (h.stage === 'lift') {
      const rack = this.world.racks[h.room];
      f.faceTowards(rack.x, rack.z, dt, 6);
      f.play('pick_up');
      if (h.t > 1.1) {
        const take = this.world.takeStaged(h.room, ARMFUL - f.load);
        for (const m of take) f.carry(m);
        this.hooks.onPickUp?.(f, h.room, take.length);
        h.stage = (f.load < ARMFUL && this.world.stagedRooms().length) ? 'goto' : 'carry';
        h.t = 0;
      }
      return;
    }

    if (h.stage === 'carry') {
      if (!f.load) { h.stage = 'goto'; return; }
      /* Sort the armful so the object goes together from the bottom up. Five
         robots working at once finish in whatever order they finish in, and
         watching a roof land before its walls reads as a bug even though the
         solver put both in the right place. */
      f.carried.sort((a, b) => (a.userData.partIndex ?? 0) - (b.userData.partIndex ?? 0));
      f.arrangeCarried();
      const tx = ROOMS.finished.x, tz = PEDESTAL_Z + 1.15;
      const far = Math.abs(f.pos.x - tx) > 6;
      f.play('walk_carry');
      this.hooks.onCaption?.(f, 'bringing it in', `Carrying ${f.load} part${f.load === 1 ? '' : 's'} to the bay.`);
      if (f.stepTowards(tx, tz, dt, far ? 3.6 : 2.6)) { h.stage = 'place'; h.t = 0; }
      return;
    }

    if (h.stage === 'place') {
      f.faceTowards(ROOMS.finished.x, PEDESTAL_Z, dt, 6);
      f.play('set_down');
      if (h.t > 0.55) {
        h.t = 0;
        const mesh = f.takeCarried();
        if (mesh) this.hooks.onPlace?.(f, mesh);
        if (!f.load) {
          f.reachTarget = null;
          h.stage = this.world.stagedRooms().length ? 'goto' : 'done';
        }
      }
      return;
    }

    if (h.stage === 'done') this.endHaul();
  }

  endHaul() {
    this.foreman.reachTarget = null;
    this.haul = null;
    this.phase = 'finishing';
    this.foreman.queue = this.foremanQueue || [];
    this.foreman.phase = this.foreman.queue.length ? 'next' : 'idle';
    if (!this.foreman.queue.length) { this.phase = 'done'; this.hooks.onFloorDone?.(); }
  }

  /* ---------------- standing about ---------------- */
  idleAll(dt) { for (const b of this.bots) this.idleBot(b, dt); }

  idleBot(bot, dt) {
    // drift back to your own patch rather than standing wherever you stopped
    if (bot.home && !bot.stepTowards(bot.home.x, bot.home.z, dt, 1.5)) { bot.play('walk'); return; }
    bot.idleTimer -= dt;
    if (bot.idleTimer <= 0) {
      bot.idleTimer = 5 + Math.random() * 8;
      const loop = IDLE_BY_ROLE[bot.role] || IDLE_BY_ROLE.foreman;
      bot.play(loop[Math.floor(Math.random() * loop.length)]);
    }
  }

  /* ---------------- geometry ---------------- */
  stationFor(step) {
    const r = ROOMS[step.room];
    const clip = CLIP_BY_ID[step.action];
    if (clip?.sit && r.seat) return { x: r.seat[0], z: r.seat[1] };
    return { x: r.bench[0], z: r.bench[1] + 0.95 };
  }

  update(dt) { for (const b of this.bots) b.update(dt); }

  dispose() { for (const b of this.bots) b.dispose(); this.bots = []; this.byRole.clear(); }
}

export { CREW, roleById, makesParts };
