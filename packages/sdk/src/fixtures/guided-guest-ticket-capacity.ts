// Inert unit-test subprocess. Imports the actual modules, never query/runtime/native code. Claims its own issuer in
// its own module realm, so the parent test process's one claim is untouched.
import { prepareGuidedQuery, closeGuidedQuery, GUIDED_QUERY_CORRELATION_CAPACITY } from "../guided-query-preparation.ts";
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
console.log(`guided-guest-ticket-capacity:${CAPACITY}`);
