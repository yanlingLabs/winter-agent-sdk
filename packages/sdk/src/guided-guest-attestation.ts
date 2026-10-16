/** Guest tickets for guided queries: a private "this launch is mine" statement that only the owning host can
 * mint, that works once, and that dies by CANONICAL COUNTERS (never a clock).
 *
 * DORMANT. No SDK production path claims the issuer or mints a ticket; `query()` only spends one. The issuer
 * is reachable through exactly one package export, `claimGuidedGuestIssuer`, and can be claimed once per
 * module instance. A ticket is lifecycle/correlation state bound to one workspace generation and one
 * preparation. It is NOT native admission, kernel evidence or filesystem authority: the owner slot, the
 * runtime and the guest entry still enforce those. See docs/guided-guest-attestation.md. */
import { bindGuidedGuestGuard, closeGuidedQuery, GUIDED_QUERY_CORRELATION_CAPACITY, type GuidedQueryPreparation } from "./guided-query-preparation.ts";

declare const ticketBrand: unique symbol;
/** Opaque. Created only by `GuidedGuestIssuer.mint`; copies, spreads, clones, proxies and JSON are not tickets. */
export interface GuidedGuestTicket { readonly [ticketBrand]: true; }
export interface GuidedGuestMintRequest {
  /** The host's canonical workspace identity (same text shape as a Winter workspace id). */
  readonly workspaceKey: string;
  /** The canonical incarnation identity. An identity, not an order: the order is `leaseEpoch`. */
  readonly incarnationId: string;
  /** The canonical monotonic lease epoch (a positive safe integer). */
  readonly leaseEpoch: number;
  readonly preparation: GuidedQueryPreparation;
}
export interface GuidedGuestIssuer {
  /** Mints one ticket bound to the workspace's CURRENT generation and ONE still-prepared preparation. */
  mint(request: GuidedGuestMintRequest): GuidedGuestTicket;
  /** Moves a workspace's generation forward. A strictly higher `leaseEpoch` kills every older unspent ticket and
   * tears down every running query bound to an older generation. The same pair again is a no-op; a lower
   * epoch, or the same epoch with another incarnation, is refused and nothing is applied. */
  advance(workspaceKey: string, incarnationId: string, leaseEpoch: number): void;
}

type TicketState = "minted" | "spent" | "dead";
interface TicketRecord {
  readonly workspaceKey: string;
  readonly incarnationId: string;
  readonly leaseEpoch: number;
  readonly preparation: GuidedQueryPreparation;
  state: TicketState;
  /** Set when query() spends the ticket: closes the query and requests the existing TERM/KILL-grace teardown. */
  onRevoked?: () => void;
}
interface Generation { readonly incarnationId: string; readonly leaseEpoch: number; }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const fail = (): never => { throw new Error("required_context_unavailable"); };

let claimed = false;
const tickets = new WeakMap<GuidedGuestTicket, TicketRecord>();
/** Per-workspace current generation. Entries are never deleted: a counter that could be forgotten could regress. */
const generations = new Map<string, Generation>();
/** Unspent and running records only. Strong references, removed when the preparation closes or the generation dies. */
const live = new Set<TicketRecord>();

function opaque<T>(): T {
  return Object.freeze(Object.defineProperty(Object.create(null), "toJSON", { value: fail, enumerable: false })) as T;
}
function identity(value: unknown): string { return typeof value === "string" && ID.test(value) ? value : fail(); }
function epoch(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fail(); }
/** Own data properties only, exact key set, plain object: no accessor or Proxy trap of caller text ever runs. */
function closedRequest(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = ["workspaceKey", "incarnationId", "leaseEpoch", "preparation"];
    if (Reflect.ownKeys(descriptors).length !== expected.length) return fail();
    const result: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch { return fail(); }
}
function isCurrent(record: TicketRecord): boolean {
  if (record.state === "dead") return false;
  const current = generations.get(record.workspaceKey);
  return current !== undefined && current.incarnationId === record.incarnationId && current.leaseEpoch === record.leaseEpoch;
}
/** Terminal and idempotent. The state flips first, so a reentrant step of this query already fails. `notify`
 * runs the running query's own teardown (a revocation); a query that is already failing tears itself down. */
