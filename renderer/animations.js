/* =====================================================================
   Rivet's animation library.

   Each clip is (static pose) + (a set of sine oscillators on joints).
   Evaluated every frame; blended across 0.22s when a clip changes.
   Joint channels: 0 = X (swing fwd/back), 1 = Y (twist), 2 = Z (splay).
   ===================================================================== */

export const JOINTS = [
  'hips', 'torso', 'head',
  'armL', 'armR', 'foreL', 'foreR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR'
];

export const BASE_POSE = {
  hips: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0],
  armL: [0, 0, 0.14], armR: [0, 0, -0.14],
  foreL: [-0.12, 0, 0], foreR: [-0.12, 0, 0],
  handL: [0, 0, 0], handR: [0, 0, 0],
  thighL: [0, 0, 0.03], thighR: [0, 0, -0.03],
  shinL: [0.05, 0, 0], shinR: [0.05, 0, 0]
};

const C = [];
const A = (id, label, o) => { C.push(Object.assign({ id, label, dur: 2, loop: true, speed: 1 }, o)); };

/* ---------------------------------------------------------------- */
/* 1 · locomotion + idle                                             */
/* ---------------------------------------------------------------- */
A('idle', 'standing by', {
  osc: [
    { j: 'torso', a: 0, amp: 0.025, f: 0.32 }, { j: 'head', a: 1, amp: 0.09, f: 0.19 },
    { j: 'armL', a: 0, amp: 0.05, f: 0.32 }, { j: 'armR', a: 0, amp: 0.05, f: 0.32, p: 0.5 }
  ], bob: { amp: 0.018, f: 0.32 }
});
A('idle_look', 'looking around', {
  osc: [
    { j: 'head', a: 1, amp: 0.55, f: 0.28 }, { j: 'head', a: 0, amp: 0.1, f: 0.4 },
    { j: 'torso', a: 1, amp: 0.14, f: 0.28 }
  ], bob: { amp: 0.015, f: 0.4 }
});
A('walk', 'walking', {
  dur: 1, osc: [
    { j: 'thighL', a: 0, amp: 0.62, f: 1.35 }, { j: 'thighR', a: 0, amp: 0.62, f: 1.35, p: Math.PI },
    { j: 'shinL', a: 0, amp: 0.44, f: 1.35, p: -1.1, o: 0.42 }, { j: 'shinR', a: 0, amp: 0.44, f: 1.35, p: Math.PI - 1.1, o: 0.42 },
    { j: 'armL', a: 0, amp: 0.5, f: 1.35, p: Math.PI }, { j: 'armR', a: 0, amp: 0.5, f: 1.35 },
    { j: 'torso', a: 1, amp: 0.12, f: 1.35 }, { j: 'head', a: 1, amp: 0.07, f: 1.35, p: Math.PI }
  ], bob: { amp: 0.055, f: 2.7 }
});
A('walk_carry', 'hauling material', {
  dur: 1, pose: { armL: [-1.5, 0, 0.3], armR: [-1.5, 0, -0.3], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0], torso: [-0.12, 0, 0] },
  osc: [
    { j: 'thighL', a: 0, amp: 0.44, f: 1.15 }, { j: 'thighR', a: 0, amp: 0.44, f: 1.15, p: Math.PI },
    { j: 'shinL', a: 0, amp: 0.34, f: 1.15, p: -1.1, o: 0.36 }, { j: 'shinR', a: 0, amp: 0.34, f: 1.15, p: Math.PI - 1.1, o: 0.36 },
    { j: 'armL', a: 0, amp: 0.08, f: 2.3 }, { j: 'armR', a: 0, amp: 0.08, f: 2.3 }
  ], bob: { amp: 0.05, f: 2.3 }, internal: true
});
/* The two clips the executor drives itself. Marked internal so they stay
   out of the menu the planner picks from — nobody asks Rivet to "pick_up",
   it is just what he does between one operation and the next. */
