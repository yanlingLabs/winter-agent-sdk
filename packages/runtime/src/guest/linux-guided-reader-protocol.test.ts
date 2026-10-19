import { expect, test } from "bun:test";
import { WINTER_BRAND, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxGuidedHostQueryConfig, assertLinuxGuidedHostQueryRoots } from "./linux-guided-host-query-profile.ts";
import { assertLinuxHostQueryConfig } from "./linux-host-query-profile.ts";
import { decodeLinuxGuidedReaderFrame, linuxGuidedReaderStart, linuxGuidedReaderCancel, LINUX_GUIDED_READER_BODY_BYTES, LINUX_GUIDED_READER_LIMITS,
  parseLinuxGuidedReaderMessage, parseLinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const readId = uuid(3);
function fixture() {
  const registration = { version: 1 as const, registrationId: uuid(1),
    owner: { workspaceId: "workspace", logicalSessionId: "logical", backendSessionId: "backend", incarnationId: "incarnation", leaseEpoch: 1, bootId: uuid(9), generation: 1 },
    views: { sourceRoot: "/workspace/folders/source", sourceCwd: "/workspace/folders/source/nested", sharedRoot: "/run/winter/shared-instructions" as const, sharedPath: "/run/winter/shared-instructions/WINTER.md" as const },
    limits: { ...LINUX_GUIDED_READER_LIMITS }, requiredRuntimeContext: { version: 1 as const, bindingId: uuid(2) } };
  const config: RuntimeConfig = { executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: registration.views.sourceCwd,
    winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true,
    tools: ["Read", "Write", "Edit", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true,
    mcpServers: {}, permissionMode: "default", permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false,
    requiredRuntimeContext: { ...registration.requiredRuntimeContext } };
  const { workspaceId: _workspaceId, ...innerOwner } = registration.owner;
  const inner = { version: 1, readId, owner: innerOwner, views: registration.views, limits: registration.limits,
    snapshot: { blocks: [], digest: "fixture", droppedImports: [], files: [], provenance: [], skippedLinks: [], text: "guidance", tiers: "admitted-only" } };
  const result = { version: 1 as const, kind: "reader_result" as const, registrationId: uuid(1), readId, owner: { ...registration.owner }, frame: `${JSON.stringify(inner)}\n` };
  const terminal = { version: 1 as const, kind: "reader_terminal" as const, registrationId: uuid(1), readId, owner: { ...registration.owner },
    outcome: "ok" as const, namespaceInitReaped: true, monitorReaped: true, namespaceWaitStatus: 0, monitorWaitStatus: 0,
    stdoutEof: true, stderrEof: true, captureDrained: true };
  return { registration, config, result, terminal };
}
function wire(text: string): Uint8Array { const body = Buffer.from(text), frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame; }

test("registration copies and freezes correlation, exact views and pre-read budgets without creating authority", () => {
  const f = fixture(), fixed = parseLinuxGuidedReaderRegistration(f.registration);
  f.registration.owner.generation = 99; f.registration.views.sourceCwd = "/foreign"; f.registration.limits.maxReadBytes = 1;
  expect(fixed.owner.generation).toBe(1); expect(fixed.views.sourceCwd).toBe("/workspace/folders/source/nested");
  expect(fixed.limits.maxReadBytes).toBe(256 * 1024);
  for (const part of [fixed, fixed.owner, fixed.views, fixed.limits, fixed.requiredRuntimeContext]) expect(Object.isFrozen(part)).toBe(true);
  expect(Reflect.set(fixed.owner, "generation", 2)).toBe(false);
});

test("guided native wire retains Winter's exact instruction view and refuses alternate branded filenames", () => {
  const { registration, config } = fixture();
  expect(parseLinuxGuidedReaderRegistration(registration).views.sharedPath).toBe("/run/winter/shared-instructions/WINTER.md");
  for (const sharedPath of ["/run/winter/shared-instructions/ACME.md", "/run/winter/shared-instructions/CLAUDE.md", "/run/winter/shared-instructions/WINTER.local.md"]) {
    expect(() => parseLinuxGuidedReaderRegistration({ ...registration, views: { ...registration.views, sharedPath } })).toThrow("required_context_unavailable");
  }
  // This closed native profile has no caller-selected brand or alternate instruction path.
  expect(() => assertLinuxGuidedHostQueryConfig({ ...config, brand: { ...WINTER_BRAND, instructionsFile: "ACME.md" } }, registration)).toThrow();
});

test("registration refuses foreign views, widened budgets, executable options and accessors before any callback", () => {
  const f = fixture();
  for (const value of [
    { ...f.registration, version: 2 }, { ...f.registration, channelFd: 7 }, { ...f.registration, registrationId: "shape" },
    { ...f.registration, owner: { ...f.registration.owner, generation: 0 } }, { ...f.registration, owner: { ...f.registration.owner, agentId: "child" } },
    { ...f.registration, views: { ...f.registration.views, sourceRoot: "/workspace/.winter" } },
    { ...f.registration, views: { ...f.registration.views, sourceCwd: "/workspace/folders/source-foreign" } },
    { ...f.registration, views: { ...f.registration.views, sourceCwd: "/workspace/folders/source/../private" } },
    { ...f.registration, views: { ...f.registration.views, sharedRoot: "/workspace/.winter" } },
    { ...f.registration, views: { ...f.registration.views, sharedPath: "/workspace/.winter/WINTER.md" } },
    { ...f.registration, limits: { ...f.registration.limits, maxReadBytes: 256 * 1024 + 1 } },
    { ...f.registration, limits: { ...f.registration.limits, maxFileBytes: undefined } },
    { ...f.registration, requiredRuntimeContext: { version: 1, bindingId: "not-query-uuid" } },
    Object.assign(Object.create({}), f.registration),
  ]) expect(() => parseLinuxGuidedReaderRegistration(value)).toThrow();
  let calls = 0; const value = { ...f.registration };
  Object.defineProperty(value, "owner", { get() { calls++; throw new Error("must not inspect owner"); } });
  expect(() => parseLinuxGuidedReaderRegistration(value)).toThrow(); expect(calls).toBe(0);
});

test("guided policy preserves v1 permission clamps and never widens sources or admits child/cold configuration", () => {
  const { config, registration } = fixture(), roots = [{ id: "source", guestPath: registration.views.sourceRoot, readOnly: false }];
  expect(() => assertLinuxGuidedHostQueryRoots(config, roots, registration)).not.toThrow();
  expect(() => assertLinuxHostQueryConfig(config)).toThrow();
  for (const permissionMode of ["default", "plan"] as const) {
    const own = { ...config, permissionMode, permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false };
    expect(() => assertLinuxGuidedHostQueryConfig(own, registration)).not.toThrow();
    expect(() => assertLinuxGuidedHostQueryConfig({ ...own, allowDangerouslySkipPermissions: true }, registration)).toThrow();
    expect(() => assertLinuxGuidedHostQueryConfig({ ...own, permissions: { disableBypassPermissionsMode: false } }, registration)).toThrow();
    if (permissionMode === "plan") expect(() => assertLinuxGuidedHostQueryRoots(own, roots, registration)).toThrow();
  }
  for (const permissionMode of ["acceptEdits", "dontAsk", "bypassPermissions"] as const) {
    const bypass = permissionMode === "bypassPermissions";
    for (const pair of [{ permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false }, { permissions: { disableBypassPermissionsMode: !bypass }, allowDangerouslySkipPermissions: bypass }]) {
      expect(() => assertLinuxGuidedHostQueryConfig({ ...config, permissionMode, ...pair }, registration), permissionMode).toThrow();
    }
  }
  for (const source of [registration.views.sourceRoot, "/workspace/folders/other", "/workspace/.winter/store"]) {
    expect(() => assertLinuxGuidedHostQueryRoots(config, [{ ...roots[0]!, source } as never], registration), source).toThrow();
  }
  for (const change of [{ sessionId: "foreign" }, { cwd: registration.views.sourceRoot }, { storeHome: "/workspace/.winter/conversations/foreign" },
    { agentId: "child" }, { resume: "backend" }, { forkSession: true }, { settingSources: ["user"] }, { hooks: {} }, { allowedTools: ["Bash"] },
    { requiredRuntimeContext: { version: 1, bindingId: uuid(8) } }]) expect(() => assertLinuxGuidedHostQueryConfig({ ...config, ...change } as RuntimeConfig, registration)).toThrow();
  expect(() => assertLinuxGuidedHostQueryRoots(config, [{ id: "foreign", guestPath: "/workspace/folders/other", readOnly: false }], registration)).toThrow();
});

test("start request has only correlation data; paths, callbacks and request-selected limits refuse", () => {
  const { registration } = fixture();
  const request = { version: 1 as const, bindingId: registration.requiredRuntimeContext.bindingId, contextRequestId: uuid(4), readId };
  const start = linuxGuidedReaderStart(registration, request);
  expect(Object.keys(start).sort()).toEqual(["bindingId", "contextRequestId", "kind", "owner", "readId", "registrationId", "version"]);
  expect(start.owner).toEqual(registration.owner); expect(Object.isFrozen(start.owner)).toBe(true);
  expect(linuxGuidedReaderCancel(registration, readId)).toEqual({ version: 1, kind: "reader_cancel", registrationId: registration.registrationId, readId, owner: registration.owner });
  expect(() => linuxGuidedReaderCancel(registration, "foreign")).toThrow();
  for (const change of [{ bindingId: uuid(8) }, { contextRequestId: readId }, { sourceRoot: "/private" }, { limits: {} }, { agentId: "child" }]) {
    expect(() => linuxGuidedReaderStart(registration, { ...request, ...change })).toThrow();
  }
});

test("result and terminal receipt remain distinct, closed and bound to the same operation/owner", () => {
  const f = fixture();
  expect(parseLinuxGuidedReaderMessage(f.result, f.registration, readId).kind).toBe("reader_result");
  expect(parseLinuxGuidedReaderMessage(f.terminal, f.registration, readId).kind).toBe("reader_terminal");
  for (const message of [f.result, f.terminal]) {
    for (const change of [{ registrationId: uuid(8) }, { readId: uuid(8) }, { owner: { ...f.registration.owner, generation: 2 } },
      { owner: { ...f.registration.owner, leaseEpoch: 2 } }, { owner: { ...f.registration.owner, backendSessionId: "child" } }, { extra: true }]) {
      expect(() => parseLinuxGuidedReaderMessage({ ...message, ...change }, f.registration, readId)).toThrow();
    }
  }
  for (const change of [{ stdoutEof: false }, { stderrEof: false }, { captureDrained: false }, { monitorReaped: false }, { namespaceInitReaped: false },
    { namespaceWaitStatus: -1 }, { monitorWaitStatus: 65536 }, { outcome: "timeout-is-cleanup" }, { frame: "{}\n" }]) {
    expect(() => parseLinuxGuidedReaderMessage({ ...f.terminal, ...change }, f.registration, readId)).toThrow();
  }
  let called = 0;
  expect(() => parseLinuxGuidedReaderMessage({ ...f.terminal, outcome: { toString() { called++; return "ok"; } } }, f.registration, readId)).toThrow();
  expect(called).toBe(0);
  // Parsing claimed evidence has no operation/debt/admission callback to invoke.
  expect(Object.keys(parseLinuxGuidedReaderMessage(f.terminal, f.registration, readId))).not.toContain("drained");
});

test("in-memory frame validation refuses incomplete, oversized, invalid UTF8 and ambiguous JSON", () => {
  const f = fixture(), valid = wire(JSON.stringify(f.result));
  expect(decodeLinuxGuidedReaderFrame(valid, f.registration, readId).kind).toBe("reader_result");
  const invalidUtf8 = Buffer.from([0, 0, 0, 1, 255]);
  for (const frame of [valid.subarray(0, 3), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]),
    invalidUtf8, wire(` ${JSON.stringify(f.result)}`), wire(JSON.stringify(f.result).replace('"version":1', '"version":1,"version":1')),
    Buffer.alloc(LINUX_GUIDED_READER_BODY_BYTES + 5)]) expect(() => decodeLinuxGuidedReaderFrame(frame, f.registration, readId)).toThrow();
  for (const frame of ["{}", "{}\n{}\n", "[]\n", `${" ".repeat(320 * 1024)}{}\n`]) expect(() => parseLinuxGuidedReaderMessage({ ...f.result, frame }, f.registration, readId)).toThrow();
});

