// WS-10 §3.5: fork semantics -- "a fork inherits EVERYTHING from the main session at spawn:
// conversation, system prompt, exact tool pool, model, permissions, prompt cache, thinking, and
// effective effort... never as a fresh AgentDefinition... ignores a model override by contract."
//
// Most of a fork's OWN inheritance is already implemented, correctly, by engine.ts's own
// `buildChildInheritance`/`resolveChildModel` (frozen, unreachable from this lane):
// `resolveChildModel` returns `config.model` unconditionally when `req.fork === true` ("fork ignores
// a model override by contract"), and `buildChildInheritance` spreads `messages: [...messages]` (a
// COPY, "never mutate the parent's own live turn history") only when `req.fork === true`, and
// resolves `tools` to the session's own CURRENT advertised pool for exactly this case (WS-10 §3.5's
// own "exact tool pool"). This file's own job is the CHILD side of that contract: consuming
// `ChildInheritance.messages` correctly when child-engine.ts seeds a new runEngine() invocation's
// own `initialMessages`.
//
// DISCLOSED SCOPE GAP: `AgentInput` (T1's own pinned 9-field schema, derived-shapes-p4.md item (d))
// has NO boolean/field that could ever set `SpawnChildRequest.fork` from the model-facing Agent
// tool. WS-10 nowhere names the product surface that actually triggers a fork -- its own §3.5
// describes ONLY the inheritance semantics, never an invocation path. In this phase, `fork: true` is
// therefore reachable only by a caller constructing a `SpawnChildRequest` directly (a future
// internal mechanism, e.g. an automatic "continue this turn in an isolated fork" product feature, or
// a test) -- never through tools/impl/agent.ts's own `AgentInput` parsing. Parked exactly like this
// codebase's own repeated "seam exists before its real consumer does" precedent (AutoEngine/
// HookStage at P1) rather than inventing a speculative trigger; recorded in this lane's own report.
import type { ProviderMessage } from "../engine.ts";
import type { ChildInheritance } from "./child-handle.ts";

// A COPY (never the same array reference `inherit.messages` itself holds) -- belt-and-suspenders on
// top of engine.ts's own already-copied array, since this function's own caller (child-engine.ts) is
// about to hand the result to a brand-new runEngine() invocation as ITS OWN mutable turn history:
// nothing should ever let two engine instances share one mutable array.
export function resolveForkInitialMessages(inherit: Pick<ChildInheritance, "messages">): ProviderMessage[] {
  return inherit.messages !== undefined ? [...inherit.messages] : [];
}

export function isForkRequest(req: { fork?: true }): boolean {
  return req.fork === true;
}