A('pick_up', 'lifting it off the rack', {
  dur: 1.5, internal: true,
  pose: {
    torso: [0.44, 0, 0], head: [0.3, 0, 0],
    armL: [-1.0, 0, 0.34], armR: [-1.0, 0, -0.34], foreL: [-0.55, 0, 0], foreR: [-0.55, 0, 0],
    thighL: [-0.5, 0, 0.14], thighR: [-0.5, 0, -0.14], shinL: [0.62, 0, 0], shinR: [0.62, 0, 0]
  },
  osc: [
    { j: 'torso', a: 0, amp: 0.34, f: 0.66, o: -0.22 },
    { j: 'armL', a: 0, amp: 0.3, f: 0.66 }, { j: 'armR', a: 0, amp: 0.3, f: 0.66 },
    { j: 'head', a: 0, amp: 0.12, f: 0.66 }
  ],
  bob: { amp: 0.09, f: 0.66, o: -0.12 }, mood: 'focus'
});
A('set_down', 'setting it in place', {
  dur: 1.7, internal: true,
  pose: {
    torso: [0.34, 0, 0], head: [0.34, 0, 0],
    armL: [-1.5, 0, 0.3], armR: [-1.5, 0, -0.3], foreL: [-0.4, 0, 0], foreR: [-0.4, 0, 0],
    thighL: [-0.3, 0, 0.14], thighR: [-0.3, 0, -0.14], shinL: [0.38, 0, 0], shinR: [0.38, 0, 0]
  },
  osc: [
    { j: 'armL', a: 0, amp: 0.22, f: 0.6, o: -0.1 }, { j: 'armR', a: 0, amp: 0.22, f: 0.6, o: -0.1 },
    { j: 'torso', a: 0, amp: 0.14, f: 0.6 }, { j: 'foreL', a: 0, amp: 0.16, f: 0.6 }, { j: 'foreR', a: 0, amp: 0.16, f: 0.6 }
  ],
  bob: { amp: 0.05, f: 0.6, o: -0.08 }, mood: 'focus'
});
A('run', 'hustling', {
  dur: 0.6, pose: { torso: [-0.3, 0, 0] },
  osc: [
    { j: 'thighL', a: 0, amp: 1.0, f: 2.4 }, { j: 'thighR', a: 0, amp: 1.0, f: 2.4, p: Math.PI },
    { j: 'shinL', a: 0, amp: 0.75, f: 2.4, p: -1.2, o: 0.7 }, { j: 'shinR', a: 0, amp: 0.75, f: 2.4, p: Math.PI - 1.2, o: 0.7 },
    { j: 'armL', a: 0, amp: 0.95, f: 2.4, p: Math.PI, o: -0.5 }, { j: 'armR', a: 0, amp: 0.95, f: 2.4, o: -0.5 },
    { j: 'foreL', a: 0, amp: 0.1, f: 2.4, o: -1.1 }, { j: 'foreR', a: 0, amp: 0.1, f: 2.4, o: -1.1 }
  ], bob: { amp: 0.1, f: 4.8 }
});
A('crouch', 'checking the low shelf', {
  pose: { thighL: [-1.25, 0, 0.14], thighR: [-1.25, 0, -0.14], shinL: [1.5, 0, 0], shinR: [1.5, 0, 0], torso: [0.3, 0, 0], armL: [-0.7, 0, 0.2], armR: [-0.7, 0, -0.2] },
  osc: [{ j: 'torso', a: 0, amp: 0.06, f: 0.6 }], bob: { amp: 0.02, f: 0.6, o: -0.62 }
});
A('stretch', 'working out a kink', {
  dur: 3, pose: { armL: [-2.7, 0, 0.4], armR: [-2.7, 0, -0.4], torso: [-0.25, 0, 0], head: [-0.3, 0, 0] },
  osc: [{ j: 'torso', a: 1, amp: 0.2, f: 0.35 }, { j: 'armL', a: 2, amp: 0.15, f: 0.35 }]
});
A('turn', 'turning around', {
  dur: 1, osc: [{ j: 'hips', a: 1, amp: 0.5, f: 1 }, { j: 'torso', a: 1, amp: 0.3, f: 1, p: 0.4 }, { j: 'armL', a: 0, amp: 0.3, f: 1 }, { j: 'armR', a: 0, amp: 0.3, f: 1, p: Math.PI }]
});

