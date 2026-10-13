import type { ProviderRequest } from "../engine.ts";
import { neutralizeReminderTags } from "./injection.ts";
import { renderUserContext, type ContextEntry } from "./request-layout.ts";

export const REQUIRED_CONTEXT_MAX_BYTES = 128 * 1024;
export interface RequiredContextRequest {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly cwd: string;
  readonly purpose: "generation" | "compaction";
  readonly attempt: number;
}
/** Host facts/publication and editable guidance are distinct text, never executable config.
 * The revision is diagnostic provenance, not authority or a permission token. */
export interface RequiredContextSnapshot {
  readonly revision: string;
  readonly facts: string;
  readonly instructions: string;
}
/** Trusted dependency only; not serialized in RuntimeConfig or a child execution snapshot.
 * The resolver owns the complete applicable instruction layer, including user guidance
 * and any memory index. The engine suppresses the legacy cached claudeMd value when opted in.
 * Rebind from current authority after restart; a product requiring this must refuse
 * admission if the dependency is absent. This does not admit guest children or any RPC. */
export interface RequiredContextSource {
  resolve(request: Readonly<RequiredContextRequest>, options: { signal: AbortSignal }): Promise<RequiredContextSnapshot>;
  /** A bounded host wait; default 15 s, at most 30 s. */
  timeoutMs?: number;
}
export class RequiredContextError extends Error {
  constructor(readonly code: "required_context_unavailable" | "required_context_timed_out" | "required_context_cancelled") {
    super(code); this.name = "RequiredContextError";
  }
}

/** One immutable, bounded current snapshot per actual dispatch. No cached fallback. */
export async function resolveRequiredContext(source: RequiredContextSource, request: RequiredContextRequest, signal?: AbortSignal): Promise<Readonly<RequiredContextSnapshot>> {
  const timeout = source.timeoutMs ?? 15_000;
  if (typeof source.resolve !== "function" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new RequiredContextError("required_context_unavailable");
  if (signal?.aborted) throw new RequiredContextError("required_context_cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, rejectWait!: (error: RequiredContextError) => void;
  const refused = new Promise<never>((_, reject) => { rejectWait = reject; });
  const abort = (): void => { controller.abort(); rejectWait(new RequiredContextError("required_context_cancelled")); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    timer = setTimeout(() => { controller.abort(); rejectWait(new RequiredContextError("required_context_timed_out")); }, timeout);
    // Promise scheduling also catches a synchronously throwing host implementation.
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new RequiredContextError("required_context_cancelled");
      return Promise.resolve(source.resolve(Object.freeze({ ...request }), { signal: controller.signal })).catch(() => {
        throw new RequiredContextError("required_context_unavailable");
      });
    });
    const value = await Promise.race([pending, refused]);
    if (controller.signal.aborted) throw new RequiredContextError("required_context_cancelled");
    if (!value || typeof value !== "object" || Reflect.ownKeys(value).some(key => typeof key !== "string")
      || Reflect.ownKeys(value).sort().join(",") !== "facts,instructions,revision") throw new RequiredContextError("required_context_unavailable");
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Object.values(properties).some(property => !("value" in property))) throw new RequiredContextError("required_context_unavailable");
    const revision: unknown = properties.revision!.value, facts: unknown = properties.facts!.value, instructions: unknown = properties.instructions!.value;
    if (typeof revision !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(revision)
      || typeof facts !== "string" || typeof instructions !== "string"
      || Buffer.byteLength(facts, "utf8") + Buffer.byteLength(instructions, "utf8") > REQUIRED_CONTEXT_MAX_BYTES) throw new RequiredContextError("required_context_unavailable");
    return Object.freeze({ revision, facts, instructions });
  } catch (error) {
    if (error instanceof RequiredContextError && ["required_context_unavailable", "required_context_timed_out", "required_context_cancelled"].includes(error.code)) throw new RequiredContextError(error.code);
    // Host errors can contain protected paths or credentials. Never forward their text.
    throw new RequiredContextError("required_context_unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function requiredContextEntries(base: readonly ContextEntry[], snapshot: Readonly<RequiredContextSnapshot>): ContextEntry[] {
  return [["claudeMd", neutralizeReminderTags(snapshot.instructions)], ...base.filter(([key]) => key !== "claudeMd")];
}

/** Host facts only. Main dispatch renders current guidance with its base user context
 * in the engine's ONE request-messages pass. Never persist/capture the live layer. */
export function applyRequiredContext(base: ProviderRequest, snapshot: Readonly<RequiredContextSnapshot>): ProviderRequest {
  const text = `# Current workspace context\n${neutralizeReminderTags(snapshot.facts)}`;
  const instructions = renderUserContext(requiredContextEntries([], snapshot));
  if (Buffer.byteLength(text, "utf8") + Buffer.byteLength(instructions ?? "", "utf8") > REQUIRED_CONTEXT_MAX_BYTES) throw new RequiredContextError("required_context_unavailable");
  return { ...base, system: [base.system, text].filter(Boolean).join("\n\n"),
    ...(base.systemBlocks !== undefined ? { systemBlocks: [...base.systemBlocks, { text, cacheScope: "org" as const }] } : {}),
  };
}

/** A controller may already have rendered/redacted its request. Insert only a
 * current meta reminder, preserving its effort markers, attachments and tool epochs. */
export function applyRequiredCompactionContext(base: ProviderRequest, snapshot: Readonly<RequiredContextSnapshot>): ProviderRequest {
  const request = applyRequiredContext(base, snapshot), messages = [...base.messages];
  let position = 0;
  while (position < messages.length && messages[position]!.role === "system"
    && Array.isArray(messages[position]!.content) && messages[position]!.content.length === 0
    && messages[position]!.outputConfig !== undefined) position++;
  messages.splice(position, 0, { role: "user", content: renderUserContext(requiredContextEntries([], snapshot))!, isMeta: true });
  return { ...request, messages };
}
