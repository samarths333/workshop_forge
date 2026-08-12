/* =====================================================================
   Undo on the bench.

   Everything in the properties panel is live: a keystroke mutates the part
   spec, the solver re-runs and the pedestal re-places itself. That is the
   right feel, but it is also unforgiving — there was no way back from a
   size typed into the wrong axis except retyping it, and no way back at all
   from a scrapped part.

   This is the way back. It keeps whole plans, not diffs: a plan is a few
   kilobytes of plain JSON, the cost of cloning one is nothing next to a
   re-solve, and a snapshot cannot go stale or apply backwards the way an
   inverse operation can. Cheap and dumb beats clever and subtly wrong.

   Two details make it usable rather than merely present:

   COALESCING. The panel fires on every keystroke, so typing "0.42" into a
   size field is four edits. Without coalescing, four undos to get back one
   number, and the stack fills with states nobody wants to return to. Edits
   that carry the same key and land within a short window fold into the one
   entry, so undo steps back by the thing a person did, not by the events
   the DOM happened to emit.

   NO-OP REJECTION. Re-selecting the same value in a dropdown, or blurring
   a field without changing it, must not consume a slot. States compare by
   their serialisation, and an identical one is dropped on the floor.

   Imports nothing, touches no DOM — same rule as assembly.js and skills.js,
   for the same reason: it can be tested in node in a millisecond.
   ===================================================================== */

export const DEFAULT_DEPTH = 50;

/* how long two edits to the same field stay "the same edit" */
export const COALESCE_MS = 700;

const clone = s => JSON.parse(JSON.stringify(s));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class History {
  constructor({ depth = DEFAULT_DEPTH, coalesceMs = COALESCE_MS, now = () => Date.now() } = {}) {
    this.depth = Math.max(2, depth);
    this.coalesceMs = coalesceMs;
    this.now = now;
    this.clear();
  }

  clear() {
    this.stack = [];      // [{ state, label, key, t }]
    this.at = -1;         // index of the state currently on screen
  }

  /* Start a fresh session from a known-good state — a new plan off the
     planner, or one just reloaded. Everything before it is unreachable,
     which is correct: you cannot undo your way into someone else's build. */
  reset(state, label = 'as planned') {
    this.clear();
    this.stack.push({ state: clone(state), label, key: null, t: this.now() });
    this.at = 0;
    return this;
  }

  /* Record a state the user just moved to. Anything sitting in front of the
     cursor is dropped — the usual branch-on-edit rule. */
  push(state, { label = 'edit', key = null } = {}) {
    if (this.at < 0) return this.reset(state, label), false;

    const cur = this.stack[this.at];
    if (same(cur.state, state)) return false;              // nothing actually changed

    const t = this.now();
    const coalesce = key != null && cur.key === key && (t - cur.t) < this.coalesceMs && this.at > 0;
    if (coalesce) {
      // fold into the entry already on top: the state it lands on is the
      // newest one, but the step back is still to before the first keystroke
      cur.state = clone(state);
      cur.label = label;
      cur.t = t;
      return true;
    }

    this.stack.length = this.at + 1;
    this.stack.push({ state: clone(state), label, key, t });
    if (this.stack.length > this.depth) this.stack.shift();
    this.at = this.stack.length - 1;
    return true;
  }

  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at >= 0 && this.at < this.stack.length - 1; }

  /* What stepping back would undo, and what stepping forward would redo —
     for the button tooltips, so it says "undo scrapped part", not "undo". */
  get undoLabel() { return this.canUndo ? this.stack[this.at].label : null; }
  get redoLabel() { return this.canRedo ? this.stack[this.at + 1].label : null; }

  undo() {
    if (!this.canUndo) return null;
    this.at--;
    // a coalescing run must not continue across an undo
    this.stack[this.at].key = null;
    return clone(this.stack[this.at].state);
  }

  redo() {
    if (!this.canRedo) return null;
    this.at++;
    this.stack[this.at].key = null;
    return clone(this.stack[this.at].state);
  }

  /* The state on screen, as far as the stack is concerned. */
  get current() { return this.at >= 0 ? clone(this.stack[this.at].state) : null; }

  /* For the panel: "3 of 7". */
  get position() { return { at: this.at, of: this.stack.length }; }
}
