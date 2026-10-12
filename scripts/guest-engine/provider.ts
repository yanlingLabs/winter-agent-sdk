/** Disposable host-provider fixture. No production provider/network admission is claimed.
 * The Root harness fixes listener/library/metadata FDs and sends the actual runtime pidfd.
 * This process holds only a fake credential; no credential material enters guest frames. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { fstatSync, readFileSync } from "node:fs";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";

if (process.platform !== "linux" || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--listener-fd", "3", "--admission-fd", "4", "--owner-library-fd", "5", "--metadata-fd", "6"])) throw new Error("fixed Linux provider fixture entry required");
for (const fd of [5, 6]) { const st = fstatSync(fd); if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || st.mode & 0o222 || st.size > 4 * 1024 * 1024) throw new Error("immutable fixture input required"); }
const metadata = JSON.parse(readFileSync(6, "utf8"));
if (!Number.isSafeInteger(metadata.runtimeUid) || metadata.runtimeUid < 1000 || !metadata.provider?.scope || !metadata.provider?.selection) throw new Error("fixed fixture metadata required");
const library = dlopen("/proc/self/fd/5", {
  winter_provider_receive_owner: { args: [FFIType.i32], returns: FFIType.i32 },
  winter_provider_accept: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  winter_provider_owner_live: { args: [FFIType.i32], returns: FFIType.i32 },
  winter_provider_read_frame: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.cstring },
  winter_provider_write_frame: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  winter_provider_close_client: { args: [FFIType.i32], returns: FFIType.void },
});
const ownerFd = library.symbols.winter_provider_receive_owner(4); if (ownerFd < 0) throw new Error("native provider admission required");
const fakeHostCredential = "DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET";
const scope = JSON.stringify(metadata.provider.scope), selection = metadata.provider.selection;
let peerValidated = false;
let invocation: { id: string; sequence: number; events: ProviderEvent[]; at: number } | undefined, turns = 0;
const script = [
  { name: "Read", input: { file_path: "seed" } },
  { name: "Edit", input: { file_path: "seed", old_string: "hello", new_string: "edited" } },
  { name: "Write", input: { file_path: "written", content: "written\n" } },
  { name: "Bash", input: { command: "test ! -e /workspace/.winter/conversations && printf shell > from-shell", timeout: 5000 } },
];
function response(request: any): object {
  if (request.version !== 1 || JSON.stringify(request.scope) !== scope || typeof request.invocationId !== "string" || request.invocationId.length > 128 || !Number.isSafeInteger(request.sequence)) throw new Error("scope");
  if (request.operation === "begin") {
    if (invocation || request.sequence !== 0 || request.turn?.model !== selection.providerModelId || !Array.isArray(request.turn?.messages) || turns > script.length || !fakeHostCredential) throw new Error("turn");
    const prior = request.turn.messages.filter((message: any) => message.role === "assistant");
    if (prior.length !== turns || prior.some((message: any, index: number) => message.origin?.providerId !== selection.providerId || message.origin?.modelKey !== selection.modelKey || message.origin?.family !== selection.family || message.nativeState?.family !== selection.family || message.nativeState?.continuationDomain !== selection.continuationDomain || JSON.stringify(message.nativeState?.items) !== JSON.stringify([{ type: "reasoning", id: `reasoning-${index}`, encrypted_content: "fixture-native-state" }]))) throw new Error("native continuation binding missing");
    const call = script[turns], events: ProviderEvent[] = [{ type: "native_state", items: [{ type: "reasoning", id: `reasoning-${turns}`, encrypted_content: "fixture-native-state" }] }];
    if (call) events.push({ type: "tool_call_start", id: `call-${turns}`, name: call.name }, { type: "tool_call_delta", id: `call-${turns}`, argumentsJsonDelta: JSON.stringify(call.input) }, { type: "tool_call_end", id: `call-${turns}` }, { type: "done", stopReason: "tool_use" });
    else events.push({ type: "text_delta", text: "fresh-engine-complete" }, { type: "done", stopReason: "end_turn" });
    invocation = { id: request.invocationId, sequence: 1, events, at: 0 }; turns++;
    return { version: 1, invocationId: request.invocationId, sequence: 0, kind: "accepted" };
  }
  if (request.operation !== "next" || !invocation || request.invocationId !== invocation.id || request.sequence !== invocation.sequence++ || request.turn !== undefined) throw new Error("pull");
  const event = invocation.events[invocation.at++]; if (!event) throw new Error("end"); if (event.type === "done") invocation = undefined;
  return { version: 1, invocationId: request.invocationId, sequence: request.sequence, kind: "event", event };
}
let stopped = false;
process.once("SIGTERM", () => { stopped = true; }); process.once("SIGINT", () => { stopped = true; });
try {
  while (!stopped && library.symbols.winter_provider_owner_live(ownerFd) === 1) {
    const clientFd = library.symbols.winter_provider_accept(3, ownerFd, metadata.runtimeUid);
    if (clientFd >= 0) {
      try {
        const request = library.symbols.winter_provider_read_frame(clientFd, ownerFd, metadata.runtimeUid);
        if (!request) throw new Error("private fixture framing unavailable");
        peerValidated = true;
        const answer = Buffer.from(JSON.stringify(response(JSON.parse(request.toString()))) + "\0");
        if (library.symbols.winter_provider_write_frame(clientFd, ownerFd, metadata.runtimeUid, ptr(answer)) !== 0) throw new Error("private fixture write unavailable");
      } finally { library.symbols.winter_provider_close_client(clientFd); }
    }
    await Bun.sleep(0); // native accept is bounded; signals are processed between calls.
  }
  console.log(JSON.stringify({ passed: turns === 5 && invocation === undefined && peerValidated, turns, peerValidated }));
} catch (error) {
  const codes: Record<string, string> = { scope: "scope", turn: "turn", pull: "pull", end: "end", "native continuation binding missing": "native_continuation", "private fixture framing unavailable": "framing", "private fixture write unavailable": "write" };
  const code = error instanceof Error ? codes[error.message] ?? "provider_failure" : "provider_failure";
  console.log(JSON.stringify({ passed: false, turns, peerValidated, failure: { phase: "provider_exchange", code } }));
  process.exitCode = 1;
} finally { library.close(); }
