// GATED — never runs in ordinary CI (needs the ~200MB darwin-arm64/linux-x64 native optional
// package and network egress). Behind RUN_OFFICIAL_CAPTURE=1 only.
//
// Procedure (WS-17 §4, report §5 probe): checksum-verify + ephemerally install
// @anthropic-ai/claude-agent-sdk@0.3.250 into a throwaway npm prefix, run its own real query()
// against a loopback HTTP server that returns ONE canned Anthropic-shaped Messages API response,
// capture the yielded SDK message stream, normalizeTrace() it, and PRINT the result — never write a
// golden file, never auto-compare against the winter golden, never auto-commit anything. A human
// (the controller) diffs the printed output against packages/conformance/goldens/plain-query.trace.json
// by eye. This is the project's first real official-vs-winter differential signal, not a pass/fail gate.
//
// Hermeticity (hard rule, non-negotiable): the official runtime must never read or write the real
// ~/.claude (or ~/.winter/~/.norma). Achieved by handing it the MINIMAL env an empirical probe
// proved sufficient — exactly {ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR} with NO
// process.env spread — plus settingSources: [] (reads no real settings.json at any level) and a
// fresh mkdtemp cwd. Every request the official runtime makes is logged to stderr below as direct
// evidence that the loopback is the only endpoint it ever contacts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAndVerifyUpstream } from "./fetch-upstream.ts";
import { normalizeTrace, type ConformanceTraceEntry } from "winter-conformance/trace";

const CANNED_RESPONSE = {
  id: "msg_capture_canned_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "echo: hi" }], // mirrors winter's own echoProvider convention —
  // maximizes how directly the printed output lines up against the winter plain-query golden.
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

async function runCapture(): Promise<void> {
  // 1. Checksum-verified ephemeral install (same contract as compile-official-fixture.ts: sha256 +
  //    the Task-11 sha512 integrity pin, both re-verified here, never trusted from an earlier step).
  const { tarballPath, ownedDir } = await fetchAndVerifyUpstream();
  const npmPrefix = mkdtempSync(join(tmpdir(), "winter-official-capture-"));
  const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-"));
  const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-"));
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const install = Bun.spawn(
      ["npm", "install", "--no-save", "--ignore-scripts", "--prefix", npmPrefix, tarballPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const installOut = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
    if ((await install.exited) !== 0) {
      throw new Error(`npm install --prefix ${npmPrefix} failed:\n${installOut}`);
    }

    const officialPkgDir = join(npmPrefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const officialPkgJson = JSON.parse(readFileSync(join(officialPkgDir, "package.json"), "utf8")) as { main?: string };
    if (!officialPkgJson.main) throw new Error("installed @anthropic-ai/claude-agent-sdk package.json has no \"main\" field");
    const entryPath = join(officialPkgDir, officialPkgJson.main);
    const officialSdk = (await import(entryPath)) as { query: (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<{ type: string; subtype?: string }> };

    // 2. Loopback: ONE canned response for every request, whatever the method/path/body — proven
    //    sufficient by direct probing (the official runtime issues more than one HTTP call for even
    //    a trivial single-turn prompt; the SAME static response satisfies every one of them and the
    //    yielded SDK message stream still comes out exactly right). Every request is logged to
    //    stderr — this log IS the hermeticity evidence: nothing else is ever contacted.
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        console.error(`[loopback] #${requestCount} ${req.method} ${url.pathname}${url.search} host=${req.headers.get("host")}`);
        return new Response(JSON.stringify(CANNED_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    console.error(`[capture] loopback listening on ${server.url.href} (the ONLY endpoint the official runtime is given)`);
    console.error(`[capture] CLAUDE_CONFIG_DIR=${claudeConfigDir} (fresh mkdtemp — never the real ~/.claude)`);

    // 3. The official SDK's own query(), hermetically configured.
    const entries: ConformanceTraceEntry[] = [];
    let thrown: unknown;
    try {
      const q = officialSdk.query({
        prompt: "hi",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [], // reads no real user/project/local settings.json (WS-03 §5-adjacent)
          env: {
            // Deliberately NOT a process.env spread — an empirical probe (this task's report)
            // proved the official runtime needs nothing else to complete a full turn.
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
          },
        },
      });
      for await (const msg of q) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: msg.type === "system" ? `system/${msg.subtype}` : msg.type, payload: msg });
      }
    } catch (e) {
      thrown = e;
    }

    console.error(`[capture] official runtime made ${requestCount} request(s) to the loopback; ${entries.length} message(s) yielded`);
    if (thrown) console.error(`[capture] query() threw: ${thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)}`);

    const normalized = normalizeTrace(entries);
    console.log(JSON.stringify(normalized, null, 2));
  } finally {
    server?.stop(true);
    rmSync(npmPrefix, { recursive: true, force: true });
    rmSync(claudeConfigDir, { recursive: true, force: true });
    rmSync(fixtureCwd, { recursive: true, force: true });
    // Guard (Task 11): fetchAndVerifyUpstream() above never passed a cacheDir, so ownedDir is
    // always true here — keyed off it anyway, matching every other caller in this task.
    if (ownedDir) rmSync(dirname(tarballPath), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    console.log("capture-official-golden: skipped (set RUN_OFFICIAL_CAPTURE=1 to run — ephemeral, network-using, not part of default CI)");
    process.exit(0);
  }
  await runCapture();
}
