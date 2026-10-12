import { realpathSync } from "node:fs";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";

type LeaseOptions = NonNullable<ConstructorParameters<typeof WinterCompatibilitySessionStore>[0]["leaseIdentity"]>;
type ProcessIdentity = NonNullable<ReturnType<NonNullable<LeaseOptions["identityProbe"]>>>;

/** Host-owned facts, not RuntimeConfig, environment variables or a guest/model message. */
export interface ProtectedStoreScope {
  workspaceId: string;
  sessionId: string;
  incarnationId: string;
  leaseEpoch: number;
  storeHome: string;
  currentBootId: string;
}
export interface PreviousBootTerminationEvidence {
  scope: Readonly<ProtectedStoreScope>;
  ownerToken: string;
  previousBootId: string;
}
export interface StoreLifetimeTeardownEvidence {
  scope: Readonly<ProtectedStoreScope>;
  ownerToken: string;
  outcome: "confirmed-stopped" | "uncertain";
}
export interface ProtectedStoreOwnershipOutcome {
  status: "released" | "retained" | "release-failed" | "not-acquired";
  reason: "completed" | "not-requested" | "startup-refused" | "acquisition-failed" | "bootstrap-invalid" | "scope-mismatch" | "teardown-uncertain" | "teardown-unconfirmed" | "teardown-proof-invalid" | "teardown-proof-failed" | "durable-operations-pending" | "native-release-failed";
  scope: Readonly<ProtectedStoreScope> | null;
}
/** Trusted native adapter contract. No production adapter ships in this slice.
 * acquire must exclude other processes/realms for this conversation and bind the actual
 * store directory identity. A JS map, PID check or expired heartbeat is insufficient.
 * Evidence means independently established previous guest termination + exclusive tenancy;
 * a boot mismatch is never itself evidence. Adapter methods may throw to fail closed. */
export interface ProtectedStoreOwnershipPort {
  acquire(scope: Readonly<ProtectedStoreScope>): Promise<ProtectedStoreOwner>;
}
export interface ProtectedStoreOwner {
  scope: Readonly<ProtectedStoreScope>;
  ownerToken: string;
  signal: AbortSignal;
  assertHeld(): void;
  processIdentity(pid: number): ProcessIdentity | null;
  previousBootTermination(bootId: string): PreviousBootTerminationEvidence | null;
  /** Native bounded shutdown/namespace reconciliation owns this acknowledgement. Runtime return
   * alone does not establish OS process termination. Missing/uncertain evidence retains the hold. */
  runtimeTeardownEvidence(): StoreLifetimeTeardownEvidence | null;
  /** Release only after runtime and all descendant teardown has actually returned. */
  release(): Promise<void>;
}
export class ProtectedStoreBootstrapError extends Error {
  constructor(readonly code: "native_owner_unavailable" | "bootstrap_invalid" | "bootstrap_in_use" | "scope_mismatch" | "owner_lost") {
    super(`protected runtime store bootstrap refused: ${code}`);
    this.name = "ProtectedStoreBootstrapError";
  }
}
declare const bootstrapBrand: unique symbol;
export interface ProtectedStoreBootstrap { readonly [bootstrapBrand]: true }
declare const openedBrand: unique symbol;
export interface OpenedProtectedStoreBootstrap { readonly [openedBrand]: true }
const bootstraps = new WeakMap<ProtectedStoreBootstrap, { scope: Readonly<ProtectedStoreScope>; port: ProtectedStoreOwnershipPort; opening: boolean }>();
const opened = new WeakMap<OpenedProtectedStoreBootstrap, { scope: Readonly<ProtectedStoreScope>; owner: ProtectedStoreOwner; phase: "open" | "closing" | "released" | "release-failed"; inFlight: number }>();
const acquisitionFailures = new WeakMap<object, ProtectedStoreOwnershipOutcome>();
const bootPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sameScope = (a: Readonly<ProtectedStoreScope>, b: Readonly<ProtectedStoreScope>): boolean =>
  !!b && ["workspaceId", "sessionId", "incarnationId", "leaseEpoch", "storeHome", "currentBootId"].every(key => a[key as keyof ProtectedStoreScope] === b[key as keyof ProtectedStoreScope]);

/** Trusted supervisor injection only. Structured clones/JSON lose this realm's capability.
 * Supplying an adapter is a trusted-code responsibility, not proof this SDK verified an OS lock. */
