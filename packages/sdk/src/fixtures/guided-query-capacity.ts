// Inert unit-test subprocess. Imports the actual module, never query/runtime/native code.
import { randomUUID } from "node:crypto";
import { prepareGuidedQuery, claimGuidedQuery, consumeGuidedQueryCorrelation, closeGuidedQuery } from "../guided-query-preparation.ts";
const pair = {
  onRuntimeContext: async (): Promise<never> => { throw new Error("unexpected callback"); },
  spawnClaudeCodeProcess: (): never => { throw new Error("unexpected spawn"); },
};
const make = () => { const preparation = prepareGuidedQuery(pair); return { preparation, claim: () => claimGuidedQuery(preparation, pair) }; };
const args = () => ["--run", "--config-json", JSON.stringify({ requiredRuntimeContext: { version: 1, bindingId: randomUUID() } })];
const refused = (call: () => unknown) => {
  try { call(); } catch (error) { if (error instanceof Error && error.message === "required_context_unavailable") return; throw error; }
  throw new Error("capacity refusal missing");
};
const pending = make(), pendingClaim = pending.claim(), held = make(), heldClaim = held.claim();
consumeGuidedQueryCorrelation(heldClaim, args());
for (let i = 1; i < 4096; i++) { const next = make(); consumeGuidedQueryCorrelation(next.claim(), args()); closeGuidedQuery(next.preparation); }
const exhausted = make(); refused(() => exhausted.claim()); refused(() => exhausted.claim());
refused(() => consumeGuidedQueryCorrelation(pendingClaim, args())); refused(() => pending.claim());
refused(() => claimGuidedQuery(held.preparation, pair)); refused(() => consumeGuidedQueryCorrelation(heldClaim, args()));
closeGuidedQuery(held.preparation);
console.log("guided-query-capacity:4096");
