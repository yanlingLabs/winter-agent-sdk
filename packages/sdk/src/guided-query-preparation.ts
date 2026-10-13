import type { RuntimeContextHandler } from "./runtime-context.ts";
import { RUNTIME_CONTEXT_VERSION } from "./runtime-context.ts";
import type { SpawnClaudeCodeProcess } from "./transport.ts";

/** Preparation is lifecycle/correlation state only, never native admission. */
declare const preparationBrand: unique symbol;
declare const claimBrand: unique symbol;
export interface GuidedQueryPreparation { readonly [preparationBrand]: true; }
export interface GuidedQueryClaim { readonly [claimBrand]: true; }
export interface GuidedQueryCallbacks {
  readonly onRuntimeContext: RuntimeContextHandler;
  readonly spawnClaudeCodeProcess: SpawnClaudeCodeProcess;
}
export interface GuidedQueryCorrelation { readonly version: 1; readonly bindingId: string; }
export const GUIDED_QUERY_CONFIG_MAX_BYTES = 64 * 1024;
/** Unwired prerequisite only: production needs a reviewed owner-generation expiry protocol. */
export const GUIDED_QUERY_CORRELATION_CAPACITY = 4096;
const consumedBindings = new Set<string>();

type State = "prepared" | "claimed" | "correlated" | "closed";
interface PreparationRecord {
  state: State;
  onRuntimeContext: RuntimeContextHandler | undefined;
  spawnClaudeCodeProcess: SpawnClaudeCodeProcess | undefined;
  correlation?: Readonly<GuidedQueryCorrelation>;
}
const preparations = new WeakMap<GuidedQueryPreparation, PreparationRecord>();
const claims = new WeakMap<GuidedQueryClaim, GuidedQueryPreparation>();
const fail = (): never => { throw new Error("required_context_unavailable"); };
function opaque<T>(): T {
  return Object.freeze(Object.defineProperty(Object.create(null), "toJSON", {
    value: fail, enumerable: false,
  })) as T;
}
function callbacks(value: GuidedQueryCallbacks): GuidedQueryCallbacks {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !Object.hasOwn(descriptors, "onRuntimeContext")
      || !Object.hasOwn(descriptors, "spawnClaudeCodeProcess")) return fail();
    const callback = descriptors.onRuntimeContext!, spawn = descriptors.spawnClaudeCodeProcess!;
    if (!("value" in callback) || !("value" in spawn)
      || typeof callback.value !== "function" || typeof spawn.value !== "function") return fail();
    return { onRuntimeContext: callback.value, spawnClaudeCodeProcess: spawn.value };
  } catch { return fail(); }
}
function record(value: GuidedQueryPreparation): PreparationRecord {
  const result = preparations.get(value);
  if (result === undefined) return fail();
  return result;
}
function closeRecord(value: PreparationRecord): void {
  value.state = "closed";
  value.onRuntimeContext = undefined;
  value.spawnClaudeCodeProcess = undefined;
  delete value.correlation;
}

/** Stores the exact functions without calling them. Does not grant query/runtime access. */
export function prepareGuidedQuery(value: GuidedQueryCallbacks): GuidedQueryPreparation {
  const pair = callbacks(value), token = opaque<GuidedQueryPreparation>();
  preparations.set(token, { state: "prepared", ...pair });
  return token;
}
/** One query may claim this preparation; its callback and spawn hook must be the same objects. */
export function claimGuidedQuery(preparation: GuidedQueryPreparation, value: GuidedQueryCallbacks): GuidedQueryClaim {
  const current = record(preparation), pair = callbacks(value);
  if (current.state !== "prepared" || current.onRuntimeContext !== pair.onRuntimeContext
    || current.spawnClaudeCodeProcess !== pair.spawnClaudeCodeProcess) return fail();
  if (consumedBindings.size >= GUIDED_QUERY_CORRELATION_CAPACITY) {
    closeRecord(current); return fail();
  }
  const claim = opaque<GuidedQueryClaim>();
  current.state = "claimed";
  claims.set(claim, preparation);
  return claim;
}

function correlation(args: readonly string[]): Readonly<GuidedQueryCorrelation> {
  // Check length and data descriptors before enumerating an external array.
  if (!Array.isArray(args)) return fail();
  const length = Object.getOwnPropertyDescriptor(args, "length");
  if (length?.value !== 3) return fail();
  const fields = Object.getOwnPropertyDescriptors(args);
  if (Reflect.ownKeys(fields).length !== 4
    || ["0", "1", "2"].some(key => !Object.hasOwn(fields, key) || !("value" in fields[key]!))) return fail();
  if (fields["0"]!.value !== "--run" || fields["1"]!.value !== "--config-json") return fail();
  const raw: unknown = fields["2"]!.value;
  if (typeof raw !== "string" || raw.length > GUIDED_QUERY_CONFIG_MAX_BYTES
    || Buffer.byteLength(raw, "utf8") > GUIDED_QUERY_CONFIG_MAX_BYTES) return fail();
  const config: unknown = JSON.parse(raw);
  // query() emits JSON.stringify(config). Exact round-trip rejects duplicate keys,
  // ambiguous encodings and trailing whitespace without another JSON parser.
  if (config === null || typeof config !== "object" || Array.isArray(config)
    || Object.getPrototypeOf(config) !== Object.prototype || JSON.stringify(config) !== raw) return fail();
  const field = Object.getOwnPropertyDescriptor(config, "requiredRuntimeContext");
  if (!field || !("value" in field)) return fail();
  const value: unknown = field.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const context = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(context).length !== 2 || !Object.hasOwn(context, "version")
    || !Object.hasOwn(context, "bindingId") || !("value" in context.version!)
    || !("value" in context.bindingId!)) return fail();
  const bindingId: unknown = context.bindingId!.value;
  if (context.version!.value !== RUNTIME_CONTEXT_VERSION || typeof bindingId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bindingId)) return fail();
  return Object.freeze({ version: RUNTIME_CONTEXT_VERSION, bindingId });
}

/** Consume only supported correlation. All other config values are discarded, never authority.
 * A malformed attempt permanently closes its preparation; no retry can repurpose it. */
export function consumeGuidedQueryCorrelation(claim: GuidedQueryClaim, args: readonly string[]): Readonly<GuidedQueryCorrelation> {
  const preparation = claims.get(claim);
  if (preparation === undefined) return fail();
  const current = record(preparation);
  if (current.state !== "claimed") return fail();
  try {
    const result = correlation(args);
    if (consumedBindings.has(result.bindingId) || consumedBindings.size >= GUIDED_QUERY_CORRELATION_CAPACITY) return fail();
    consumedBindings.add(result.bindingId);
    current.state = "correlated";
    current.correlation = result;
    return result;
  } catch {
    closeRecord(current);
    return fail();
  }
}
/** Correlation/liveness check only; never an authenticated native capability. */
export function assertGuidedQueryCorrelation(claim: GuidedQueryClaim, expected: Readonly<GuidedQueryCorrelation>): void {
  const preparation = claims.get(claim);
  if (preparation === undefined) return fail();
  const current = record(preparation);
  if (current.state !== "correlated" || current.correlation?.version !== expected.version
    || current.correlation.bindingId !== expected.bindingId) return fail();
}
/** Future owning query teardown must call this on abort/exit/abandonment. No process is launched here. */
export function closeGuidedQuery(preparation: GuidedQueryPreparation): void { closeRecord(record(preparation)); }
