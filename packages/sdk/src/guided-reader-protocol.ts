/** Private correlation DTOs only. Root/admitted guest enforce actual read scope. */
export const GUIDED_READER_SUBTYPE = "instruction_reader";
export const GUIDED_READER_FRAME_BYTES = 1024 * 1024;
export interface GuidedInstructionRequest { readonly version: 1; readonly bindingId: string; readonly contextRequestId: string; readonly readId: string; }
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("required_context_unavailable");
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== names.length || names.some(name => !Object.hasOwn(properties, name))
    || Reflect.ownKeys(properties).some(name => typeof name !== "string" || !names.includes(name))
    || Object.values(properties).some(property => !("value" in property))) throw new Error("required_context_unavailable");
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, property.value]));
}
export function parseGuidedInstructionResponse(value: unknown, request: GuidedInstructionRequest): string {
  try {
    const frame = fields(value, ["type", "requestId", "ok", "payload"]);
    if (frame.type !== "control_response" || frame.requestId !== request.readId || frame.ok !== true) throw new Error();
    const payload = fields(frame.payload, ["version", "bindingId", "contextRequestId", "readId", "frame"]);
    if (["version", "bindingId", "contextRequestId", "readId"].some(key => payload[key] !== request[key as keyof GuidedInstructionRequest])
      || typeof payload.frame !== "string" || Buffer.byteLength(payload.frame, "utf8") > GUIDED_READER_FRAME_BYTES
      || !payload.frame.endsWith("\n") || payload.frame.slice(0, -1).includes("\n")
      || Buffer.from(payload.frame, "utf8").toString("utf8") !== payload.frame) throw new Error();
    const inner: unknown = JSON.parse(payload.frame);
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new Error();
    return payload.frame;
  } catch { throw new Error("required_context_unavailable"); }
}
