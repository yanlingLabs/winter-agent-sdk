/** Routing only. The engine must obtain channel from the actual admission registry
 * before calling this helper. A supplied channel never establishes that authority. */
import { GUIDED_READER_SUBTYPE, type GuidedParentBridge } from "./guided-parent-bridge.ts";
export function dispatchGuidedParentControl(channel: GuidedParentBridge, frame: unknown, failure: () => void): boolean {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("required_context_unavailable");
  const type = Object.getOwnPropertyDescriptor(frame, "type");
  if (!type || !("value" in type)) throw new Error("required_context_unavailable");
  if (type.value === "control_response") { channel.handleResponse(frame); return true; }
  if (type.value === "control_request") {
    const subtype = Object.getOwnPropertyDescriptor(frame, "subtype");
    if (!subtype || !("value" in subtype)) throw new Error("required_context_unavailable");
    if (subtype.value === GUIDED_READER_SUBTYPE) {
      // Never await here: the same input pump must service the context response
      // and permission traffic while reader result/reap/drain remain pending.
      void channel.handleReaderRequest(frame).catch(failure); return true;
    }
  }
  return false;
}
