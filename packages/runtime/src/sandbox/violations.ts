// THE SANDBOX VIOLATIONS BLOCK (macOS Seatbelt only). A sandboxed command that fails because the
// sandbox denied it usually says nothing about the sandbox: `open -a Safari` reports a LaunchServices
// error (`kLSNoExecutableErr`, "No application knows how to open URL"), a denied mach-lookup surfaces
// as whatever the library made of it, a denied write as a plain EPERM. claude's Bash tool closes that
// gap by appending the command's own Seatbelt denials to its output in a `<sandbox_violations>`
// block, read from the macOS unified log; this module is Winter's version of that mechanism.
//
// ATTRIBUTION -- a per-command tag in the profile. `tagSeatbeltDenials` gives every top-level `deny`
// rule of the command's profile a `(with message "<tag>")` modifier. The kernel appends that message
// to each denial it reports, so the unified log line reads
//     Sandbox: bash(4242) deny(1) file-write-create /private/var/.../denied/x.txt\n<tag>
// and a filter on that tag sees exactly this command's denials -- every process it started included
// (they inherit the sandbox), nothing from another command, session or app. Measured on macOS 26
// (2026-10-19, real `sandbox-exec`): the modifier works on `(deny default)`, on `(deny network*)` and
// on explicit path denies, placed before or after the filters, and it does not change what is denied.
//
// COLLECTION -- a `log stream` for this one command, subscribed BEFORE the command starts.
// `startViolationMonitor` spawns `log stream --predicate '(sender == "Sandbox" AND eventMessage
// ENDSWITH "<tag>" AND NOT <diagnosticd>) OR eventMessage == "<tag>-ready"'` and the command is
// spawned only once the stream has echoed back a CANARY (`/usr/bin/logger "<tag>-ready"`, re-sent
// every 50 ms until it arrives). The stream's own header is NOT a ready signal: measured, a command
// started on the header lost its early denials in 3 of 16 runs (they were in the log store, the
// stream was not yet subscribed); with the canary, 0 of 32. Measured under this Mac's normal load
// (load average 5-14), through `runCommand`:
//   - a successful `true` pays ~10 ms median over an unreported one (p90 ~12 ms; ~10 ms after a 60 s
//     idle pause too) -- the stream's start-up and the canary round trip, after which the stream is
//     SIGKILLed without waiting;
//   - a failed command's denials have arrived by the time it exits; `drain` waits until no tagged line
//     for `VIOLATION_DRAIN_QUIET_MS`, hard-capped at `VIOLATION_DRAIN_CAP_MS` (measured ~101 ms median
//     and max across writes, `open -b` and `nc`).
// The previous design, a `log show` run after the failure, was rejected on measurement: real failures
// arrive minutes apart, so the query ran cold, 1.7-5 s with outliers of 9-11 s.
// A stream that cannot confirm in `VIOLATION_STREAM_READY_TIMEOUT_MS` is killed and the command runs
// without a block -- never a failed command. NO ORPHANS: the stream is its own process group,
// recorded in the process-group ledger (an embedded session's host reaps it if the Worker dies), and
// `log stream --timeout` ends it by itself at the command's timeout plus a margin even if every
// parent is SIGKILLed (a stream filtered on a unique tag never writes, so it would never see SIGPIPE).
// Nothing runs while idle: a stream lives exactly as long as its command.
// Disclosed limits: one extra `log` process (and one `logger` line in the unified log) per sandboxed
// foreground command; the host Code broker path (`runBrokeredCommand`) builds its profile in the host
// and reports no violations.
//
// NOISE -- every sandboxed process hits the same harmless denials at start-up (`true`, `whoami`,
// `mktemp` and `ls /nonexistent` all produced them), so a block built from them would tell the model
// that every failure was the sandbox's doing. `BASELINE_DENIALS` drops exactly those; a failure whose
// only denials are baseline gets no block at all.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { prepareHostChildLaunch } from "./host-child-floor.ts";
import { trackProcessGroup } from "../process-groups.ts";