/* ---------------------------------------------------------------- */
/* 2 · software room                                                 */
/* ---------------------------------------------------------------- */
A('type', 'writing the build spec', {
  room: 'software', dur: 0.5,
  pose: { thighL: [-1.5, 0, 0.14], thighR: [-1.5, 0, -0.14], shinL: [1.5, 0, 0], shinR: [1.5, 0, 0], armL: [-1.15, 0, 0.3], armR: [-1.15, 0, -0.3], foreL: [-0.85, 0, 0], foreR: [-0.85, 0, 0], torso: [0.12, 0, 0], head: [0.18, 0, 0] },
  osc: [
    { j: 'handL', a: 0, amp: 0.34, f: 4.4 }, { j: 'handR', a: 0, amp: 0.34, f: 5.1, p: 1.1 },
    { j: 'foreL', a: 1, amp: 0.09, f: 1.3 }, { j: 'foreR', a: 1, amp: 0.09, f: 1.7, p: 2 }
  ], bob: { amp: 0.005, f: 4, o: -0.75 }, sit: true, mood: 'focus'
});
A('mouse_click', 'clicking through the model catalog', {
  room: 'software', dur: 1.2,
  pose: { thighL: [-1.5, 0, 0.14], thighR: [-1.5, 0, -0.14], shinL: [1.5, 0, 0], shinR: [1.5, 0, 0], armL: [-0.6, 0, 0.2], armR: [-1.2, 0, -0.35], foreR: [-0.8, 0, 0], torso: [0.1, 0, 0] },
  osc: [{ j: 'handR', a: 0, amp: 0.22, f: 2.2 }, { j: 'armR', a: 1, amp: 0.13, f: 0.5 }], bob: { amp: 0.004, f: 1, o: -0.75 }, sit: true
});
A('read_screen', 'reading the spec back', {
  room: 'software', dur: 3,
  pose: { thighL: [-1.5, 0, 0.14], thighR: [-1.5, 0, -0.14], shinL: [1.5, 0, 0], shinR: [1.5, 0, 0], armL: [-0.4, 0, 0.5], armR: [-0.4, 0, -0.5], torso: [-0.08, 0, 0], head: [-0.12, 0, 0] },
  osc: [{ j: 'head', a: 1, amp: 0.3, f: 0.6 }], bob: { amp: 0.004, f: 0.5, o: -0.75 }, sit: true
});
A('boot_pc', 'waking the old beige box', {
  room: 'software', dur: 2,
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.4, 0, 0], torso: [0.22, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.3, f: 0.5 }, { j: 'head', a: 0, amp: 0.08, f: 0.5 }]
});
A('cable_plug', 'patching a cable', {
  room: 'software', dur: 1.6, propR: 'cable',
  pose: { armR: [-1.9, 0, -0.5], foreR: [-0.7, 0, 0], armL: [-1.2, 0, 0.5], torso: [0, 0.3, 0], head: [0.15, 0.2, 0] },
  osc: [{ j: 'foreR', a: 1, amp: 0.4, f: 1.4 }, { j: 'handR', a: 0, amp: 0.2, f: 2.8 }], mood: 'focus'
});
A('think', 'thinking it through', {
  dur: 3.4, pose: { armR: [-2.2, 0, -0.6], foreR: [-2.1, 0, 0], head: [0.16, 0.2, 0], torso: [0.06, 0.1, 0] },
  osc: [{ j: 'head', a: 1, amp: 0.16, f: 0.3 }, { j: 'foreR', a: 1, amp: 0.1, f: 0.6 }], bob: { amp: 0.012, f: 0.3 }, mood: 'focus'
});
A('scratch_head', 'not entirely sure yet', {
  dur: 2, pose: { armR: [-2.6, 0, -0.9], foreR: [-2.2, 0, 0], head: [0.1, -0.2, 0.12] },
  osc: [{ j: 'foreR', a: 2, amp: 0.3, f: 2.2 }, { j: 'head', a: 2, amp: 0.05, f: 2.2 }], mood: 'focus'
});

