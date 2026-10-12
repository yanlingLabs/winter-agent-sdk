import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { buildMandatoryFloorProfile, hasMandatoryFloor, MandatoryFloorUnavailableError, type HostExecutionFloor } from "@yanlinglabs/winter-agent-sdk";

let registration: { readonly profile: string } | undefined;

/** Trusted session/Worker lifecycle only. Freeze the rendered floor independently of editable
 * settings and subsequent caller mutations. This covers subprocesses, not in-process reads. */
export function installHostChildFloor(floor: HostExecutionFloor): () => void {
  if (!hasMandatoryFloor(floor)) throw new MandatoryFloorUnavailableError("host child floor requires a nonempty registration");
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new MandatoryFloorUnavailableError("native host child floor unavailable");
  const next = Object.freeze({ profile: buildMandatoryFloorProfile(floor) });
  const previous = registration;
  registration = next;
  let released = false;
  return () => {
    if (released) return;
    if (registration !== next) throw new MandatoryFloorUnavailableError("host child floor lifecycle overlapped; refusing removal of another registration");
    released = true;
    registration = previous;
  };
}

/** Composition seam for an existing native sandbox profile (Bash/Workflow). Do not nest
 * sandbox-exec inside another applied sandbox; add these denies to the admitted profile. */
export function currentHostChildFloorProfile(): string | undefined { return registration?.profile; }

/** Prepare immediately before spawn/execFile/Bun.spawn. The caller MUST use both returned fields.
 * The native persistent floor is applied even for an ordinary approved Code shell escape. */
export function prepareHostChildLaunch(command: string, args: readonly string[], options: {
  cwd?: string | undefined; env?: Readonly<Record<string, string | undefined>> | undefined;
} = {}): { command: string; args: string[] } {
  const floor = registration;
  if (!floor) return { command, args: [...args] };
  if (!command || command.includes("\0")) throw new MandatoryFloorUnavailableError("invalid floored child executable");
  let executable: string | undefined;
  if (isAbsolute(command)) executable = command;
  else if (command.includes("/")) {
    if (!options.cwd || !isAbsolute(options.cwd)) throw new MandatoryFloorUnavailableError("relative child executable requires an explicit absolute cwd");
    executable = resolve(options.cwd, command);
  } else {
    const path = (options.env === undefined ? process.env.PATH : options.env.PATH) ?? "/usr/bin:/bin";
    for (const part of path.split(":")) {
      // Relative/empty PATH entries require the explicit session cwd, never Core's cwd.
      if (!isAbsolute(part) && (!options.cwd || !isAbsolute(options.cwd))) continue;
      const candidate = resolve(options.cwd ?? "/", part || ".", command);
      try { accessSync(candidate, constants.X_OK); executable = candidate; break; } catch {}
    }
  }
  if (!executable) throw new MandatoryFloorUnavailableError("floored child executable could not be resolved");
  return { command: "/usr/bin/sandbox-exec", args: ["-p", floor.profile, executable, ...args] };
}
