// The `<sandbox_violations>` mechanism, platform-free: the profile tagging, the log-line parsing and
// attribution, the block's bounds, and the per-command stream's lifecycle against a FAKE `log stream`
// (readiness only on the echoed canary, the ready timeout, an abort, the drain window and cap, the read
// cap, the process-group ledger). The real-`sandbox-exec` + real-`log stream` proof lives in
// violations.darwin.test.ts.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { liveProcessGroups } from "../process-groups.ts";
import { buildSeatbeltProfile } from "./profile.ts";
import {
  formatSandboxViolations,
  logStreamArgsFor,
  newSandboxViolationTag,
  parseSandboxViolations,
  SandboxViolationCollector,
  setViolationMonitorSpawnersForTest,
  startViolationMonitor,
  tagSeatbeltDenials,
  VIOLATION_BLOCK_MAX_BYTES,
  VIOLATION_BLOCK_MAX_LINES,
  VIOLATION_DRAIN_CAP_MS,
  VIOLATION_DRAIN_QUIET_MS,
  VIOLATION_READ_MAX_BYTES,
  VIOLATION_TRACKED_MAX_LINES,
  type ViolationStreamProcess,
} from "./violations.ts";

const TAG = "winter-sbx-0123456789abcdef";
const MODIFIER = ` (with message "${TAG}")`;

/** Top-level forms of an SBPL profile, by the same quote-aware reading the tagger uses (test-side copy). */
function topLevelForms(profile: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    const ch = profile[i];
    if (ch === '"') {
      i++;
      while (i < profile.length && profile[i] !== '"') i += profile[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) forms.push(profile.slice(start, i + 1));
    }
  }
  return forms;
}

describe("tagSeatbeltDenials", () => {
  test("every top-level deny form of a real Bash profile gets exactly one modifier; nothing else changes", () => {
    const profile = buildSeatbeltProfile({
      cwd: "/private/tmp/proj (with parens)",
      writableRoots: ["/private/tmp/scratch"],
      denyWritePaths: ["/private/tmp/proj (with parens)/secret \"quoted\""],
      denyReadPaths: ["/private/tmp/other"],
      denyWriteRegexes: ["^/private/tmp/proj/(.*/)?\\.env$"],
      denyWriteGlobFixedPrefixes: ["/private/tmp/proj"],
      allowNetwork: false,
      home: "/Users/someone",
      darwinUserTempDir: "/private/var/folders/xx/T",
    });
    const tagged = tagSeatbeltDenials(profile, TAG);
    expect(tagged).toBeDefined();
    // Removing every modifier gives the original back, byte for byte.
    expect(tagged!.split(MODIFIER).join("")).toBe(profile);
    const before = topLevelForms(profile);
    const after = topLevelForms(tagged!);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.startsWith("(deny")) expect(after[i]).toBe(`${before[i]!.slice(0, -1)}${MODIFIER})`);
      else expect(after[i]).toBe(before[i]!);
    }
    expect(after.some((f) => f.startsWith("(deny default"))).toBe(true);
    expect(after.filter((f) => f.startsWith("(deny")).every((f) => f.endsWith(`${MODIFIER})`))).toBe(true);
    expect(tagged).toContain(`(deny default${MODIFIER})`);
    expect(tagged).toContain(`(deny network*${MODIFIER})`);
  });

  test("a multi-line deny form is tagged at its own closing parenthesis; parentheses inside string and regex literals are not forms", () => {
    const profile = '(version 1)\n(deny default)\n(deny file-write-unlink\n  (literal "/a (b) \\"q\\"")\n  (regex #"^/x/(.*/)?y$"))\n(allow file-read*)\n';
    expect(tagSeatbeltDenials(profile, TAG)).toBe(
      `(version 1)\n(deny default${MODIFIER})\n(deny file-write-unlink\n  (literal "/a (b) \\"q\\"")\n  (regex #"^/x/(.*/)?y$")${MODIFIER})\n(allow file-read*)\n`,
    );
  });

  test("a comment is copied, never read as forms; a form merely starting with `deny...` is not a deny", () => {
    const profile = '; (deny nothing)\n(denyish x)\n(deny network*)\n';
    expect(tagSeatbeltDenials(profile, TAG)).toBe(`; (deny nothing)\n(denyish x)\n(deny network*${MODIFIER})\n`);
  });

  test("a regex literal is RAW, as Seatbelt reads it: parentheses and backslashes inside it are copied, and a `\\\"` inside it means untagged", () => {
    expect(tagSeatbeltDenials('(deny file-read* (regex #"^/a\\(b\\)/(.*)$"))', TAG)).toBe(`(deny file-read* (regex #"^/a\\(b\\)/(.*)$")${MODIFIER})`);
    // Seatbelt ends `#"...` at the first quote, so this profile does not mean what its builder meant.
    expect(tagSeatbeltDenials('(deny file-read* (regex #"^/a\\"b$"))', TAG)).toBeUndefined();
    expect(tagSeatbeltDenials('(deny file-read* (regex #"^/never-closed', TAG)).toBeUndefined();
  });

  test("fails closed to UNTAGGED: an unbalanced profile, an unterminated literal, or a tag that is not a plain token", () => {
    expect(tagSeatbeltDenials("(deny default", TAG)).toBeUndefined();
    expect(tagSeatbeltDenials("(deny default))", TAG)).toBeUndefined();
    expect(tagSeatbeltDenials('(deny file-read* (literal "/x))', TAG)).toBeUndefined();
    expect(tagSeatbeltDenials("(deny default)", 'x") (allow default')).toBeUndefined();
    expect(tagSeatbeltDenials("(deny default)", "")).toBeUndefined();
  });

  test("fresh tags are distinct plain tokens", () => {
    const a = newSandboxViolationTag();
    const b = newSandboxViolationTag();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^winter-sbx-[0-9a-f]{16}$/);
    expect(tagSeatbeltDenials("(deny default)", a)).toBe(`(deny default (with message "${a}"))`);
  });
});