function kill(record: TicketRecord, notify: boolean): void {
  record.state = "dead";
  live.delete(record);
  const revoked = record.onRevoked;
  delete record.onRevoked;
  if (notify) { try { revoked?.(); } catch { /* Revocation continues for every other record. */ } }
  try { closeGuidedQuery(record.preparation); } catch { /* Closing remains terminal. */ }
}

function mint(input: GuidedGuestMintRequest): GuidedGuestTicket {
  const request = closedRequest(input);
  const workspaceKey = identity(request.workspaceKey), incarnationId = identity(request.incarnationId), leaseEpoch = epoch(request.leaseEpoch);
  const preparation = request.preparation as GuidedQueryPreparation;
  const current = generations.get(workspaceKey);
  // The workspace must have announced this exact generation through advance(); mint never moves a counter.
  if (current === undefined || current.incarnationId !== incarnationId || current.leaseEpoch !== leaseEpoch) return fail();
  if (live.size >= GUIDED_QUERY_CORRELATION_CAPACITY) return fail();
  const record: TicketRecord = { workspaceKey, incarnationId, leaseEpoch, preparation, state: "minted" };
  // One guard per preparation, ever; a forged, claimed or closed preparation is refused here.
  bindGuidedGuestGuard(preparation, {
    current: () => isCurrent(record),
    release: () => { record.state = "dead"; live.delete(record); },
  });
  live.add(record);
  const ticket = opaque<GuidedGuestTicket>();
  tickets.set(ticket, record);
  return ticket;
}

function advance(workspaceKey: unknown, incarnationId: unknown, leaseEpoch: unknown): void {
  const key = identity(workspaceKey), incarnation = identity(incarnationId), next = epoch(leaseEpoch);
  const current = generations.get(key);
  if (current === undefined) {
    if (generations.size >= GUIDED_QUERY_CORRELATION_CAPACITY) return fail();
    generations.set(key, Object.freeze({ incarnationId: incarnation, leaseEpoch: next }));
    return;
  }
  if (next < current.leaseEpoch) return fail();
  if (next === current.leaseEpoch) {
    if (incarnation !== current.incarnationId) return fail();
    return;
  }
  // Install the new generation BEFORE any teardown callback runs: a reentrant step of a sibling query that is
  // still waiting for its own turn in the loop below already fails its generation check.
  generations.set(key, Object.freeze({ incarnationId: incarnation, leaseEpoch: next }));
  for (const record of [...live]) if (record.workspaceKey === key) kill(record, true);
}

/** The one documented export. Claimable once per module instance (one per JS realm): the owning host calls it at
 * boot and keeps the result private; every later call throws. An in-process capability, not a defence against
 * code that runs before the host: see docs/guided-guest-attestation.md. */
export function claimGuidedGuestIssuer(): GuidedGuestIssuer {
  if (claimed) return fail();
  claimed = true;
  return Object.freeze({ mint, advance });
}

/** query()-internal; never exported from the package. Spends the ticket atomically: after ANY presentation of a
 * genuine ticket, whether or not the checks pass, it can never work again. `onRevoked` runs if the generation
 * dies while the query is running. Throws `required_context_unavailable` on every failure. */
export function spendGuidedGuestTicket(ticket: unknown, preparation: GuidedQueryPreparation, onRevoked: () => void): void {
  const record = typeof ticket === "object" && ticket !== null ? tickets.get(ticket as GuidedGuestTicket) : undefined;
  if (record === undefined || record.state !== "minted") return fail();
  record.state = "spent";
  if (record.preparation !== preparation || !isCurrent(record)) { kill(record, false); return fail(); }
  record.onRevoked = onRevoked;
}
/** query()-internal: a presented ticket whose query() failed or was refused is dead, whichever check failed. An
 * unspent ticket always dies; a spent one only when THIS query() call spent it (`spentHere`), so replaying a ticket
 * that another running query spent never disturbs that query. A value that is not a genuine ticket is ignored. */
export function retireGuidedGuestTicket(ticket: unknown, spentHere: boolean): void {
  const record = typeof ticket === "object" && ticket !== null ? tickets.get(ticket as GuidedGuestTicket) : undefined;
  if (record !== undefined && (record.state === "minted" || (spentHere && record.state === "spent"))) kill(record, false);
}