test("reader inner echo cannot substitute owner, views, budgets or add snapshot transport keys", () => {
  const f = fixture(), inner = JSON.parse(f.result.frame);
  for (const change of [{ version: 2 }, { readId: uuid(8) }, { owner: { ...inner.owner, generation: 2 } },
    { views: { ...inner.views, sourceRoot: "/private" } }, { limits: { ...inner.limits, maxReadBytes: 1 } },
    { snapshot: { ...inner.snapshot, executable: true } }, { extra: true }]) {
    expect(() => parseLinuxGuidedReaderMessage({ ...f.result, frame: `${JSON.stringify({ ...inner, ...change })}\n` }, f.registration, readId)).toThrow("required_context_unavailable");
  }
});

test("valid guided registration DATA cannot bypass current native admission/engine refusal", async () => {
  const { runEngine } = await import("../engine.ts");
  const f = fixture(); assertLinuxGuidedHostQueryConfig(f.config, f.registration);
  let admissions = 0, input = 0, output = 0, provider = 0;
  await expect(runEngine({ config: f.config,
    get linuxSessionAdmission(): never { admissions++; throw new Error("unregistered owner"); },
    input: { [Symbol.asyncIterator](): never { input++; throw new Error("must not read"); } },
    output: { write() { output++; }, end() { output++; } },
    provider: { async generate() { provider++; return { kind: "text" as const, text: "must not dispatch" }; } },
  })).rejects.toThrow("required_context_unavailable");
  expect({ admissions, input, output, provider }).toEqual({ admissions: 0, input: 0, output: 0, provider: 0 });
});