/** The block's own bounds: at most this many lines, and at most this many bytes of them. */
export const VIOLATION_BLOCK_MAX_LINES = 20;
export const VIOLATION_BLOCK_MAX_BYTES = 4_096;
/** How long a command waits for its stream to confirm before running without one. Measured ready: ~9 ms median. */
export const VIOLATION_STREAM_READY_TIMEOUT_MS = 1_000;
/** How often the canary is re-sent while the stream has not echoed it yet. */
export const VIOLATION_CANARY_INTERVAL_MS = 50;
/** After a failure: stop once no tagged line arrived for this long ... */
export const VIOLATION_DRAIN_QUIET_MS = 100;
/** ... and never wait longer than this. */
export const VIOLATION_DRAIN_CAP_MS = 300;
/** The stream's own `--timeout`: the command's timeout plus this margin, in seconds. */
export const VIOLATION_STREAM_MARGIN_SECONDS = 5;
/** The most stream output read per command; past it the stream is stopped and the report says so. Measured: `open -b` and `swiftc` write ~0.35 MB once diagnosticd is filtered out. */
export const VIOLATION_READ_MAX_BYTES = 4 * 1_048_576;
/** The most distinct denials kept per command; past it the report says so. */
export const VIOLATION_TRACKED_MAX_LINES = 200;

const TAG_PREFIX = "winter-sbx-";
const TAG_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** A fresh tag for one command: unguessable, so no other command's denials can carry it. */
export function newSandboxViolationTag(): string {
  return `${TAG_PREFIX}${randomBytes(8).toString("hex")}`;
}

/**
 * Give every top-level `(deny ...)` form of an SBPL profile a `(with message "<tag>")` modifier,
 * leaving every other byte as it was. A small reader, not a regex: deny forms span lines (the
 * ancestor-rename blocks), and string and regex literals may hold parentheses. A plain string
 * (`"..."`) honours backslash escapes; a regex literal (`#"..."`) is RAW to Seatbelt -- it ends at the
 * first `"` -- so one holding a `\"` is a profile this reader will not guess about. Returns
 * `undefined` -- the caller then runs the profile UNTAGGED -- for that, for a tag that is not a plain
 * token, or for a profile whose parentheses or literals do not balance: this never hands
 * `sandbox-exec` a profile it would not have run anyway.
 */
export function tagSeatbeltDenials(profile: string, tag: string): string | undefined {
  if (!TAG_SHAPE.test(tag)) return undefined;
  const modifier = ` (with message "${tag}")`;
  let out = "";
  let depth = 0;
  let isDeny = false;
  let i = 0;
  while (i < profile.length) {
    const ch = profile[i]!;
    if (ch === "#" && profile[i + 1] === '"') {
      const end = profile.indexOf('"', i + 2);
      if (end === -1 || profile[end - 1] === "\\") return undefined; // unterminated, or a `\"` Seatbelt reads raw
      out += profile.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < profile.length && profile[j] !== '"') j += profile[j] === "\\" ? 2 : 1;
      if (j >= profile.length) return undefined; // unterminated literal
      out += profile.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      const end = profile.indexOf("\n", i);
      const stop = end === -1 ? profile.length : end;
      out += profile.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) isDeny = /^\(deny[\s)]/.test(profile.slice(i, i + 6));
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return undefined;
      if (depth === 0 && isDeny) out += modifier;
    }
    out += ch;
    i++;
  }
  return depth === 0 ? out : undefined;
}