/* ---------------------------------------------------------------- */
/* 3 · cardboard room                                                */
/* ---------------------------------------------------------------- */
A('cut_scissors', 'cutting panels', {
  room: 'cardboard', dur: 0.55, propR: 'scissors',
  pose: { armR: [-1.55, 0, -0.42], foreR: [-0.55, 0, 0], armL: [-1.35, 0, 0.55], foreL: [-0.75, 0, 0], torso: [0.24, -0.12, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'handR', a: 2, amp: 0.34, f: 2.6 }, { j: 'armR', a: 1, amp: 0.16, f: 0.55 }, { j: 'armL', a: 1, amp: 0.1, f: 0.55 }],
  mood: 'focus', fx: 'chips'
});
A('cut_boxcutter', 'scoring a clean edge', {
  room: 'cardboard', dur: 1.5, propR: 'boxcutter', propL: 'ruler',
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.5, 0, 0], armL: [-1.5, 0, 0.5], foreL: [-0.6, 0, 0], torso: [0.28, 0, 0], head: [0.34, 0, 0] },
  osc: [{ j: 'armR', a: 2, amp: 0.42, f: 0.66 }, { j: 'foreR', a: 0, amp: 0.12, f: 0.66 }],
  mood: 'focus', fx: 'chips'
});
A('score_fold', 'creasing the fold lines', {
  room: 'cardboard', dur: 1.4, propR: 'bonefolder', propL: 'ruler',
  pose: { armR: [-1.45, 0, -0.35], foreR: [-0.6, 0, 0], armL: [-1.5, 0, 0.55], torso: [0.3, 0, 0], head: [0.34, 0, 0] },
  osc: [{ j: 'armR', a: 2, amp: 0.5, f: 0.7 }], mood: 'focus'
});
A('fold_card', 'folding it up', {
  room: 'cardboard', dur: 1.8,
  pose: { armL: [-1.6, 0, 0.5], armR: [-1.6, 0, -0.5], foreL: [-0.9, 0, 0], foreR: [-0.9, 0, 0], torso: [0.22, 0, 0], head: [0.28, 0, 0] },
  osc: [{ j: 'foreL', a: 0, amp: 0.45, f: 0.55 }, { j: 'foreR', a: 0, amp: 0.45, f: 0.55 }, { j: 'torso', a: 0, amp: 0.07, f: 0.55 }]
});
A('glue', 'running a bead of glue', {
  room: 'cardboard', dur: 2.2, propR: 'gluegun',
  pose: { armR: [-1.45, 0, -0.36], foreR: [-0.62, 0, 0], armL: [-1.25, 0, 0.5], torso: [0.26, 0, 0], head: [0.32, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.45, f: 0.45 }, { j: 'handR', a: 0, amp: 0.08, f: 0.9 }], mood: 'focus', fx: 'drip'
});
A('tape', 'taping the seam', {
  room: 'cardboard', dur: 1.6, propR: 'taperoll',
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.5, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.24, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.55, f: 0.62 }, { j: 'armL', a: 1, amp: 0.2, f: 0.62 }]
});
A('measure', 'measuring twice', {
  room: 'cardboard', dur: 2.4, propR: 'tapemeasure',
  pose: { armR: [-1.35, 0, -0.7], armL: [-1.35, 0, 0.7], foreR: [-0.3, 0, 0], foreL: [-0.3, 0, 0], torso: [0.16, 0, 0], head: [0.26, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.34, f: 0.42, o: 0.34 }, { j: 'head', a: 1, amp: 0.22, f: 0.42 }], mood: 'focus'
});
A('draw_marker', 'marking the layout', {
  room: 'cardboard', dur: 1.3, propR: 'marker',
  pose: { armR: [-1.5, 0, -0.36], foreR: [-0.55, 0, 0], armL: [-1.2, 0, 0.55], torso: [0.3, 0, 0], head: [0.36, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.4, f: 0.78 }, { j: 'foreR', a: 0, amp: 0.14, f: 1.56 }], mood: 'focus'
});
A('punch_hole', 'punching holes', {
  room: 'cardboard', dur: 0.9, propR: 'holepunch',
  pose: { armR: [-1.4, 0, -0.4], foreR: [-0.7, 0, 0], armL: [-1.2, 0, 0.5], torso: [0.24, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.3, f: 1.1 }, { j: 'armR', a: 1, amp: 0.24, f: 0.36 }], fx: 'chips'
});
A('stack_boxes', 'stacking blanks', {
  room: 'cardboard', dur: 2.2, propL: 'panel',
  pose: { armL: [-1.7, 0, 0.34], armR: [-1.7, 0, -0.34], foreL: [-0.6, 0, 0], foreR: [-0.6, 0, 0], torso: [0.12, 0, 0] },
  osc: [{ j: 'armL', a: 0, amp: 0.4, f: 0.45 }, { j: 'armR', a: 0, amp: 0.4, f: 0.45 }, { j: 'torso', a: 0, amp: 0.14, f: 0.45 }], bob: { amp: 0.05, f: 0.45 }
});