// Shapes measured from the unified log on macOS 26 (paths sanitised): `eventMessage` is the kernel's
// report, then a newline, then the profile's `(with message ...)` text.
const m = (body: string, tag = TAG) => `${body}\n${tag}`;

describe("parseSandboxViolations", () => {
  test("only this tag's reports count; pid and duplicate-report prefixes go; repeats collapse in order", () => {
    const lines = parseSandboxViolations(
      [
        m("Sandbox: open(65502) deny(1) mach-lookup com.apple.lsd.mapdb"),
        m("Sandbox: open(65502) deny(1) mach-lookup com.apple.lsd.modifydb"),
        m("409 duplicate reports for Sandbox: open(65502) deny(1) mach-lookup com.apple.lsd.modifydb"),
        m("Sandbox: bash(65499) deny(1) file-write-create /private/var/folders/xx/T/proj/denied/x.txt"),
        m("Sandbox: nc(65549) deny(1) network-outbound remote:*:9"),
        m("1 duplicate report for Sandbox: nc(65550) deny(1) network-outbound remote:*:9"),
        // Another command's denial (a different tag), and an untagged report: never this command's.
        m("Sandbox: bash(1) deny(1) file-write-create /elsewhere", "winter-sbx-ffffffffffffffff"),
        "Sandbox: bash(2) deny(1) file-write-create /untagged",
        // `log` logs its own invocation, predicate included -- no newline-tag suffix, never a denial.
        `log run noninteractively, parent: 1 (bun), args: '/usr/bin/log' 'show' '--predicate' 'eventMessage ENDSWITH "${TAG}"'`,
      ],
      TAG,
    );
    expect(lines).toEqual([
      "open deny(1) mach-lookup com.apple.lsd.mapdb",
      "open deny(1) mach-lookup com.apple.lsd.modifydb",
      "bash deny(1) file-write-create /private/var/folders/xx/T/proj/denied/x.txt",
      "nc deny(1) network-outbound remote:*:9",
    ]);
  });

  test("the measured start-up denials every sandboxed process makes are dropped -- a failure with only those has no violations", () => {
    const baseline = [
      'Sandbox: bash(1) deny(1) file-ioctl path:/dev/dtracehelper ioctl-command:(_IO "h" 4)',
      "Sandbox: bash(1) deny(1) file-write-data /dev/tty",
      "Sandbox: bash(1) deny(1) ipc-posix-shm-read-data apple.shm.notification_center",
      "3 duplicate reports for Sandbox: bash(1) deny(1) ipc-posix-shm-read-data apple.shm.notification_center",
      "Sandbox: git(2) deny(1) mach-lookup com.apple.system.opendirectoryd.libinfo",
      "Sandbox: git(2) deny(1) mach-lookup com.apple.system.opendirectoryd.membership",
      "Sandbox: git(2) deny(1) mach-lookup com.apple.logd",
      "Sandbox: open(3) deny(1) mach-lookup com.apple.diagnosticd",
      "Sandbox: open(3) deny(1) mach-lookup com.apple.analyticsd",
    ].map((b) => m(b));
    expect(parseSandboxViolations(baseline, TAG)).toEqual([]);
    expect(parseSandboxViolations([...baseline, m("Sandbox: open(3) deny(1) mach-lookup com.apple.lsd.mapdb")], TAG)).toEqual(["open deny(1) mach-lookup com.apple.lsd.mapdb"]);
  });

  test("a process name with spaces or parentheses keeps its name; anything not shaped like a denial report is ignored", () => {
    expect(
      parseSandboxViolations(
        [
          m("Sandbox: Google Chrome Helper (Renderer)(77) deny(1) mach-lookup com.apple.windowserver.active"),
          m("Sandbox: something unexpected"),
          m(""),
        ],
        TAG,
      ),
    ).toEqual(["Google Chrome Helper (Renderer) deny(1) mach-lookup com.apple.windowserver.active"]);
  });
});