// Denials every sandboxed process produces, measured with `true`, `false`, `whoami`, `id -un`,
// `mktemp`, `ls /nonexistent`, `grep x /nonexistent`, `git status` and `python3 -c 'exit(3)'` under
// the real Bash profile: dyld's dtrace helper, bash probing the controlling tty, libc's user and
// group lookups (opendirectoryd, which then falls back -- `whoami` still succeeds), the notify shm,
// and the logging/analytics endpoints (claude's runtime drops diagnosticd and analyticsd too). None
// of them is why a command fails. Matched against the operation and its target, process name and
// pid removed.
const BASELINE_DENIALS: ReadonlySet<string> = new Set([
  "file-write-data /dev/tty",
  "ipc-posix-shm-read-data apple.shm.notification_center",
  "mach-lookup com.apple.system.opendirectoryd.libinfo",
  "mach-lookup com.apple.system.opendirectoryd.membership",
  "mach-lookup com.apple.logd",
  "mach-lookup com.apple.diagnosticd",
  "mach-lookup com.apple.analyticsd",
]);
const BASELINE_PREFIXES = ["file-ioctl path:/dev/dtracehelper "];

function isBaselineDenial(operation: string): boolean {
  return BASELINE_DENIALS.has(operation) || BASELINE_PREFIXES.some((prefix) => operation.startsWith(prefix));
}

// `Sandbox: open(55300) deny(1) mach-lookup com.apple.lsd.mapdb`, or the kernel's coalesced form
// `409 duplicate reports for Sandbox: open(55300) deny(1) mach-lookup com.apple.lsd.modifydb`.
const DENIAL_LINE = /^(?:\d+ duplicate reports? for )?Sandbox: (.+?)\(\d+\) (deny\(\d+\)) (.+)$/;

/**
 * One denial from a raw unified-log `eventMessage`, or `undefined`: only a message that ENDS with
 * `\n<tag>` counts; the pid and the duplicate-report prefix are dropped (the process name stays, so
 * `open deny(1) mach-lookup com.apple.lsd.mapdb` says who was refused what); a baseline denial is
 * `"baseline"` (this command's, but never a reason it failed).
 */
export function parseSandboxViolation(message: string, tag: string): string | "baseline" | undefined {
  const suffix = `\n${tag}`;
  if (!message.endsWith(suffix)) return undefined;
  const body = message.slice(0, -suffix.length).replace(/\s+/g, " ").trim();
  const match = DENIAL_LINE.exec(body);
  if (match === null) return undefined;
  const [, processName, deny, operation] = match as unknown as [string, string, string, string];
  if (isBaselineDenial(operation)) return "baseline";
  return `${processName} ${deny} ${operation}`;
}

/** What a command's stream saw: its distinct non-baseline denials in order, and whether reading stopped early. */
export interface SandboxViolationReport {
  lines: string[];
  /** The stream output passed `VIOLATION_READ_MAX_BYTES`, or the distinct denials passed `VIOLATION_TRACKED_MAX_LINES`. */
  truncated: boolean;
}

/** Folds tagged messages into a report: repeats collapse to their first appearance, bounded. */
export class SandboxViolationCollector {
  private readonly seen = new Set<string>();
  private readonly lines: string[] = [];
  private truncated = false;
  constructor(private readonly tag: string) {}

