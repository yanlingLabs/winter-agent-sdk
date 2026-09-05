// Task 3 (Lane C): Monitor (WS-06 §3.2). Exactly one of `command`/`ws`; ALWAYS returns immediately
// with `{taskId, timeoutMs, persistent?}` -- unlike Bash, Monitor has no non-backgrounded shape at
// all (no `run_in_background` field on its schema; the tool IS the background primitive). The
// command half reuses the exact same sandbox mechanism Bash does (../../sandbox/spawn.ts); the ws
// half is this file's own network-layer defense-in-depth (WS-07's permission/approval layer is the
// PRIMARY gate, per WS-06 §3.2's own "WS half has its own approval + network checks" -- this is the
// ADDITIONAL check, not a replacement for it).
//
// Documented v1 scope note (flagged rather than invented): "Stdout lines or WS frames re-enter the
// conversation as events" (WS-06 §3.2) is approximated here as output-file-append (execution order,
// same D18 `.output` file Bash background tasks use) plus the SAME task_started/task_notification
// frame pair Bash emits -- the pinned BackgroundTaskMessage union (frames.ts) has no
// per-line/per-frame event shape at all (T2's own derived-shapes writeup enumerates exactly six
// variants, none of them "one line of process output"), so inventing one here would not be a real
// protocol capability, just a shape nobody downstream could consume. A future phase that grows a
// real per-line event type is expected to upgrade this file, not the other way around.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import "../descriptors/monitor.ts";
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createBackgroundTask } from "../background-tasks.ts";
import { runCommand, resolveExecutionPath, isSandboxAvailable, SandboxUnavailableError } from "../../sandbox/spawn.ts";
import { SandboxConfigError, resolveNetworkPosture } from "../../sandbox/profile.ts";
import { startTracking, setTaskStatus, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";

// ---------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------
interface MonitorInput {
  description: string;
  timeout_ms: number;
  persistent: boolean;
  command?: string;
  ws?: { url: string; protocols?: string[] };
}

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3_600_000;

function parseMonitorInput(input: unknown): MonitorInput | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "Monitor: input must be an object" };
  const obj = input as Record<string, unknown>;
  if (typeof obj.description !== "string" || obj.description.length === 0) {
    return { error: 'Monitor: "description" is required and must be a non-empty string' };
  }
  if (typeof obj.timeout_ms !== "number" || !Number.isFinite(obj.timeout_ms) || obj.timeout_ms < MIN_TIMEOUT_MS || obj.timeout_ms > MAX_TIMEOUT_MS) {
    return { error: `Monitor: "timeout_ms" is required and must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
  }
  if (typeof obj.persistent !== "boolean") {
    return { error: 'Monitor: "persistent" is required and must be a boolean' };
  }
  const hasCommand = obj.command !== undefined;
  const hasWs = obj.ws !== undefined;
  if (hasCommand === hasWs) {
    return { error: 'Monitor: exactly one of "command"/"ws" is required' };
  }
  if (hasCommand && typeof obj.command !== "string") {
    return { error: 'Monitor: "command" must be a string' };
  }
  let wsField: { url: string; protocols?: string[] } | undefined;
  if (hasWs) {
    if (typeof obj.ws !== "object" || obj.ws === null) return { error: 'Monitor: "ws" must be an object' };
    const ws = obj.ws as Record<string, unknown>;
    if (typeof ws.url !== "string" || ws.url.length === 0) return { error: 'Monitor: "ws.url" is required and must be a non-empty string' };
    if (ws.protocols !== undefined && (!Array.isArray(ws.protocols) || !ws.protocols.every((p) => typeof p === "string"))) {
      return { error: 'Monitor: "ws.protocols" must be an array of strings' };
    }
    wsField = { url: ws.url, ...(ws.protocols !== undefined ? { protocols: ws.protocols as string[] } : {}) };
  }
  return {
    description: obj.description,
    timeout_ms: obj.timeout_ms,
    persistent: obj.persistent,
    ...(hasCommand ? { command: obj.command as string } : {}),
    ...(wsField !== undefined ? { ws: wsField } : {}),
  };
}

function formatMonitorResult(taskId: string, timeoutMs: number, persistent: boolean): string {
  return JSON.stringify({ taskId, timeoutMs, ...(persistent ? { persistent: true } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Command half -- identical sandbox mechanism to Bash's own background path.
// ---------------------------------------------------------------------------------------------

// `persistent: true` needs a stand-in "effectively forever" value for runCommand's own required
// `timeoutMs` (not optional there) -- max signed 32-bit ms (~24.8 days), the practical Node/Bun
// setTimeout ceiling, rather than an even larger number some timer implementations silently clamp
// to firing near-immediately. No real session runs that long; TaskStop is the actual exit door.
const PERSISTENT_STAND_IN_TIMEOUT_MS = 2_147_483_647;

// Task 8 (P3 close-out, "Settings threading" MUST) -- mirrors bash.ts's own computeWritableRoots/
// buildChildEnv exactly (a small, deliberate duplication rather than a cross-tool-file import: this
// file's own header already documents "reuses the exact same sandbox mechanism Bash does," and
// keeping the mechanism duplicated-but-identical here is lower-risk than introducing a Monitor ->
// Bash source dependency for two three-line helpers). See bash.ts's own comments for the full
// rationale on each piece.
// M2 (fix wave, P3 close-out): mirrors bash.ts's own `formatSandboxAnnotation` verbatim -- same
// deliberate duplication precedent as every other small sandbox-mechanism helper in this file (see
// this function's own sibling comments). WS-12 §8 requires the result to record the sandbox-override
// state on every surface; Lane C's own fix (bash.ts) added this annotation to Bash's three
// background surfaces only -- Monitor's `task_notification.summary` (both the natural-completion and
// pre-spawn-failure branches, below) never got it, leaving a `config-disabled`/`excluded` Monitor
// command with no trace it ran unfenced.
function formatSandboxAnnotation(posture: string, sandboxOverrideRequested: boolean): string {
  const overrideNote = sandboxOverrideRequested && posture !== "override-requested" ? ", override-requested" : "";
  return `[sandbox: ${posture}${overrideNote}]`;
}

function computeMonitorWritableRoots(ctx: ToolExecutionContext): string[] {
  // C1 (fix wave, P3 close-out): `filesystem.allowWrite` unioned in too, mirroring bash.ts's own
  // identical fix to `computeWritableRoots` (WS-12 §12 Q5: additive, never a replacement).
  return [ctx.tempDir, ...ctx.session.getBoundedRoots(), ...(ctx.outDir !== undefined ? [ctx.outDir] : []), ...(ctx.sandboxSettings.filesystem?.allowWrite ?? [])];
}
function buildMonitorChildEnv(ctx: ToolExecutionContext): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: ctx.tempDir, ...(ctx.outDir !== undefined ? { OUTDIR: ctx.outDir } : {}) };
}

// C1 (fix wave, P3 close-out): the SAME missing-deny-paths gap bash.ts's own `computeDenyPaths` (see
// that file's header for the full rationale) closes, for Monitor's command half -- Monitor's own
// header already says "Command half uses the Bash permission family" / "reuses the exact same
// sandbox mechanism Bash does"; the two files intentionally duplicate this small, identical
// three-line shape rather than one importing the other (this file's own header: "a small, deliberate
// duplication rather than a cross-tool-file import").
interface MonitorDenyPaths {
  denyWritePaths?: string[];
  denyReadPaths?: string[];
}
function computeMonitorDenyPaths(ctx: ToolExecutionContext): MonitorDenyPaths {
  const fs = ctx.sandboxSettings.filesystem;
  return {
    ...(fs?.denyWrite !== undefined ? { denyWritePaths: fs.denyWrite } : {}),
    ...(fs?.denyRead !== undefined ? { denyReadPaths: fs.denyRead } : {}),
  };
}

// C1 (fix wave, P3 close-out): mirrors bash.ts's own `buildRunCommandOptions` -- factored out so a
// test can assert on the OPTIONS `runMonitorCommand` would build without needing to intercept
// `RunCommandResult.profile`.
function buildMonitorRunCommandOptions(ctx: ToolExecutionContext): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  settings: typeof ctx.sandboxSettings;
  writableRoots: string[];
  denyWritePaths?: string[];
  denyReadPaths?: string[];
  home: string;
  /** Phase 5 fix wave, I1: the resolved `~/.winter` root, distinct from the OS home above. */
  winterHome?: string;
} {
  return {
    cwd: ctx.cwd,
    env: buildMonitorChildEnv(ctx),
    settings: ctx.sandboxSettings,
    writableRoots: computeMonitorWritableRoots(ctx),
    ...computeMonitorDenyPaths(ctx),
    home: ctx.home,
    ...(ctx.winterHome !== undefined ? { winterHome: ctx.winterHome } : {}),
  };
}

async function runMonitorCommand(input: MonitorInput & { command: string }, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  // Same pre-flight-before-committing pattern as bash.ts's own runBackground -- see that function's
  // header comment for why (runCommand is `async`, so a pre-spawn throw becomes an unobservable
  // rejected promise by the time this caller could otherwise inspect it).
  const decision = resolveExecutionPath({ settings: ctx.sandboxSettings, command: input.command });
  if (decision.posture === "sandboxed") {
    if (!isSandboxAvailable()) {
      return {
        output: "Error: Monitor: sandbox is required by the effective configuration but /usr/bin/sandbox-exec is unavailable on this host (WS-12 §3)",
        isError: true,
      };
    }
    try {
      resolveNetworkPosture(ctx.sandboxSettings.network);
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  const { taskId, outputPath } = createBackgroundTask("monitor");
  const outStream = createWriteStream(outputPath, { flags: "a" });
  const effectiveTimeout = input.persistent ? PERSISTENT_STAND_IN_TIMEOUT_MS : input.timeout_ms;

  // Task 8 (the SAME ordering bug bash.ts's own runBackground had, found via a real
  // differential-scenario repro): register the task BEFORE spawning, not only inside onSpawned
  // below, so the background_tasks_changed emit a few lines down never reports an empty tasks list
  // immediately after starting the very task it was announcing.
  // N3 (fix wave, nit correction, P3 close-out): see bash.ts's own identical correction -- the
  // former claim here ("runCommand's spawn is asynchronous, onSpawned fires on a later tick") is
  // empirically false under this project's runtime (onSpawned fires synchronously, same tick).
  // Pre-registering is still correct/necessary discipline: it decouples this call site from
  // spawn.ts's own internal timing, which a future change there could alter. Safe to call again
  // from onSpawned with the real pid once spawning completes -- startTracking's `pid?: number` is
  // optional and `tasks.set()` is a plain overwrite of the same entry. Contrast the `ws` half a few
  // hundred lines below, which calls startTracking synchronously with no spawn step at all, so it
  // never needed this pattern in the first place.
  startTracking({ taskId, kind: "monitor", outputPath, description: input.description, command: input.command });

  let completion: ReturnType<typeof runCommand>;
  try {
    completion = runCommand({
      ...buildMonitorRunCommandOptions(ctx),
      command: input.command,
      timeoutMs: effectiveTimeout,
      onSpawned: ({ pid }) => {
        startTracking({ taskId, kind: "monitor", outputPath, description: input.description, command: input.command, pid });
      },
      onStdout: (c) => outStream.write(c),
      onStderr: (c) => outStream.write(c),
    });
  } catch (err) {
    outStream.end();
    if (err instanceof SandboxUnavailableError || err instanceof SandboxConfigError) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
    throw err;
  }

  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description: input.description,
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });

  completion.then(
    (result) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return; // TaskStop already recorded a terminal status
      const status = result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
      setTaskStatus(taskId, status);
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status,
          output_file: outputPath,
          // M2 (fix wave, P3 close-out): WS-12 §8's own annotation, previously only on Bash's three
          // background surfaces.
          summary: `${input.description} (${status}) ${formatSandboxAnnotation(result.posture, result.sandboxOverrideRequested)}`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
        ctx.emitFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* a torn-down session's emitFrame may throw; the registry's status and .output file are still correct */
      }
    },
    (err) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return;
      setTaskStatus(taskId, "failed");
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "failed",
          output_file: outputPath,
          // M2 (fix wave, P3 close-out): no RunCommandResult exists on this branch (runCommand
          // itself rejected, pre-spawn) -- `decision`, computed at the top of this function, is what
          // was actually attempted (mirrors bash.ts's own runBackground failure-branch precedent).
          summary: `${input.description} (failed to run: ${(err as Error).message}) ${formatSandboxAnnotation(decision.posture, decision.sandboxOverrideRequested)}`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* see above */
      }
    },
  );

  return { output: formatMonitorResult(taskId, input.timeout_ms, input.persistent) };
}

// ---------------------------------------------------------------------------------------------
// ws half -- endpoint validation (defense-in-depth beyond WS-07's own approval/network checks).
// ---------------------------------------------------------------------------------------------

function isDisallowedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable -- fail closed
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / unspecified (0.0.0.0/8 falls out of `a === 0` already)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local -- covers cloud metadata 169.254.169.254
  // N5 (fix wave, nit, P3 close-out): two gaps this classifier's own defense-in-depth posture
  // (WS-07 is the PRIMARY gate; this file's own header) had left open -- neither is a cloud-metadata
  // or loopback-adjacent risk on the scale of the ranges above, but both were plainly unclassified.
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, Carrier-Grade NAT (RFC 6598)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4, multicast
  return false;
}

// An IPv4-mapped IPv6 address's two trailing 16-bit groups ARE the IPv4 address, just split across
// group boundaries rather than byte boundaries: each group's high byte then low byte, concatenated,
// is the dotted-quad. E.g. "a9fe:a9fe" -> 0xa9fe=169.254 twice -> "169.254.169.254" (cloud metadata).
function ipv4FromHexGroups(g1: string, g2: string): string {
  const h1 = parseInt(g1, 16);
  const h2 = parseInt(g2, 16);
  return `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
}

function isDisallowedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mappedDotted) return isDisallowedIPv4(mappedDotted[1]!);
  // IPv4-mapped, HEX-GROUP form (e.g. "::ffff:a9fe:a9fe" for 169.254.169.254) -- a resolver can hand
  // this shape back just as readily as the dotted-quad form above. Without this arm, the two
  // trailing hex groups fail the dotted-quad regex, and `lower.split(":")[0]` (used below for the
  // fe80::/fc00:: checks) is "" (the leading "::" splits to two empty leading segments) -- an empty
  // string fails the `.length > 0` guard, so `firstGroup` stays NaN and NEITHER link-local check
  // ever fires either. The address fell all the way through to the final `return false`: silently
  // ALLOWED. Converting both groups to their four constituent bytes and re-running them through
  // isDisallowedIPv4 gives this one shared source of truth with the dotted-quad arm above.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) return isDisallowedIPv4(ipv4FromHexGroups(mappedHex[1]!, mappedHex[2]!));
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  const firstGroupText = lower.split(":")[0] ?? "";
  const firstGroup = firstGroupText.length > 0 ? parseInt(firstGroupText, 16) : NaN;
  if (!Number.isNaN(firstGroup)) {
    if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true; // fe80::/10 link-local
    if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true; // fc00::/7 unique-local
  }
  return false;
}

