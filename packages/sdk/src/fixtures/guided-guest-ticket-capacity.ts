// Inert unit-test subprocess. Imports the actual modules, never query/runtime/native code. Claims its own issuer in
// its own module realm, so the parent test process's one claim is untouched.
import { randomUUID } from "node:crypto";
import { prepareGuidedQuery, claimGuidedQuery, consumeGuidedQueryCorrelation, closeGuidedQuery, GUIDED_QUERY_CORRELATION_CAPACITY } from "../guided-query-preparation.ts";
import { claimGuidedGuestIssuer } from "../guided-guest-attestation.ts";

const CAPACITY = 4096;
if (GUIDED_QUERY_CORRELATION_CAPACITY !== CAPACITY) throw new Error("capacity constant moved");
const pair = {
  onRuntimeContext: async (): Promise<never> => { throw new Error("unexpected callback"); },
  spawnClaudeCodeProcess: (): never => { throw new Error("unexpected spawn"); },
};
const refused = (call: () => unknown) => {
  try { call(); } catch (error) { if (error instanceof Error && error.message === "required_context_unavailable") return; throw error; }
  throw new Error("capacity refusal missing");
};
const issuer = claimGuidedGuestIssuer();
refused(() => claimGuidedGuestIssuer());

// Workspace counters: CAPACITY distinct workspaces fit, the next new one is refused, known ones keep advancing.
for (let i = 0; i < CAPACITY; i++) issuer.advance(`workspace-${i}`, "inc-1", 1);
refused(() => issuer.advance("workspace-overflow", "inc-1", 1));
issuer.advance("workspace-0", "inc-2", 2);
refused(() => issuer.advance("workspace-0", "inc-1", 1));
// forget() frees a counter slot (workspace-0 is not used below), and the table is full again afterwards.
issuer.forget("workspace-0");
issuer.advance("workspace-overflow", "inc-1", 1);
refused(() => issuer.advance("workspace-overflow-2", "inc-1", 1));

// Live ticket records: CAPACITY fit, the next is refused and leaves nothing behind.
const preparations = [];
for (let i = 0; i < CAPACITY; i++) {
  const preparation = prepareGuidedQuery(pair);
  issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-1", leaseEpoch: 1, preparation });
  preparations.push(preparation);
}
const overflow = prepareGuidedQuery(pair);
refused(() => issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-1", leaseEpoch: 1, preparation: overflow }));
refused(() => issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-1", leaseEpoch: 1, preparation: overflow }));
// The refused preparation was not consumed: it can take the slot a closed preparation frees.
closeGuidedQuery(preparations[0]!);
issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-1", leaseEpoch: 1, preparation: overflow });
refused(() => issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-1", leaseEpoch: 1, preparation: prepareGuidedQuery(pair) }));
// Advancing the workspace kills every live record, which frees every slot at once.
issuer.advance("workspace-1", "inc-2", 2);
for (let i = 0; i < 8; i++) issuer.mint({ workspaceKey: "workspace-1", incarnationId: "inc-2", leaseEpoch: 2, preparation: prepareGuidedQuery(pair) });

// Consumed correlation ids: CAPACITY of them fill the process-wide set and the next claim is refused (the cliff). When the
// generation they were consumed under dies, they leave the set, so the cliff is not permanent. advance, revoke and forget
// each do it; an id consumed with no ticket never leaves.
const argsFor = () => ["--run", "--config-json", JSON.stringify({ requiredRuntimeContext: { version: 1, bindingId: randomUUID() } })];
const fill = (workspaceKey: string, incarnationId: string, leaseEpoch: number, count: number) => {
  for (let i = 0; i < count; i++) {
    const preparation = prepareGuidedQuery(pair);
    issuer.mint({ workspaceKey, incarnationId, leaseEpoch, preparation });
    consumeGuidedQueryCorrelation(claimGuidedQuery(preparation, pair), argsFor());
    closeGuidedQuery(preparation);
  }
};
const claimable = () => { const preparation = prepareGuidedQuery(pair); try { claimGuidedQuery(preparation, pair); return true; } catch { return false; } };
const plain = prepareGuidedQuery(pair); consumeGuidedQueryCorrelation(claimGuidedQuery(plain, pair), argsFor()); closeGuidedQuery(plain); // Never evicted.
fill("workspace-2", "inc-1", 1, CAPACITY - 1);
if (claimable()) throw new Error("consumed-id cliff missing");
issuer.advance("workspace-2", "inc-2", 2);
if (!claimable()) throw new Error("advance did not free the consumed ids");
fill("workspace-2", "inc-2", 2, CAPACITY - 1); // The one unticketed id above is the only id left in the set.
if (claimable()) throw new Error("consumed-id cliff missing after advance");
issuer.revoke("workspace-2");
if (!claimable()) throw new Error("revoke did not free the consumed ids");
issuer.advance("workspace-2", "inc-3", 3);
fill("workspace-2", "inc-3", 3, CAPACITY - 1);
if (claimable()) throw new Error("consumed-id cliff missing after revoke");
issuer.forget("workspace-2");
if (!claimable()) throw new Error("forget did not free the consumed ids");
console.log(`guided-guest-ticket-capacity:${CAPACITY}`);
