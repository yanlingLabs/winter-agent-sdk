import { createHookStage, type HookStageDeps } from "./hook-stage.ts";
import { buildHookRegistry, type SourcedHookEntry } from "./registry.ts";
import { createRegistryToolInputValidator } from "./input-validator.ts";

export interface HostCodeHookStageOptions extends Omit<HookStageDeps, "registry" | "audit"> {
  /** Prepared host registrations and a host invoker; never a guest-reported hook verdict. */
  entries: readonly SourcedHookEntry[];
  trustedWorkspace: boolean;
  audit?: HookStageDeps["audit"];
  warn?: (line: string) => void;
}

/** Uses exactly the runtime matcher, interpreter, timeout, fail-closed and reducer semantics.
 * The invoker must return the completed reviewer result, not a launch acknowledgement. */
export function createHostCodeHookStage(options: HostCodeHookStageOptions) {
  const { entries, trustedWorkspace, warn, audit, ...deps } = options;
  return createHookStage({
    ...deps,
    registry: buildHookRegistry(entries.map((entry) => ({ ...entry })), { trustedWorkspace, ...(warn ? { warn } : {}) }),
    audit: audit ?? { record() {} },
    validator: deps.validator ?? createRegistryToolInputValidator({ ...(warn ? { warn } : {}) }),
  });
}