describe("SandboxViolationCollector", () => {
  test(`keeps at most ${VIOLATION_TRACKED_MAX_LINES} distinct denials and says when it stopped`, () => {
    const collector = new SandboxViolationCollector(TAG);
    for (let i = 0; i < VIOLATION_TRACKED_MAX_LINES + 5; i++) expect(collector.add(m(`Sandbox: bash(1) deny(1) file-write-create /x/${i}`))).toBe(true);
    expect(collector.add(m("Sandbox: bash(1) deny(1) file-write-data /dev/tty"))).toBe(true); // baseline is still this command's activity
    expect(collector.add(m("Sandbox: bash(1) deny(1) file-write-create /x/0", "winter-sbx-ffffffffffffffff"))).toBe(false);
    const report = collector.report();
    expect(report.lines).toHaveLength(VIOLATION_TRACKED_MAX_LINES);
    expect(report.truncated).toBe(true);
  });
});

describe("formatSandboxViolations", () => {
  const all = (lines: string[]) => ({ lines, truncated: false });

  test("claude's shape; no lines, no block", () => {
    expect(formatSandboxViolations(all([]))).toBe("");
    expect(formatSandboxViolations({ lines: [], truncated: true })).toBe("");
    expect(formatSandboxViolations(all(["open deny(1) mach-lookup com.apple.lsd.mapdb"]))).toBe(
      "<sandbox_violations>\nopen deny(1) mach-lookup com.apple.lsd.mapdb\n</sandbox_violations>",
    );
  });

  test(`at most ${VIOLATION_BLOCK_MAX_LINES} lines, the rest counted exactly`, () => {
    const lines = Array.from({ length: VIOLATION_BLOCK_MAX_LINES + 7 }, (_, i) => `bash deny(1) file-write-create /x/${i}`);
    const block = formatSandboxViolations(all(lines)).split("\n");
    expect(block[0]).toBe("<sandbox_violations>");
    expect(block.at(-1)).toBe("</sandbox_violations>");
    expect(block.slice(1, -2)).toEqual(lines.slice(0, VIOLATION_BLOCK_MAX_LINES));
    expect(block.at(-2)).toBe("… 7 more denials");
  });

  test(`at most ${VIOLATION_BLOCK_MAX_BYTES} bytes of lines, the rest counted exactly`, () => {
    const lines = Array.from({ length: 5 }, (_, i) => `bash deny(1) file-write-create /${String(i).repeat(1500)}`);
    const block = formatSandboxViolations(all(lines));
    const kept = block.split("\n").slice(1, -2);
    expect(kept).toEqual(lines.slice(0, 2));
    expect(Buffer.byteLength(kept.join("\n"), "utf8")).toBeLessThanOrEqual(VIOLATION_BLOCK_MAX_BYTES);
    expect(block.endsWith("… 3 more denials\n</sandbox_violations>")).toBe(true);
  });

  test("when reading stopped at its own cap the count is a floor, never a claim of completeness", () => {
    const lines = Array.from({ length: VIOLATION_BLOCK_MAX_LINES + 2 }, (_, i) => `bash deny(1) file-write-create /x/${i}`);
    expect(formatSandboxViolations({ lines, truncated: true }).split("\n").at(-2)).toBe("… at least 2 more denials");
    expect(formatSandboxViolations({ lines: lines.slice(0, 1), truncated: true }).split("\n").at(-2)).toBe("… more denials were not read");
  });
});

