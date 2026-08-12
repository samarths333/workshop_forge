/* =====================================================================
   Look at what is about to get built.

   Two kinds of checking happen once a plan is validated:

     · this file — run the plan through the assembly solver and audit the
       result. Deterministic, no model needed, so it runs even when the
       shop is offline. The solver has already dropped anything floating
       onto the part below it, so what is left here is the class of
       problem physics cannot fix: three slabs in a heap, a build with no
       height, a "table" with two components.

     · agent.js buildCritiqueMessages — semantic. "Is this a rocket with
       fins?" Only a model can answer that, and it answers much better
       when handed the solved geometry rather than the model's own guesses.
   ===================================================================== */

import { solveAssembly, auditSolved, describeSolved, effectiveSize } from './assembly.js';
import { planParts } from './agent.js';

export { effectiveSize, describeSolved };

/* Solve the plan and report on it. Returns the solved assembly too, because
   everything downstream — the executor, the seams, the skill card — wants
   the resolved geometry rather than the plan's wishes. */
export function inspectPlan(plan) {
  const solved = solveAssembly(planParts(plan));
  return {
    solved,
    issues: auditSolved(solved),
    corrections: solved.notes,
    description: describeSolved(solved)
  };
}