export function createProtectedStoreBootstrap(scope: ProtectedStoreScope, port?: ProtectedStoreOwnershipPort): ProtectedStoreBootstrap {
  if (!port) throw new ProtectedStoreBootstrapError("native_owner_unavailable");
  if (![scope.workspaceId, scope.sessionId, scope.incarnationId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) ||
      !Number.isSafeInteger(scope.leaseEpoch) || scope.leaseEpoch < 1 || !bootPattern.test(scope.currentBootId)) throw new ProtectedStoreBootstrapError("scope_mismatch");
  const canonical = realpathSync(scope.storeHome);
  if (canonical !== scope.storeHome) throw new ProtectedStoreBootstrapError("scope_mismatch");
  const capability = Object.freeze({}) as ProtectedStoreBootstrap;
  bootstraps.set(capability, { scope: Object.freeze({ ...scope }), port, opening: false });
  return capability;
}

function stateOf(capability: OpenedProtectedStoreBootstrap) {
  const state = opened.get(capability);
  if (!state) throw new ProtectedStoreBootstrapError("bootstrap_invalid");
  if (state.phase !== "open" || state.owner.signal.aborted) throw new ProtectedStoreBootstrapError("owner_lost");
  state.owner.assertHeld();
  if (!sameScope(state.scope, state.owner.scope)) throw new ProtectedStoreBootstrapError("scope_mismatch");
  const identity = state.owner.processIdentity(process.pid);
  if (!identity || identity.bootId !== state.scope.currentBootId) throw new ProtectedStoreBootstrapError("scope_mismatch");
  return state;
}

export async function acquireProtectedStoreBootstrap(capability: ProtectedStoreBootstrap, config: RuntimeConfig, storeHome: string): Promise<OpenedProtectedStoreBootstrap> {
  const bootstrap = bootstraps.get(capability);
  if (!bootstrap) throw new ProtectedStoreBootstrapError("bootstrap_invalid");
  const scope = bootstrap.scope;
  // Explicit identity only: continue/fork could select or mint an unrelated conversation.
  if (config.persistSession === false || config.sessionId !== scope.sessionId || config.continue === true || config.forkSession === true ||
      (config.resume !== undefined && config.resume !== scope.sessionId) || realpathSync(storeHome) !== scope.storeHome) throw new ProtectedStoreBootstrapError("scope_mismatch");
  if (bootstrap.opening) throw new ProtectedStoreBootstrapError("bootstrap_in_use");
  // This is capability lifetime hygiene, NOT the cross-process exclusion required of the port.
  bootstrap.opening = true;
  let owner: ProtectedStoreOwner | undefined;
  try {
    owner = await bootstrap.port.acquire(scope);
    if (!owner.ownerToken || !sameScope(scope, owner.scope)) throw new ProtectedStoreBootstrapError("scope_mismatch");
    const acquired = Object.freeze({}) as OpenedProtectedStoreBootstrap;
    opened.set(acquired, { scope, owner, phase: "open", inFlight: 0 });
    stateOf(acquired);
    return acquired;
  } catch (error) {
    // No runtime has started. A successfully returned hold belongs to us even if its evidence
    // was malformed; its trusted adapter must release its own hold, never an unrelated owner's.
    if (owner) {
      try { await owner.release(); }
      catch {
        const failure = new ProtectedStoreBootstrapError("owner_lost");
        acquisitionFailures.set(failure, Object.freeze({ status: "release-failed", reason: "native-release-failed", scope }));
        throw failure; // retain opening latch: failed release is not a reusable capability
      }
    }
    bootstrap.opening = false;
    throw error;
  }
}

export function protectedStoreStartupOutcome(capability: ProtectedStoreBootstrap, error: unknown): ProtectedStoreOwnershipOutcome {
  if (typeof error === "object" && error !== null) {
    const failed = acquisitionFailures.get(error); if (failed) return failed;
  }
  const scope = bootstraps.get(capability)?.scope ?? null;
  const reason = error instanceof ProtectedStoreBootstrapError && error.code === "bootstrap_invalid" ? "bootstrap-invalid"
    : error instanceof ProtectedStoreBootstrapError && error.code === "scope_mismatch" ? "scope-mismatch" : "startup-refused";
  return Object.freeze({ status: "not-acquired", reason, scope });
}

