import { RUNTIME_CONTEXT_SUBTYPE, parseRuntimeContextConfig, parseRuntimeContextRequest, parseRuntimeContextSnapshot,
  type RuntimeContextConfig } from "@yanlinglabs/winter-agent-sdk";
import type { RpcBridge } from "../rpc/bridge.ts";
import { RequiredContextError, type RequiredContextSource } from "./required-context.ts";

/** One parent-owned bridge, shared through the assembler with every child.
 * No deferred or cached snapshot; an unbound/disconnected transport fails closed. */
export interface RuntimeContextChannel extends RequiredContextSource { readonly bindingId: string; bind(bridge: RpcBridge): void; close(): void; }
export function createRuntimeContextChannel(config: RuntimeContextConfig): RuntimeContextChannel {
  const binding = parseRuntimeContextConfig(config);
  let sender: RpcBridge | undefined;
  let bound = false, closed = false;
  const pending = new Set<AbortController>();
  const channel: RuntimeContextChannel = {
    bindingId: binding.bindingId,
    bind(bridge) {
      if (bound || closed) throw new RequiredContextError("required_context_unavailable");
      bound = true; sender = bridge;
    },
    close() { closed = true; sender = undefined; for (const controller of pending) controller.abort(); },
    async resolve(request, { signal }) {
      if (signal.aborted) throw new RequiredContextError("required_context_cancelled");
      if (sender === undefined) throw new RequiredContextError("required_context_unavailable");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      pending.add(controller);
      try {
        const payload = parseRuntimeContextRequest({ ...request, bindingId: binding.bindingId });
        const value = await sender.request(RUNTIME_CONTEXT_SUBTYPE, payload, { signal: controller.signal });
        if (controller.signal.aborted || closed) throw new RequiredContextError("required_context_cancelled");
        return parseRuntimeContextSnapshot(value);
      } catch {
        throw new RequiredContextError(controller.signal.aborted ? "required_context_cancelled" : "required_context_unavailable");
      } finally { pending.delete(controller); signal.removeEventListener("abort", abort); }
    },
  };
  return Object.freeze(channel);
}