/* ---------------------------------------------------------------- */
/* 4 · metal room                                                    */
/* ---------------------------------------------------------------- */
A('weld', 'laying down a weld bead', {
  room: 'metal', dur: 2.6, propR: 'stinger', gear: 'weldmask',
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.7, 0, 0], armL: [-1.1, 0, 0.6], torso: [0.3, 0, 0], head: [0.34, 0, 0], thighL: [-0.28, 0, 0.14], thighR: [-0.28, 0, -0.14], shinL: [0.34, 0, 0], shinR: [0.34, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.3, f: 0.38 }, { j: 'handR', a: 0, amp: 0.05, f: 6 }],
  bob: { amp: 0.01, f: 0.4, o: -0.1 }, mood: 'focus', fx: 'sparks', fxRate: 3.2, light: 0x9fd8ff
});
A('braze', 'brazing a joint', {
  room: 'metal', dur: 2.4, propR: 'torch', gear: 'goggles',
  pose: { armR: [-1.55, 0, -0.42], foreR: [-0.6, 0, 0], armL: [-1.2, 0, 0.55], torso: [0.28, 0, 0], head: [0.32, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.22, f: 0.42 }], mood: 'focus', fx: 'flame', light: 0xffb45c
});
A('grind', 'grinding the burr off', {
  room: 'metal', dur: 1.8, propR: 'grinder', gear: 'goggles',
  pose: { armR: [-1.45, 0, -0.45], foreR: [-0.7, 0, 0], armL: [-1.35, 0, 0.5], foreL: [-0.7, 0, 0], torso: [0.3, 0, 0], head: [0.32, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.4, f: 0.85 }, { j: 'armL', a: 1, amp: 0.34, f: 0.85 }, { j: 'torso', a: 0, amp: 0.05, f: 1.7 }],
  mood: 'focus', fx: 'sparks', fxRate: 5, light: 0xffd08a
});
A('hammer_anvil', 'hammering it true', {
  room: 'metal', dur: 0.72, propR: 'hammer', propL: 'tongs',
  pose: { armR: [-1.1, 0, -0.5], foreR: [-0.5, 0, 0], armL: [-1.4, 0, 0.5], foreL: [-0.5, 0, 0], torso: [0.24, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.85, f: 1.4, o: -0.4 }, { j: 'foreR', a: 0, amp: 0.5, f: 1.4, p: 0.7 }, { j: 'torso', a: 0, amp: 0.1, f: 1.4 }],
  mood: 'focus', fx: 'sparks', fxRate: 1.6, shake: 0.5
});
A('mallet_form', 'dishing it with a mallet', {
  room: 'metal', dur: 0.8, propR: 'mallet',
  pose: { armR: [-1.1, 0, -0.5], armL: [-1.4, 0, 0.5], torso: [0.24, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.7, f: 1.25, o: -0.35 }, { j: 'foreR', a: 0, amp: 0.45, f: 1.25, p: 0.7 }], shake: 0.3
});
A('saw_metal', 'sawing stock to length', {
  room: 'metal', dur: 0.85, propR: 'hacksaw', propL: 'clamp',
  pose: { armR: [-1.35, 0, -0.4], foreR: [-0.5, 0, 0], armL: [-1.4, 0, 0.55], torso: [0.28, 0, 0], head: [0.32, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.42, f: 1.18 }, { j: 'foreR', a: 0, amp: 0.3, f: 1.18, p: 0.5 }, { j: 'torso', a: 0, amp: 0.06, f: 1.18 }],
  mood: 'focus', fx: 'chips'
});
A('drill', 'drilling the mounting holes', {
  room: 'metal', dur: 1.5, propR: 'drill', gear: 'goggles',
  pose: { armR: [-1.6, 0, -0.4], foreR: [-0.5, 0, 0], armL: [-1.4, 0, 0.5], torso: [0.34, 0, 0], head: [0.38, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.14, f: 0.5, o: -0.1 }, { j: 'handR', a: 1, amp: 0.06, f: 9 }],
  mood: 'focus', fx: 'chips', fxRate: 3
});
A('bend_metal', 'bending it in the vise', {
  room: 'metal', dur: 2.2,
  pose: { armL: [-1.4, 0, 0.5], armR: [-1.4, 0, -0.5], foreL: [-0.8, 0, 0], foreR: [-0.8, 0, 0], torso: [0.2, 0, 0], thighL: [-0.4, 0, 0.16], thighR: [-0.4, 0, -0.16], shinL: [0.5, 0, 0], shinR: [0.5, 0, 0] },
  osc: [{ j: 'torso', a: 0, amp: 0.3, f: 0.42, o: 0.2 }, { j: 'armL', a: 0, amp: 0.3, f: 0.42 }, { j: 'armR', a: 0, amp: 0.3, f: 0.42 }],
  bob: { amp: 0.04, f: 0.42, o: -0.16 }, mood: 'focus'
});
A('file_metal', 'filing the edge smooth', {
  room: 'metal', dur: 1.0, propR: 'file',
  pose: { armR: [-1.4, 0, -0.42], foreR: [-0.55, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.26, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.35, f: 1.0 }, { j: 'foreR', a: 0, amp: 0.22, f: 1.0, p: 0.4 }], fx: 'chips', fxRate: 1.2
});
A('wrench_tighten', 'torquing the fasteners', {
  room: 'metal', dur: 1.3, propR: 'wrench',
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.9, 0, 0], armL: [-1.2, 0, 0.5], torso: [0.26, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'foreR', a: 1, amp: 0.75, f: 0.75 }, { j: 'torso', a: 1, amp: 0.1, f: 0.75 }], mood: 'focus'
});
A('screwdriver', 'driving screws', {
  room: 'metal', dur: 1.0, propR: 'screwdriver',
  pose: { armR: [-1.6, 0, -0.36], foreR: [-0.6, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.3, 0, 0], head: [0.34, 0, 0] },
  osc: [{ j: 'handR', a: 1, amp: 0.9, f: 1.0 }, { j: 'foreR', a: 0, amp: 0.06, f: 1.0 }]
});
A('rivet', 'setting rivets', {
  room: 'metal', dur: 0.8, propR: 'rivetgun',
  pose: { armR: [-1.55, 0, -0.4], foreR: [-0.55, 0, 0], armL: [-1.35, 0, 0.5], torso: [0.3, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.28, f: 1.25 }, { j: 'armR', a: 1, amp: 0.2, f: 0.31 }], fx: 'sparks', fxRate: 0.8, shake: 0.25
});
A('clamp_vise', 'clamping it down', {
  room: 'metal', dur: 1.4, propR: 'clamp',
  pose: { armR: [-1.45, 0, -0.4], foreR: [-0.7, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.28, 0, 0] },
  osc: [{ j: 'handR', a: 1, amp: 0.7, f: 0.9 }]
});
A('quench', 'quenching the part', {
  room: 'metal', dur: 2.4, propR: 'tongs', gear: 'goggles',
  pose: { armR: [-1.7, 0, -0.4], foreR: [-0.4, 0, 0], armL: [-0.5, 0, 0.4], torso: [0.24, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.34, f: 0.4, o: -0.1 }], fx: 'steam', fxRate: 4
});
A('pliers_bend', 'tweaking a tab with pliers', {
  room: 'metal', dur: 1.2, propR: 'pliers',
  pose: { armR: [-1.55, 0, -0.4], foreR: [-0.7, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.28, 0, 0], head: [0.34, 0, 0] },
  osc: [{ j: 'handR', a: 1, amp: 0.5, f: 0.85 }, { j: 'foreR', a: 0, amp: 0.12, f: 0.85 }], mood: 'focus'
});

