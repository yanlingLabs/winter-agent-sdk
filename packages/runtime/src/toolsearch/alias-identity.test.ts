// Phase 4 fix wave, LANE Y -- RULING P4-E AMENDED (alias-aware permission identity, 2026-09-04).
//
// The whole-branch review's CRITICAL C2: with `disallowedTools: ["SendMessage"]`, duplicate
// suppression stopped firing (it keyed on the NATIVE name being advertised, and a denied name is
// unadvertised), so `mcp__winter__send_message` -- the SAME executor object under the canonical
// spelling -- surfaced EAGER in `system/init.tools` and executed with no deny/hook match at all.
// Probe-confirmed against `9c41d49`, on by default, with zero host configuration.
//
// The amendment this file pins, verbatim: "permission identity is alias-aware in both directions --
// a rule naming either spelling governs both, hooks match both -- and a canonical twin is hidden
// (never eager, never searchable, refused at dispatch with the deny reason) whenever its native is
// denied or excluded. Dispatch still never redirects: the unresolved call name drives lookup,
// execution and load-first."
//
// It also lands the T8 review's M2 (here called B-M2): the alias deviation's OWN safety property --
// that `disallowedTools: ["SendMessage"]` keeps matching -- had no test anywhere in the repo, so
// nothing failed if a future task folded the default canonical table into identity resolution. It
// does now.
//
// Why this file and not engine.test.ts: these are wire-level assertions about the ALIAS surface
// (`toolsearch/aliases.ts` + `toolsearch/exposure.ts` and their two engine call sites), so they live
// with the mechanism they pin. `drain`/`dataMessages`/`baseConfig` are deliberately minimal local
// copies of engine.test.ts's own (there is no shared runtime test-helper module in this package; the
// alternative is a cross-test-file import, which this repo's own createFakeChildHandle relocation
// item exists to discourage).
import { test, expect, describe } from "bun:test";
import type { RuntimeConfig, WinterFrame, ControlRequestFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { echoProvider, scriptedProvider } from "../provider/mock.ts";
import "../tools/impl/index.ts"; // the messaging executors must be registered for winter.global-messaging to derive
import { computeExposurePartition } from "./exposure.ts";
import { WINTER_CANONICAL_ALIASES } from "./aliases.ts";

const NATIVE = "SendMessage";
const TWIN = "mcp__winter__send_message";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

// Answers every hook control_request with an empty (no-opinion) payload and records which events
// were asked about -- enough to prove a MATCHER fired without also asserting a decision.
async function drainRecordingHooks(
  host: { input: AsyncIterable<WinterFrame>; output: { write(f: WinterFrame): void } },
  seen: Array<{ event: string; toolName: string | undefined }>,
): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of host.input) {
    out.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string; toolName?: string; tool_name?: string };
      seen.push({ event: payload.event, toolName: payload.toolName ?? payload.tool_name });
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
    }
  }
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "alias-identity",
  cwd: "/tmp/winter-alias-identity",
  model: "sonnet",
  ...overrides,
});

async function initTools(overrides: Partial<RuntimeConfig> = {}): Promise<string[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(overrides), input: runtime.input, output: runtime.output, provider: echoProvider });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  const init = frames.find((f) => f.type === "init") as { tools: string[] } | undefined;
  return init?.tools ?? [];
}

interface CallOutcome {
  denied: { tool_name?: string; decision_reason_type?: string } | undefined;
  toolResultsJson: string;
}

// Drives ONE scripted tool call through a real runEngine under `dontAsk` -- the same discriminating
// device engine.test.ts's own rider-3 pair uses: an UNMATCHED call is denied by the mode floor
// (`decision_reason_type: "mode"`), so only a genuine RULE match can produce `"rule"`.
async function callOnce(name: string, overrides: Partial<RuntimeConfig> = {}): Promise<CallOutcome> {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name, input: { to: "nobody-here", message: "hi" } }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig({ permissionMode: "dontAsk", ...overrides }), input: runtime.input, output: runtime.output, provider });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  const denied = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
    | { tool_name?: string; decision_reason_type?: string }
    | undefined;
  return { denied, toolResultsJson: JSON.stringify(dataMessages(frames).filter((m) => m.type === "user")) };
}