  /** Returns whether the message was this command's (a denial of it, baseline or not). */
  add(message: string): boolean {
    const parsed = parseSandboxViolation(message, this.tag);
    if (parsed === undefined) return false;
    if (parsed === "baseline" || this.seen.has(parsed)) return true;
    if (this.lines.length >= VIOLATION_TRACKED_MAX_LINES) {
      this.truncated = true;
      return true;
    }
    this.seen.add(parsed);
    this.lines.push(parsed);
    return true;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  report(): SandboxViolationReport {
    return { lines: [...this.lines], truncated: this.truncated };
  }
}

/** Every distinct denial in `messages` that belongs to `tag`, baseline removed (a convenience over the collector). */
export function parseSandboxViolations(messages: readonly string[], tag: string): string[] {
  const collector = new SandboxViolationCollector(tag);
  for (const message of messages) collector.add(message);
  return collector.report().lines;
}

/**
 * claude's block shape -- `<sandbox_violations>`, one denial per line, `</sandbox_violations>` --
 * bounded to `VIOLATION_BLOCK_MAX_LINES` lines and `VIOLATION_BLOCK_MAX_BYTES` bytes of them. What is
 * left out is counted honestly: `… N more denials` when every denial was read, `… at least N more
 * denials` (or `… more denials were not read`) when reading stopped at its own cap. No lines, no
 * block (the empty string).
 */
export function formatSandboxViolations(report: SandboxViolationReport): string {
  if (report.lines.length === 0) return "";
  const kept: string[] = [];
  let bytes = 0;
  for (const line of report.lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length >= VIOLATION_BLOCK_MAX_LINES || bytes + size > VIOLATION_BLOCK_MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  const more = report.lines.length - kept.length;
  const tail = report.truncated
    ? more > 0
      ? [`… at least ${more} more denials`]
      : ["… more denials were not read"]
    : more > 0
      ? [`… ${more} more denials`]
      : [];
  return ["<sandbox_violations>", ...kept, ...tail, "</sandbox_violations>"].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The per-command stream
// ---------------------------------------------------------------------------------------------

/** The slice of a child process the monitor uses (a real `ChildProcess`, or a test's fake). */
export interface ViolationStreamProcess {
  pid?: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** How the monitor starts its two helpers. Replaceable for tests only. */
export interface ViolationMonitorSpawners {
  /** Start `log stream` with these arguments, as its own process group. */
  stream(args: readonly string[]): ViolationStreamProcess;
  /** Put one message in the unified log (`logger`); fire and forget. */
  canary(message: string): void;
}

const LOG_BINARY = "/usr/bin/log";
const LOGGER_BINARY = "/usr/bin/logger";

const defaultSpawners: ViolationMonitorSpawners = {
  stream(args) {
    // Through the host child floor like every other host-side helper (`getconf` in spawn.ts).
    const launch = prepareHostChildLaunch(LOG_BINARY, args);
    return spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "ignore"], detached: true });
  },
  canary(message) {
    const launch = prepareHostChildLaunch(LOGGER_BINARY, [message]);
    const child = spawn(launch.command, launch.args, { stdio: "ignore" });
    child.on("error", () => {});
  },
};

let spawners: ViolationMonitorSpawners = defaultSpawners;

/** TEST-ONLY seam: replace how the stream and the canary start. Returns the restore function. */
export function setViolationMonitorSpawnersForTest(replacement: ViolationMonitorSpawners): () => void {
  const previous = spawners;
  spawners = replacement;
  return () => {
    spawners = previous;
  };
}

/** The `log stream` arguments for one command's tag. */
export function logStreamArgsFor(tag: string, lifetimeSeconds: number): string[] {
  return [
    "stream",
    "--style",
    "ndjson",
    "--no-backtrace",
    "--timeout",
    String(Math.max(1, Math.ceil(lifetimeSeconds))),
    "--predicate",
    // diagnosticd is baseline noise that comes in storms (830 of `open -b`'s 1,257 reports): logd drops
    // it before it is ever written to the pipe.
    `(sender == "Sandbox" AND eventMessage ENDSWITH "${tag}" AND NOT (eventMessage CONTAINS "mach-lookup com.apple.diagnosticd")) OR eventMessage == "${tag}-ready"`,
  ];
}

/** A command's live stream: `stop` when the command succeeded (or was interrupted), `drain` when it failed. */
export interface ViolationMonitor {
  readonly tag: string;
  /** Kill the stream now; report nothing. Idempotent. */
  stop(): void;
  /** Collect the trailing denials (quiet window, hard cap), kill the stream, and report. */
  drain(): Promise<SandboxViolationReport>;
}

/**
 * Start `tag`'s stream and resolve once it has echoed its canary -- or `undefined` (stream killed)
 * when it cannot: no `log`, a refusal, `readyTimeoutMs` passed, or `signal` aborted. Never throws.
 * The caller spawns its command only after this resolves, and must `stop` or `drain` the monitor.
 */
export async function startViolationMonitor(
  tag: string,
  opts: { lifetimeSeconds: number; readyTimeoutMs?: number; signal?: AbortSignal },
): Promise<ViolationMonitor | undefined> {
  if (!TAG_SHAPE.test(tag) || opts.signal?.aborted) return undefined;
  const canaryMessage = `${tag}-ready`;
  let proc: ViolationStreamProcess;
  try {
    proc = spawners.stream(logStreamArgsFor(tag, opts.lifetimeSeconds));
  } catch {
    return undefined;
  }
  // WS-24's ledger: an embedded session's host SIGKILLs this group if the Worker dies first.
  let releaseGroup = proc.pid !== undefined ? trackProcessGroup(proc.pid, "command") : () => {};
  const collector = new SandboxViolationCollector(tag);
  let closed = false;
  let killed = false;
  let ready = false;
  let bytes = 0;
  let pending = "";
  let canaryTimer: ReturnType<typeof setInterval> | undefined;
  let onReady: (() => void) | undefined;
  let onActivity: (() => void) | undefined;
  let onClosed: (() => void) | undefined;

  const kill = () => {
    if (canaryTimer !== undefined) clearInterval(canaryTimer);
    canaryTimer = undefined;
    if (killed) return;
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  const markClosed = () => {
    if (closed) return;
    closed = true;
    if (canaryTimer !== undefined) clearInterval(canaryTimer);
    canaryTimer = undefined;
    releaseGroup();
    releaseGroup = () => {};
    onClosed?.();
  };
  proc.once("close", markClosed);
  proc.once("error", markClosed);

  const sendCanary = () => {
    try {
      spawners.canary(canaryMessage);
    } catch {
      /* the next tick tries again; the ready timeout bounds it */
    }
  };
  const handleLine = (line: string) => {
    if (!line.startsWith("{")) return;
    let message: unknown;
    try {
      message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage;
    } catch {
      return;
    }
    if (typeof message !== "string") return;
    if (message === canaryMessage) {
      if (!ready) {
        ready = true;
        if (canaryTimer !== undefined) clearInterval(canaryTimer);
        canaryTimer = undefined;
        onReady?.();
      }
      return;
    }
    if (collector.add(message)) onActivity?.();
  };

  const stdout = proc.stdout;
  if (stdout === null) {
    kill();
    markClosed();
    return undefined;
  }
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (killed) return;
    // The first output (the stream's header) means `log` is up: start the canary, and re-send it until
    // the stream echoes one -- that echo, not the header, is the proof the subscription is live.
    if (canaryTimer === undefined && !ready) {
      sendCanary();
      canaryTimer = setInterval(sendCanary, VIOLATION_CANARY_INTERVAL_MS);
    }
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > VIOLATION_READ_MAX_BYTES) {
      collector.markTruncated();
      kill();
      onActivity?.();
      return;
    }
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      handleLine(line);
    }
  });
  stdout.on("error", () => {});

  const confirmed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settle(false), opts.readyTimeoutMs ?? VIOLATION_STREAM_READY_TIMEOUT_MS);
    const abort = () => settle(false);
    opts.signal?.addEventListener("abort", abort, { once: true });
    function settle(ok: boolean) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      onReady = undefined;
      onClosed = undefined;
      resolve(ok);
    }
    onReady = () => settle(true);
    onClosed = () => settle(false);
    if (ready) settle(true);
    else if (closed) settle(false);
  });
  if (!confirmed) {
    kill();
    return undefined;
  }

  let draining: Promise<SandboxViolationReport> | undefined;
  return {
    tag,
    stop: kill,
    drain() {
      draining ??= new Promise<SandboxViolationReport>((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        let cap: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (quiet !== undefined) clearTimeout(quiet);
          if (cap !== undefined) clearTimeout(cap);
          onActivity = undefined;
          onClosed = undefined;
          kill();
          resolve(collector.report());
        };
        if (closed || killed) return done();
        const arm = () => {
          if (quiet !== undefined) clearTimeout(quiet);
          quiet = setTimeout(done, VIOLATION_DRAIN_QUIET_MS);
        };
        cap = setTimeout(done, VIOLATION_DRAIN_CAP_MS);
        onActivity = () => (killed ? done() : arm());
        onClosed = done;
        arm();
      });
      return draining;
    },
  };
}