/* ---------------------------------------------------------------- */
/* 5 · finishing + assembly                                          */
/* ---------------------------------------------------------------- */
A('sand', 'sanding it smooth', {
  room: 'finished', dur: 0.9, propR: 'sandblock', gear: 'dustmask',
  pose: { armR: [-1.45, 0, -0.42], foreR: [-0.6, 0, 0], armL: [-1.3, 0, 0.5], torso: [0.28, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 0, amp: 0.36, f: 1.1 }, { j: 'foreR', a: 0, amp: 0.2, f: 1.1, p: 0.4 }], fx: 'dust', fxRate: 2.4
});
A('paint', 'brushing on the finish', {
  room: 'finished', dur: 1.7, propR: 'paintbrush',
  pose: { armR: [-1.45, 0, -0.4], foreR: [-0.6, 0, 0], armL: [-0.9, 0, 0.5], torso: [0.22, 0, 0], head: [0.28, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.5, f: 0.6 }, { j: 'foreR', a: 0, amp: 0.14, f: 1.2 }], mood: 'focus'
});
A('spray_paint', 'laying down a coat', {
  room: 'finished', dur: 2.0, propR: 'spraycan', gear: 'dustmask',
  pose: { armR: [-1.7, 0, -0.42], foreR: [-0.45, 0, 0], armL: [-0.4, 0, 0.35], torso: [0.1, 0, 0], head: [0.16, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.62, f: 0.5 }, { j: 'armR', a: 0, amp: 0.12, f: 0.25 }], fx: 'mist', fxRate: 6
});
A('polish', 'buffing it up', {
  room: 'finished', dur: 0.8, propR: 'cloth',
  pose: { armR: [-1.5, 0, -0.4], foreR: [-0.55, 0, 0], armL: [-1.1, 0, 0.5], torso: [0.24, 0, 0], head: [0.3, 0, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.3, f: 1.25 }, { j: 'armR', a: 0, amp: 0.14, f: 2.5 }]
});
A('assemble', 'fitting the parts together', {
  room: 'finished', dur: 2.0,
  pose: { armL: [-1.65, 0, 0.42], armR: [-1.65, 0, -0.42], foreL: [-0.85, 0, 0], foreR: [-0.85, 0, 0], torso: [0.2, 0, 0], head: [0.28, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.22, f: 0.5 }, { j: 'armR', a: 2, amp: 0.22, f: 0.5, p: Math.PI }, { j: 'foreL', a: 0, amp: 0.15, f: 1 }, { j: 'foreR', a: 0, amp: 0.15, f: 1 }],
  mood: 'focus'
});
A('inspect', 'checking the tolerances', {
  room: 'finished', dur: 2.6, propR: 'magnifier',
  pose: { armR: [-2.1, 0, -0.45], foreR: [-1.0, 0, 0], armL: [-1.2, 0, 0.5], torso: [0.14, 0, 0], head: [0.12, 0, 0] },
  osc: [{ j: 'head', a: 1, amp: 0.24, f: 0.42 }, { j: 'armR', a: 1, amp: 0.14, f: 0.42 }], mood: 'focus'
});
A('label_it', 'writing the label', {
  room: 'finished', dur: 1.6, propR: 'marker', propL: 'clipboard',
  pose: { armR: [-1.4, 0, -0.4], foreR: [-0.8, 0, 0], armL: [-1.35, 0, 0.5], foreL: [-0.9, 0, 0], torso: [0.14, 0, 0], head: [0.26, 0, 0] },
  osc: [{ j: 'handR', a: 2, amp: 0.28, f: 1.6 }, { j: 'foreR', a: 1, amp: 0.14, f: 0.8 }]
});
A('place_part', 'setting it on the pedestal', {
  room: 'finished', dur: 2.0,
  pose: { armL: [-1.8, 0, 0.34], armR: [-1.8, 0, -0.34], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0], torso: [0.18, 0, 0], head: [0.24, 0, 0] },
  osc: [{ j: 'torso', a: 0, amp: 0.2, f: 0.5, o: 0.1 }, { j: 'armL', a: 0, amp: 0.24, f: 0.5 }, { j: 'armR', a: 0, amp: 0.24, f: 0.5 }],
  bob: { amp: 0.06, f: 0.5 }
});
A('dust_off', 'dusting off the bench', {
  dur: 0.7, pose: { armL: [-1.2, 0, 0.5], armR: [-1.2, 0, -0.5], torso: [0.16, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.4, f: 1.4 }, { j: 'armR', a: 2, amp: 0.4, f: 1.4, p: Math.PI }], fx: 'dust', fxRate: 1.5
});
A('present', 'ta-da', {
  room: 'finished', dur: 2.6,
  pose: { armL: [-2.5, 0, 0.9], armR: [-2.5, 0, -0.9], foreL: [-0.2, 0, 0], foreR: [-0.2, 0, 0], torso: [-0.14, 0, 0], head: [-0.16, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.16, f: 0.6 }, { j: 'armR', a: 2, amp: 0.16, f: 0.6, p: Math.PI }, { j: 'head', a: 1, amp: 0.12, f: 0.6 }],
  bob: { amp: 0.03, f: 0.6 }
});
A('wipe_brow', 'wiping the brow', {
  dur: 1.8, pose: { armR: [-2.5, 0, -0.5], foreR: [-1.9, 0, 0], torso: [-0.1, 0, 0], head: [-0.14, 0, 0] },
  osc: [{ j: 'foreR', a: 1, amp: 0.4, f: 0.7 }]
});