// --- the per-command stream, against a fake `log stream` ------------------------------------------

class FakeStream extends EventEmitter implements ViolationStreamProcess {
  static nextPid = 900_000;
  readonly pid = FakeStream.nextPid++;
  readonly stdout = new PassThrough();
  killedWith: NodeJS.Signals | number | undefined;
  closed = false;
  readonly args: readonly string[];
  constructor(args: readonly string[]) {
    super();
    this.args = args;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal ?? "SIGTERM";
    this.close();
    return true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      this.stdout.end();
      this.emit("close");
    });
  }
  line(eventMessage: string): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify({ eventMessage, senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox" })}\n`);
  }
}

/** A fake `log` whose header arrives at once and which echoes canary number `echoOn` (1-based) after `delayMs`. */
function fakeLog(opts: { echoOn?: number; delayMs?: number; header?: boolean } = {}) {
  const streams: FakeStream[] = [];
  let canaries = 0;
  const restore = setViolationMonitorSpawnersForTest({
    stream(args) {
      const stream = new FakeStream(args);
      streams.push(stream);
      if (opts.header !== false) setImmediate(() => stream.stdout.write('Filtering the log data using "..."\n'));
      return stream;
    },
    canary(message) {
      canaries++;
      if (opts.echoOn !== undefined && canaries === opts.echoOn) setTimeout(() => streams.at(-1)!.line(message), opts.delayMs ?? 0);
    },
  });
  return { streams, canaries: () => canaries, restore };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startViolationMonitor", () => {
  test("the stream's header is NOT readiness: the command may start only once a canary came back -- re-sent until one does", async () => {
    const log = fakeLog({ echoOn: 3 });
    try {
      const started = performance.now();
      const monitor = await startViolationMonitor(TAG, { lifetimeSeconds: 7 });
      expect(monitor).toBeDefined();
      expect(log.canaries()).toBeGreaterThanOrEqual(3); // the first two were never echoed
      expect(performance.now() - started).toBeGreaterThanOrEqual(90);
      expect(log.streams[0]!.args).toEqual(logStreamArgsFor(TAG, 7));
      monitor!.stop();
      expect(log.streams[0]!.killedWith).toBe("SIGKILL");
    } finally {
      log.restore();
    }
  });

  test("no canary within the ready timeout, an abort, a stream that dies, or a failing spawn: undefined, and nothing left running", async () => {
    let log = fakeLog({});
    try {
      expect(await startViolationMonitor(TAG, { lifetimeSeconds: 7, readyTimeoutMs: 80 })).toBeUndefined();
      expect(log.streams[0]!.killedWith).toBe("SIGKILL");
    } finally {
      log.restore();
    }
    log = fakeLog({});
    try {
      const turn = new AbortController();
      const pending = startViolationMonitor(TAG, { lifetimeSeconds: 7, readyTimeoutMs: 5_000, signal: turn.signal });
      setTimeout(() => turn.abort(), 20);
      const started = performance.now();
      expect(await pending).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(log.streams[0]!.killedWith).toBe("SIGKILL");
      expect(await startViolationMonitor(TAG, { lifetimeSeconds: 7, signal: turn.signal })).toBeUndefined(); // already aborted: no stream at all
      expect(log.streams).toHaveLength(1);
    } finally {
      log.restore();
    }
    log = fakeLog({});
    try {
      const pending = startViolationMonitor(TAG, { lifetimeSeconds: 7, readyTimeoutMs: 5_000 });
      setTimeout(() => log.streams[0]!.close(), 20); // `log` refused (non-admin) and exited
      expect(await pending).toBeUndefined();
    } finally {
      log.restore();
    }
    const restore = setViolationMonitorSpawnersForTest({
      stream() {
        throw new Error("spawn failed");
      },
      canary() {},
    });
    try {
      expect(await startViolationMonitor(TAG, { lifetimeSeconds: 7 })).toBeUndefined();
    } finally {
      restore();
    }
    expect(await startViolationMonitor("not a tag!", { lifetimeSeconds: 7 })).toBeUndefined();
  });

  test("the stream is in the process-group ledger exactly while it lives", async () => {
    const log = fakeLog({ echoOn: 1 });
    try {
      const monitor = await startViolationMonitor(TAG, { lifetimeSeconds: 7 });
      const pid = log.streams[0]!.pid;
      expect(liveProcessGroups().some((g) => g.pgid === pid)).toBe(true);
      monitor!.stop();
      await sleep(20);
      expect(liveProcessGroups().some((g) => g.pgid === pid)).toBe(false);
    } finally {
      log.restore();
    }
  });

  test(`drain: waits while this command's lines keep coming (${VIOLATION_DRAIN_QUIET_MS} ms quiet), never past ${VIOLATION_DRAIN_CAP_MS} ms, then kills`, async () => {
    const log = fakeLog({ echoOn: 1 });
    try {
      const monitor = await startViolationMonitor(TAG, { lifetimeSeconds: 7 });
      const stream = log.streams[0]!;
      stream.line(m("Sandbox: bash(1) deny(1) file-write-create /a"));
      stream.line(m("Sandbox: bash(1) deny(1) file-write-create /other", "winter-sbx-ffffffffffffffff"));
      // Quiet window: one late line at +60 ms extends it; done ~100 ms after that.
      setTimeout(() => stream.line(m("Sandbox: bash(1) deny(1) file-write-create /late")), 60);
      const started = performance.now();
      const report = await monitor!.drain();
      const took = performance.now() - started;
      expect(report).toEqual({ lines: ["bash deny(1) file-write-create /a", "bash deny(1) file-write-create /late"], truncated: false });
      expect(took).toBeGreaterThanOrEqual(150);
      expect(took).toBeLessThan(VIOLATION_DRAIN_CAP_MS + 100);
      expect(stream.killedWith).toBe("SIGKILL");
      expect(await monitor!.drain()).toEqual(report); // idempotent
    } finally {
      log.restore();
    }
  });

  test("drain is hard-capped even while denials keep arriving", async () => {
    const log = fakeLog({ echoOn: 1 });
    try {
      const monitor = await startViolationMonitor(TAG, { lifetimeSeconds: 7 });
      const stream = log.streams[0]!;
      let n = 0;
      const storm = setInterval(() => stream.line(m(`Sandbox: open(1) deny(1) mach-lookup com.apple.lsd.modifydb ${n++}`)), 10);
      const started = performance.now();
      await monitor!.drain();
      clearInterval(storm);
      expect(performance.now() - started).toBeLessThan(VIOLATION_DRAIN_CAP_MS + 100);
    } finally {
      log.restore();
    }
  });

  test(`reading stops at ${VIOLATION_READ_MAX_BYTES} bytes: the stream is killed and the report says it is incomplete`, async () => {
    const log = fakeLog({ echoOn: 1 });
    try {
      const monitor = await startViolationMonitor(TAG, { lifetimeSeconds: 7 });
      const stream = log.streams[0]!;
      stream.line(m("Sandbox: open(1) deny(1) mach-lookup com.apple.lsd.mapdb"));
      const filler = m(`Sandbox: open(1) deny(1) mach-lookup com.apple.lsd.modifydb ${"x".repeat(4_000)}`);
      for (let written = 0; written <= VIOLATION_READ_MAX_BYTES; written += filler.length) stream.line(filler);
      await sleep(20);
      expect(stream.killedWith).toBe("SIGKILL");
      const report = await monitor!.drain();
      expect(report.truncated).toBe(true);
      expect(report.lines[0]).toBe("open deny(1) mach-lookup com.apple.lsd.mapdb");
    } finally {
      log.restore();
    }
  });

  test("the stream's own lifetime and filter: --timeout, this tag, the canary, diagnosticd dropped in logd", () => {
    const args = logStreamArgsFor(TAG, 12.2);
    expect(args.slice(0, 6)).toEqual(["stream", "--style", "ndjson", "--no-backtrace", "--timeout", "13"]);
    expect(args.at(-1)).toBe(
      `(sender == "Sandbox" AND eventMessage ENDSWITH "${TAG}" AND NOT (eventMessage CONTAINS "mach-lookup com.apple.diagnosticd")) OR eventMessage == "${TAG}-ready"`,
    );
  });
});
