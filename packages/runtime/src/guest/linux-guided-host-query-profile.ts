/** Guided parent policy validation only; matching DATA cannot create native admission. */
import { parseRuntimeContextConfig, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { GuestFileRoot } from "./file-helper.ts";
import { assertLinuxHostQueryConfig, assertLinuxHostQueryRoots } from "./linux-host-query-profile.ts";
import { parseLinuxGuidedReaderRegistration, type LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";

export const LINUX_GUIDED_HOST_QUERY_PROFILE = "host-query-guided-v1" as const;
const unavailable = (): never => { throw new Error("required_context_unavailable"); };
function baseConfig(config: RuntimeConfig, registration: LinuxGuidedReaderRegistration): RuntimeConfig {
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.getPrototypeOf(config) !== Object.prototype) return unavailable();
  const fields = Object.getOwnPropertyDescriptors(config);
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string") || Object.values(fields).some(field => !("value" in field))) return unavailable();
  const own = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value])) as RuntimeConfig;
  const binding = parseRuntimeContextConfig(own.requiredRuntimeContext);
  if (binding.bindingId !== registration.requiredRuntimeContext.bindingId || own.sessionId !== registration.owner.backendSessionId
    || own.cwd !== registration.views.sourceCwd || own.winterHome !== `/run/winter/conversations/${registration.owner.logicalSessionId}`
    || own.storeHome !== `/workspace/.winter/conversations/${registration.owner.logicalSessionId}`) return unavailable();
  const { requiredRuntimeContext: _binding, ...base } = own;
  assertLinuxHostQueryConfig(base);
  return base;
}
export function assertLinuxGuidedHostQueryConfig(config: RuntimeConfig, value: unknown): void {
  baseConfig(config, parseLinuxGuidedReaderRegistration(value));
}
export function assertLinuxGuidedHostQueryRoots(config: RuntimeConfig, roots: readonly GuestFileRoot[], value: unknown): void {
  const registration = parseLinuxGuidedReaderRegistration(value), base = baseConfig(config, registration);
  // The selected immutable reader source must be one of the existing tool roots;
  // the protected shared view remains a distinct native role, never a source root.
  assertLinuxHostQueryRoots({ ...base, cwd: registration.views.sourceRoot }, roots);
}