/* ---------------------------------------------------------------- */
/* 6 · reactions                                                     */
/* ---------------------------------------------------------------- */
A('celebrate', 'celebrating', {
  dur: 1.0, pose: { armL: [-2.9, 0, 0.5], armR: [-2.9, 0, -0.5], torso: [-0.2, 0, 0], head: [-0.24, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.3, f: 2 }, { j: 'armR', a: 2, amp: 0.3, f: 2, p: Math.PI }, { j: 'thighL', a: 0, amp: 0.3, f: 2 }, { j: 'thighR', a: 0, amp: 0.3, f: 2, p: Math.PI }],
  bob: { amp: 0.12, f: 2 }
});
A('thumbs_up', 'thumbs up', {
  dur: 1.6, pose: { armR: [-1.9, 0, -0.5], foreR: [-1.6, 0, 0], handR: [0, 0, -0.5], torso: [-0.05, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.14, f: 0.7 }, { j: 'head', a: 0, amp: 0.08, f: 0.7 }]
});
A('wave', 'waving', {
  dur: 1.2, pose: { armR: [-2.6, 0, -0.6], foreR: [-0.5, 0, 0] },
  osc: [{ j: 'foreR', a: 2, amp: 0.55, f: 1.7 }, { j: 'head', a: 1, amp: 0.09, f: 0.85 }]
});
A('point', 'pointing something out', {
  dur: 1.8, pose: { armR: [-1.7, 0, -0.7], foreR: [-0.1, 0, 0], torso: [0, -0.16, 0], head: [0, -0.2, 0] },
  osc: [{ j: 'armR', a: 1, amp: 0.12, f: 0.6 }]
});
A('shrug', 'not sure about that one', {
  dur: 2.2, pose: { armL: [-0.5, 0, 1.05], armR: [-0.5, 0, -1.05], foreL: [-1.3, 0, 0], foreR: [-1.3, 0, 0], head: [0.06, 0, 0] },
  osc: [{ j: 'armL', a: 2, amp: 0.13, f: 0.45 }, { j: 'armR', a: 2, amp: 0.13, f: 0.45, p: Math.PI }]
});
A('facepalm', 'that was avoidable', {
  dur: 2.6, pose: { armR: [-2.6, 0, -0.45], foreR: [-2.3, 0, 0], head: [0.36, 0, 0], torso: [0.16, 0, 0] },
  osc: [{ j: 'torso', a: 0, amp: 0.05, f: 0.3 }], mood: 'focus'
});
A('confused', 'reading that again', {
  dur: 2.4, pose: { head: [0.05, 0.24, 0.24], armL: [-0.6, 0, 0.7], armR: [-1.9, 0, -0.6], foreR: [-1.7, 0, 0] },
  osc: [{ j: 'head', a: 2, amp: 0.16, f: 0.4 }, { j: 'head', a: 1, amp: 0.18, f: 0.4 }], mood: 'focus'
});
A('salute', 'on it', {
  dur: 1.4, pose: { armR: [-2.3, 0, -0.85], foreR: [-1.9, 0, 0], torso: [-0.06, 0, 0], head: [-0.06, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.08, f: 0.7 }]
});
A('sip_coffee', 'taking five', {
  dur: 3.0, propR: 'mug',
  pose: { armR: [-2.2, 0, -0.4], foreR: [-1.7, 0, 0], head: [-0.08, 0, 0] },
  osc: [{ j: 'foreR', a: 0, amp: 0.22, f: 0.34 }, { j: 'head', a: 0, amp: 0.08, f: 0.34 }]
});
A('trip', 'catching a trailing cable', {
  dur: 1.4, pose: { torso: [0.5, 0, 0], armL: [-2.6, 0, 0.7], armR: [-2.6, 0, -0.7], thighL: [-0.6, 0, 0.2], thighR: [0.4, 0, -0.2] },
  osc: [{ j: 'torso', a: 0, amp: 0.2, f: 1.4 }, { j: 'armL', a: 2, amp: 0.3, f: 2.8 }], bob: { amp: 0.1, f: 1.4, o: -0.14 }
});