export function protectedStoreOwnerSignal(capability: OpenedProtectedStoreBootstrap): AbortSignal { return stateOf(capability).owner.signal; }
export function assertProtectedStoreConfig(capability: OpenedProtectedStoreBootstrap, config: RuntimeConfig): void {
  const { scope } = stateOf(capability);
  if (config.persistSession === false || config.sessionId !== scope.sessionId || config.continue === true || config.forkSession === true ||
      (config.resume !== undefined && config.resume !== scope.sessionId)) throw new ProtectedStoreBootstrapError("scope_mismatch");
}
export function createProtectedRuntimeStore(capability: OpenedProtectedStoreBootstrap, storeHome: string): WinterCompatibilitySessionStore {
  const state = stateOf(capability);
  if (realpathSync(storeHome) !== state.scope.storeHome) throw new ProtectedStoreBootstrapError("scope_mismatch");
  const assertAccess = (sessionId?: string): void => {
    const live = stateOf(capability);
    if (sessionId !== undefined && sessionId !== live.scope.sessionId) throw new ProtectedStoreBootstrapError("scope_mismatch");
  };
  return new WinterCompatibilitySessionStore({
    winterHome: state.scope.storeHome,
    sessionAuthority: {
      sessionId: state.scope.sessionId, assertAccess,
      runOperation<T>(sessionId: string, operation: () => T): T {
        assertAccess(sessionId);
        state.inFlight++;
        try {
          const result = operation();
          if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
            return Promise.resolve(result).finally(() => { state.inFlight--; }) as T;
          }
          state.inFlight--; return result;
        } catch (error) { state.inFlight--; throw error; }
      },
    },
    leaseIdentity: {
      identityProbe: pid => { assertAccess(); return state.owner.processIdentity(pid); },
      confirmPreviousBootTerminated: (lease, current) => {
        assertAccess();
        const previousBoot = lease.processIdentity?.bootId;
        if (!previousBoot || current.bootId !== state.scope.currentBootId) return false;
        const evidence = state.owner.previousBootTermination(previousBoot);
        return evidence !== null && typeof evidence === "object" && sameScope(state.scope, evidence.scope) &&
          evidence.ownerToken === state.owner.ownerToken && evidence.previousBootId === previousBoot;
      },
      // Legacy unidentified leases require a separate native recovery protocol, not a guess.
    },
  });
}

/** Caller must have confirmed teardown; there is deliberately no timeout-based release. */
export function retainProtectedStoreBootstrap(capability: OpenedProtectedStoreBootstrap, reason: ProtectedStoreOwnershipOutcome["reason"]): ProtectedStoreOwnershipOutcome {
  const state = opened.get(capability);
  if (!state) throw new ProtectedStoreBootstrapError("bootstrap_invalid");
  if (state.phase === "open") state.phase = "closing"; // revoke new durable admission even while native hold is retained
  return Object.freeze({ status: "retained", reason, scope: state.scope });
}
export async function releaseProtectedStoreBootstrap(capability: OpenedProtectedStoreBootstrap): Promise<ProtectedStoreOwnershipOutcome> {
  const state = opened.get(capability);
  if (!state) throw new ProtectedStoreBootstrapError("bootstrap_invalid");
  if (state.phase === "released") return Object.freeze({ status: "released", reason: "completed", scope: state.scope });
  if (state.phase === "release-failed") return Object.freeze({ status: "release-failed", reason: "native-release-failed", scope: state.scope });
  retainProtectedStoreBootstrap(capability, "teardown-unconfirmed");
  if (state.inFlight > 0) return retainProtectedStoreBootstrap(capability, "durable-operations-pending");
  let evidence: StoreLifetimeTeardownEvidence | null;
  try {
    evidence = state.owner.runtimeTeardownEvidence();
    if (!evidence || evidence.outcome === "uncertain") return retainProtectedStoreBootstrap(capability, "teardown-unconfirmed");
    if (evidence.outcome !== "confirmed-stopped" || !sameScope(state.scope, evidence.scope) || evidence.ownerToken !== state.owner.ownerToken) return retainProtectedStoreBootstrap(capability, "teardown-proof-invalid");
  }
  catch { return retainProtectedStoreBootstrap(capability, "teardown-proof-failed"); }
  // Invalidate stores before awaiting release. A failed release retains the native hold/recovery
  // obligation; this capability never becomes reusable, even after a normal completed lifetime.
  state.phase = "release-failed"; // pending/failed release is never reported as success
  try { await state.owner.release(); }
  catch { return Object.freeze({ status: "release-failed", reason: "native-release-failed", scope: state.scope }); }
  state.phase = "released";
  return Object.freeze({ status: "released", reason: "completed", scope: state.scope });
}