function isDisallowedAddress(address: string, family: number): boolean {
  return family === 6 ? isDisallowedIPv6(address) : isDisallowedIPv4(address);
}

// RULING P3-I (Task 8, P3 close-out): `connectUrl` is keyed by the VALIDATED ADDRESS itself (never
// the original hostname) and `hostHeader` preserves the original `host[:port]` for the WS upgrade
// request's own Host header (virtual-hosting servers care which name the client asked for) -- see
// validateWsEndpoint's own header for why this closes the DNS-rebinding TOCTOU Lane C's review
// disclosed.
type WsValidation = { ok: true; connectUrl: URL; hostHeader: string } | { ok: false; reason: string };

// A bare (unbracketed) IPv6 literal assigned to `URL.hostname` SILENTLY NO-OPS under WHATWG URL
// parsing -- verified empirically before writing this function (`u.hostname = "::1"` leaves the URL
// completely unchanged, no error, no warning). Bracketing is not cosmetic here; omitting it would
// make the whole pin a silent no-op for every IPv6 target, defeating this ruling entirely.
function hostnameForUrl(address: string, family: number): string {
  return family === 6 ? `[${address}]` : address;
}

// RULING P3-I: pins the ACTUAL CONNECTION to the address this function itself just validated,
// closing the DNS-rebinding TOCTOU Lane C's own review disclosed (fix-round-1 item 2, `d776808`):
// the pre-fix `validateWsEndpoint` resolved+validated the hostname ONCE, then handed back a URL
// still keyed by that SAME hostname -- `new WebSocket(url)` at the actual connect site re-resolved
// it INDEPENDENTLY, through Bun's own platform DNS, so a TTL-0/rebinding-capable resolver could pass
// THIS validation with a safe address and connect to a disallowed one on the SECOND, independent
// resolution.
//
// ws:// is pinned unconditionally below (nothing about a plain TCP connection cares which name was
// used to find the address -- see the Host-header handling instead for the one thing that DOES).
//
// wss:// is the harder case, and is DELIBERATELY NOT given the identical treatment: TLS certificate
// validation (and SNI, before the handshake even starts) needs the ORIGINAL HOSTNAME, not the
// resolved IP -- pinning the raw connection to an IP while asking Bun's own TLS stack to validate
// against a DIFFERENT literal string is not the same "just change the hostname" operation ws://'s
// pin is. Bun's WebSocket constructor DOES expose a `tls.serverName` override that could in
// principle re-supply the real hostname for SNI/cert validation while the raw TCP connection targets
// the pinned IP (verified present in this task's own research) -- a genuine candidate resolver seam
// for whoever revisits this. This ruling does NOT adopt it here: the phase ledger's own ratified
// posture is "fail-closed on non-literal wss hosts is the fallback posture" until that seam is built
// and empirically verified end-to-end (TLS pinning has more failure modes than a plain TCP connect,
// and this task's own scope did not include standing up a real TLS test fixture to prove it). An
// ALREADY-literal wss:// host (the caller wrote a raw IP) has nothing to rebind in the first place --
// there is no SECOND, independent resolution of a literal address -- so it is not rejected; only a
// genuine DNS name is.
// A REAL, pre-existing (not introduced by this ruling) bug found empirically while adding this
// ruling's own IPv6 fixture: `URL.hostname` for a bracketed IPv6 host returns the BRACKETS INCLUDED
// (`"[2001:4860:4860::8888]"`, verified directly against this project's own URL implementation --
// not the bracket-stripped form the WHATWG spec's prose might suggest at a glance). Handing that
// bracketed string to `node:dns`'s `lookup()` or `node:net`'s `isIP()` makes BOTH silently fail to
// recognize it as the literal it is: `dns.lookup("[::1]")` rejects with ENOTFOUND (it tries to
// resolve "[::1]" as a hostname), and `isIP("[::1]")` returns `0` ("not an IP"). Before this fix,
// EVERY IPv6 URL -- literal or not -- would have failed DNS resolution outright; no existing test
// anywhere in this file exercised a real IPv6 URL end-to-end, only the bare-string
// isDisallowedIPv6() classifier directly. Stripping brackets ONCE, up front, is what makes both the
// wss:// literal-detection check below AND the DNS lookup see the address form they actually expect.
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function validateWsEndpoint(rawUrl: string): Promise<WsValidation> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `invalid URL: ${rawUrl}` };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, reason: `unsupported scheme "${url.protocol}" -- only ws:// and wss:// are allowed` };
  }
  const bareHostname = stripBrackets(url.hostname);
  if (url.protocol === "wss:" && isIP(bareHostname) === 0) {
    return {
      ok: false,
      reason:
        `wss:// to a DNS name ("${url.hostname}") cannot yet be safely pinned against a DNS-rebinding resolver (RULING P3-I) -- ` +
        `use a literal IP address for wss://, or ws:// if TLS is not required`,
    };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(bareHostname, { all: true });
  } catch {
    return { ok: false, reason: `DNS resolution failed for "${url.hostname}" -- failing closed` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `no addresses resolved for "${url.hostname}" -- failing closed` };
  }
  for (const { address, family } of addresses) {
    if (isDisallowedAddress(address, family)) {
      return { ok: false, reason: `"${url.hostname}" resolves to a disallowed private/link-local/metadata address (${address})` };
    }
  }
  // Every candidate above passed the disallow check; pin to the first one. `url.host` already
  // includes a non-default port when one was given, which is exactly the Host-header value a
  // virtual-hosting server would have seen from an UNPINNED connection to the original hostname.
  const pinned = addresses[0]!;
  const connectUrl = new URL(url.toString());
  connectUrl.hostname = hostnameForUrl(pinned.address, pinned.family);
  return { ok: true, connectUrl, hostHeader: url.host };
}