export const CLIPS = C;
export const CLIP_BY_ID = Object.fromEntries(C.map(c => [c.id, c]));

/* What the planner is allowed to ask for. Internal clips — walking with an
   armful of parts, crouching to lift one — are played by the executor at
   the moments they belong to, so they are deliberately not on the menu. */
export const ACTION_IDS = C.filter(c => !c.internal).map(c => c.id);

/* Rooms an action belongs to; unroomed clips are generic and play anywhere. */
export const ACTIONS_BY_ROOM = CLIPS.reduce((m, c) => {
  if (c.internal) return m;
  const k = c.room || 'any';
  (m[k] = m[k] || []).push(c.id);
  return m;
}, {});

/* ---------------- evaluation ---------------- */
export function evalClip(clip, t) {
  const out = {};
  for (const j of JOINTS) out[j] = BASE_POSE[j].slice();
  if (clip.pose) for (const j in clip.pose) out[j] = clip.pose[j].slice();
  if (clip.osc) {
    for (const o of clip.osc) {
      const v = Math.sin(2 * Math.PI * (o.f || 1) * t + (o.p || 0));
      if (!out[o.j]) out[o.j] = [0, 0, 0];
      out[o.j][o.a] += (o.o || 0) + (o.amp || 0) * v;
    }
  }
  let y = 0;
  if (clip.bob) y = (clip.bob.o || 0) + clip.bob.amp * Math.sin(2 * Math.PI * clip.bob.f * t);
  else if (clip.sit) y = -0.75;
  return { rot: out, y };
}

export function lerpPose(a, b, k) {
  const out = { rot: {}, y: a.y + (b.y - a.y) * k };
  for (const j of JOINTS) {
    const A0 = a.rot[j] || BASE_POSE[j], B0 = b.rot[j] || BASE_POSE[j];
    out.rot[j] = [A0[0] + (B0[0] - A0[0]) * k, A0[1] + (B0[1] - A0[1]) * k, A0[2] + (B0[2] - A0[2]) * k];
  }
  return out;
}