describe("RULING P4-E amended: alias-aware permission identity (whole-branch C2 + T8 review M2)", () => {
  // --- The control: nothing denied, the pre-amendment behaviour is untouched --------------------

  test("control: with nothing denied, the model sees ONE SendMessage and never the canonical twin", async () => {
    const tools = await initTools();
    expect(tools).toContain(NATIVE);
    expect(tools).not.toContain(TWIN);
    expect(tools).toContain("ListAgents");
    expect(tools).not.toContain("mcp__winter__list_agents");
  });

  // --- C2 part 1: the twin is HIDDEN whenever its native is denied ------------------------------

  test("C2: `disallowedTools: [\"SendMessage\"]` removes BOTH spellings from init.tools", async () => {
    const tools = await initTools({ disallowedTools: [NATIVE] });
    expect(tools).not.toContain(NATIVE);
    // THE C2 ASSERTION. Pre-fix this was `true`: suppression keyed on the native being advertised,
    // so denying it made the canonical twin surface EAGER (probe 1, whole-branch review appendix A).
    expect(tools, "the canonical twin must not surface when its native spelling is denied").not.toContain(TWIN);
  });

  test("C2: the same holds for the ListAgents pair", async () => {
    const tools = await initTools({ disallowedTools: ["ListAgents"] });
    expect(tools).not.toContain("ListAgents");
    expect(tools).not.toContain("mcp__winter__list_agents");
  });

  test("C2: a denied native also removes the twin from ToolSearch's own candidate pool", () => {
    const query = {
      mode: "default" as const,
      activation: { enableToolSearch: "true" as const, providerSupportsToolSearch: true, deferrableContextShare: 0 },
      capabilities: ["winter.subagents", "winter.global-messaging"],
      disallowedTools: [NATIVE],
    };
    const partition = computeExposurePartition(query);
    const searchable = [...partition.eager, ...partition.deferred].map((d) => d.canonicalName);
    expect(searchable).not.toContain(NATIVE);
    // Pre-fix the twin sat in `deferred` -- i.e. `select:mcp__winter__send_message` returned it and
    // the model could load and call a tool the host had explicitly denied.
    expect(searchable, "a denied native's twin must not be searchable either").not.toContain(TWIN);
    expect(partition.hidden.map((d) => d.canonicalName)).toContain(TWIN);

    // ...and with nothing denied it stays searchable, exactly as WS-09 §10 requires ("keeps the
    // canonical entry deferred", not hidden).
    const open = computeExposurePartition({ ...query, disallowedTools: [] });
    expect([...open.eager, ...open.deferred].map((d) => d.canonicalName)).toContain(TWIN);
  });

  // --- C2 part 2: identity is alias-aware in BOTH directions ------------------------------------

  test("C2: a call to the twin is REFUSED with the native's deny reason, and never executes", async () => {
    const { denied, toolResultsJson } = await callOnce(TWIN, { disallowedTools: [NATIVE] });
    expect(denied).toBeDefined();
    // "rule", not "mode": only a real rule match can produce it, and the ONLY rule configured names
    // the NATIVE spelling the model never emitted.
    expect(denied!.decision_reason_type).toBe("rule");
    // The model-facing report still names the tool the MODEL called (P4-E: no redirection).
    expect(denied!.tool_name).toBe(TWIN);
    // The messaging executor answers with an `outcome` object; its absence proves nothing ran.
    expect(toolResultsJson).not.toContain("outcome");
  });

  test("B-M2: `disallowedTools: [\"SendMessage\"]` still matches a call to SendMessage itself (the deviation's own safety property)", async () => {
    const { denied, toolResultsJson } = await callOnce(NATIVE, { disallowedTools: [NATIVE] });
    expect(denied).toBeDefined();
    expect(denied!.decision_reason_type).toBe("rule");
    expect(denied!.tool_name).toBe(NATIVE);
    expect(toolResultsJson).not.toContain("outcome");
  });

  test("C2: a rule naming the TWIN governs the native spelling too", async () => {
    const { denied, toolResultsJson } = await callOnce(NATIVE, { disallowedTools: [TWIN] });
    expect(denied).toBeDefined();
    expect(denied!.decision_reason_type).toBe("rule");
    expect(toolResultsJson).not.toContain("outcome");
    // ...and it gates ADVERTISEMENT of the native as well (T8-review M6's second door).
    expect(await initTools({ disallowedTools: [TWIN] })).not.toContain(NATIVE);
  });

  test("C2: a PreToolUse matcher on the NATIVE spelling fires for a call to the twin", async () => {
    const seen: Array<{ event: string; toolName: string | undefined }> = [];
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: TWIN, input: { to: "nobody-here", message: "hi" } }] },
      { kind: "text", text: "done" },
    ]);
    const config = baseConfig({ permissionMode: "dontAsk", hooks: { PreToolUse: [{ hookCount: 1, source: "sdk", matcher: NATIVE }] } });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    await drainRecordingHooks(host, seen);
    await done;
    expect(seen.filter((s) => s.event === "PreToolUse").length, "a matcher on the native spelling must fire for the canonical twin").toBeGreaterThan(0);
  });

  test("C2 control: a PreToolUse matcher on an UNRELATED name never fires for the twin", async () => {
    const seen: Array<{ event: string; toolName: string | undefined }> = [];
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: TWIN, input: { to: "nobody-here", message: "hi" } }] },
      { kind: "text", text: "done" },
    ]);
    const config = baseConfig({ permissionMode: "dontAsk", hooks: { PreToolUse: [{ hookCount: 1, source: "sdk", matcher: "Read" }] } });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    await drainRecordingHooks(host, seen);
    await done;
    expect(seen.filter((s) => s.event === "PreToolUse").length).toBe(0);
  });

  // --- P4-E's unchanged half: dispatch NEVER redirects -------------------------------------------

  test("P4-E unchanged: the unresolved call name still drives execution -- the twin runs the messaging executor under its own name", async () => {
    const { denied, toolResultsJson } = await callOnce(TWIN, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    expect(denied).toBeUndefined();
    // Executed for real (the messaging runtime's own `not_found` outcome for an unknown addressee) --
    // proof the call was never rewritten to the native name or refused at lookup.
    expect(toolResultsJson).toContain("outcome");
    expect(toolResultsJson).not.toContain("unknown tool");
  });

  test("the default canonical table is a single exported constant, not a per-file copy", () => {
    expect(WINTER_CANONICAL_ALIASES[NATIVE]).toBe(TWIN);
    expect(WINTER_CANONICAL_ALIASES["ListAgents"]).toBe("mcp__winter__list_agents");
  });
});