const MAX_WS_MESSAGE_BYTES = 1024 * 1024; // WS-06 §3.2: "kills on >1 MiB messages"

async function runMonitorWs(input: MonitorInput & { ws: { url: string; protocols?: string[] } }, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const validation = await validateWsEndpoint(input.ws.url);
  if (!validation.ok) {
    return { output: `Error: Monitor: ${validation.reason}`, isError: true };
  }
  return connectMonitorWs(validation.connectUrl.toString(), input.ws.protocols, input.description, input.timeout_ms, input.persistent, ctx, validation.hostHeader);
}

// Split out from runMonitorWs (and exported) so the CONNECTION/STREAMING mechanics -- message
// append, binary-frame placeholders, the 1 MiB kill, timeout/persistent, TaskStop integration --
// are directly testable against a real local WS server without contradicting
// validateWsEndpoint's OWN correct rejection of loopback/private targets (this file's own header:
// that rejection is a deliberate security property, not a test inconvenience to route around).
// validateWsEndpoint's rejection behavior itself is tested separately and directly.
export async function connectMonitorWs(
  url: string,
  protocols: string[] | undefined,
  description: string,
  timeoutMs: number,
  persistent: boolean,
  ctx: ToolExecutionContext,
  // RULING P3-I (Task 8, P3 close-out): optional, appended LAST so every pre-existing direct-call
  // test site (this file's own header: "directly testable against a real local WS server") keeps
  // compiling unchanged. Production's own caller (runMonitorWs, above) always supplies it -- `url`
  // by that point is already the PINNED address (validateWsEndpoint's own connectUrl), and this is
  // the original `host[:port]` string a virtual-hosting server would have seen from an unpinned
  // connection.
  hostHeader?: string,
): Promise<ToolResultPayload> {
  // RULING P3-I: CLOSED for ws:// -- `url` (above) is already the address `validateWsEndpoint`
  // itself validated (never re-derived from a second, independent resolution at this connect site),
  // and `hostHeader` restores the Host a virtual-hosting server expects. wss:// to a genuine DNS
  // name is rejected upstream, in validateWsEndpoint, before this function is ever reached -- see
  // that function's own header for the full rationale (including the TLS-serverName candidate seam
  // this ruling deliberately does not adopt yet) and why an already-literal wss:// host needed no
  // fix here to begin with (nothing to rebind).
  let socket: WebSocket;
  // Verified empirically (a standalone script, real Bun runtime): `new WebSocket(url, { headers:
  // {...} })` genuinely works -- Bun's real constructor accepts a `Bun.WebSocketOptions` object as
  // its 2nd argument (protocols/headers/tls/proxy/compression), per bun-types' own declared
  // `new (url, options?: Bun.WebSocketOptions)` overload. But in THIS project's own tsconfig, the
  // ambient `WebSocket` global's effective TYPE resolves to only the OTHER, narrower overload
  // (`(url, protocols?: string | string[])`) -- verified project-wide, not specific to this file or
  // this argument's own shape (bun-types' own `UseLibDomIfAvailable` helper falls back to whatever
  // `lib.dom.d.ts`-shaped WebSocket some transitively-loaded lib/types package supplies once one is
  // present, and that shape has no options-object overload at all). A local constructor-type cast is
  // the least-invasive way to use the REAL (runtime-correct, spec-documented) signature without
  // fighting this project's own global type resolution.
  type BunWebSocketCtor = new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
  const wsOptions: Bun.WebSocketOptions = {
    ...(protocols !== undefined ? { protocols } : {}),
    ...(hostHeader !== undefined ? { headers: { Host: hostHeader } } : {}),
  };
  try {
    socket = new (WebSocket as unknown as BunWebSocketCtor)(url, wsOptions);
  } catch (err) {
    return { output: `Error: Monitor: failed to open websocket: ${(err as Error).message}`, isError: true };
  }
  socket.binaryType = "arraybuffer";

  const { taskId, outputPath } = createBackgroundTask("monitor");
  const outStream = createWriteStream(outputPath, { flags: "a" });

  let timer: ReturnType<typeof setTimeout> | undefined;

  function finalize(status: "completed" | "failed" | "stopped", summary: string): void {
    if (timer) clearTimeout(timer);
    outStream.end();
    if (getTask(taskId)?.status !== "running") return; // TaskStop already recorded a terminal status
    setTaskStatus(taskId, status);
    try {
      ctx.emitFrame({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status,
        output_file: outputPath,
        summary,
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
    } catch {
      /* a torn-down session's emitFrame may throw; the registry's status and .output file are still correct */
    }
  }

  startTracking({ taskId, kind: "monitor", outputPath, description, stop: () => socket.close() });

  // ORDERING TRAP (found via a real repro, not assumed): Bun's WebSocket.close() fires the socket's
  // OWN onclose handler SYNCHRONOUSLY, before control returns to whatever called .close(). Every
  // call site below therefore calls finalize() FIRST and socket.close() SECOND -- finalize() sets
  // the task's status via setTaskStatus before this function's own emitFrame calls, so by the time
  // the synchronously-triggered onclose handler runs ITS OWN finalize("completed"|"failed", ...)
  // call, the "already terminal, not \"running\"" guard makes that second call a harmless no-op.
  // Reversing this order (close-then-finalize) would let onclose's own generic "clean close ->
  // completed" verdict win the race and silently overwrite the SPECIFIC verdict (timeout / oversized
  // message) this code means to report -- exactly the bug this comment exists to prevent recurring.
  if (!persistent) {
    timer = setTimeout(() => {
      finalize("failed", `${description} (timed out after ${timeoutMs}ms)`);
      socket.close();
    }, timeoutMs);
  }

  socket.onmessage = (event: MessageEvent) => {
    const data = event.data as unknown;
    if (typeof data === "string") {
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > MAX_WS_MESSAGE_BYTES) {
        finalize("failed", `${description} (message exceeded 1 MiB, killed)`);
        socket.close();
        return;
      }
      outStream.write(`${data}\n`);
    } else {
      // binaryType "arraybuffer" -- a binary frame arrives as an ArrayBuffer, never a Blob.
      const byteLength = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
      if (byteLength > MAX_WS_MESSAGE_BYTES) {
        finalize("failed", `${description} (message exceeded 1 MiB, killed)`);
        socket.close();
        return;
      }
      outStream.write(`[binary frame, ${byteLength} bytes]\n`);
    }
  };

  socket.onerror = () => {
    finalize("failed", `${description} (connection error)`);
  };

  // `event.wasClean` is NOT the right signal here (found via a real repro, not assumed): Bun's
  // client-side WebSocket reports wasClean=false even for a well-formed SERVER-initiated close with
  // code 1000 (verified against a real Bun.serve websocket) -- only a CLIENT-initiated close comes
  // back wasClean=true in practice, which would make every naturally-ended stream (the server simply
  // finishing and closing normally) misreport as "failed." The close CODE is the portable signal:
  // 1000 (Normal Closure) and 1001 (Going Away, e.g. the server shutting down) both mean the stream
  // ended on purpose, regardless of which side initiated it; anything else is a genuine failure.
  socket.onclose = (event: CloseEvent) => {
    const clean = event.code === 1000 || event.code === 1001;
    finalize(clean ? "completed" : "failed", `${description} (${clean ? "completed" : `connection closed unexpectedly, code ${event.code}`})`);
  };

  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description,
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });

  return { output: formatMonitorResult(taskId, timeoutMs, persistent) };
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
export const monitorExecutor: ToolExecutor = {
  async execute(input, ctx) {
    const parsed = parseMonitorInput(input);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    if (parsed.command !== undefined) return runMonitorCommand(parsed as MonitorInput & { command: string }, ctx);
    return runMonitorWs(parsed as MonitorInput & { ws: { url: string; protocols?: string[] } }, ctx);
  },
};

replaceExecutor("Monitor", monitorExecutor);

export { parseMonitorInput, isDisallowedAddress, validateWsEndpoint, buildMonitorRunCommandOptions };
