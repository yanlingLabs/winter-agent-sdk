import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { admitFreshLinuxSession, assertLinuxSession, assertFreshLinuxUserFrame, claimLinuxSession, linuxSessionBindings, linuxSessionConfig, type LinuxSessionAdmission } from "./linux-session-admission.ts";
import { assertRuntimeExecutionPosture, RUNTIME_EXECUTION_POSTURE_CAPABILITIES } from "./execution-posture.ts";
import { runEmbeddedSession } from "../embedded.ts";
import { createProtectedStoreBootstrap } from "./store-bootstrap.ts";
const forged = Object.freeze({ freshOnly: true, runtimeUid: 20001, ownerToken: "not-native-evidence" }) as unknown as LinuxSessionAdmission;
const config = { executionPosture: "confined-guest" as const, cwd: "/workspace/folders/source", model: "openai/gpt-5.6", sessionId: "backend", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical" };

test("fresh input accepts the runtime text frame and rejects alternate payload or control surfaces", () => {
  expect(() => assertFreshLinuxUserFrame({ type: "user", text: "Read seed then edit it" })).not.toThrow();
  for (const frame of [
    null, [], { type: "user" }, { type: "user", text: 1 },
    { type: "user", message: { role: "user", content: "Read seed" } },
    { type: "user", text: "Read seed", message: { content: "different prompt" } },
    { type: "user", text: "Read seed", images: [] },
    { type: "user", text: " /compact" }, { type: "control_request", subtype: "set_model" },
  ]) expect(() => assertFreshLinuxUserFrame(frame)).toThrow("fresh Linux input route unavailable");
});

test("private fresh invocation does not advertise general confined startup", () => {
  expect(RUNTIME_EXECUTION_POSTURE_CAPABILITIES.supportsConfinedGuestExecution).toBe(false);
  expect(() => assertRuntimeExecutionPosture(config)).toThrow("protected tool-side");
  expect(() => assertRuntimeExecutionPosture(config, forged)).toThrow("admission unavailable");
  expect(() => assertRuntimeExecutionPosture({ executionPosture: "local" }, forged)).toThrow("protected tool-side");
});

test("JSON, clones and fake owner fields cannot mint any tool/provider/store capability", () => {
  for (const value of [forged, structuredClone(forged), JSON.parse(JSON.stringify(forged))]) {
    expect(() => assertLinuxSession(value, config)).toThrow("admission unavailable");
    expect(() => claimLinuxSession(value, config)).toThrow("admission unavailable");
    expect(() => linuxSessionConfig(value)).toThrow("admission unavailable");
    expect(() => linuxSessionBindings(value)).toThrow("admission unavailable");
  }
});

test("invalid inherited descriptors refuse before native library load", () => {
  for (const pair of [[0, 0], [3, 3], [-1, 4], [NaN, 4], [3, 4.1]]) expect(() => admitFreshLinuxSession(pair[0]!, pair[1]!)).toThrow("admission unavailable");
});

test("embedded refusal precedes fake protected store acquisition and engine output", async () => {
  let acquired = 0; const output: string[] = [];
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-fresh-admission-")));
  try {
  const store = createProtectedStoreBootstrap({ workspaceId: "workspace", sessionId: "backend", incarnationId: "incarnation", leaseEpoch: 1, storeHome: home, currentBootId: "01234567-89ab-4cde-8fab-0123456789ab" }, { acquire: async () => { acquired++; throw new Error("should never acquire"); } });
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(config)], env: {}, linuxSessionAdmission: forged, protectedStoreBootstrap: store, onProtectedStoreOwnershipOutcome() {}, input: (async function* () {})(), write: value => output.push(value), writeErr() {} });
  expect(code).toBe(1); expect(acquired).toBe(0); expect(output).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("actual private Unix socket exchange rejects promptly when its port closes", async () => {
  const { createServer } = await import("node:net");
  const { createLinuxProviderPort } = await import("./linux-session-admission.ts");
  const directory = mkdtempSync(join(tmpdir(), "winter-private-provider-")), path = join(directory, "socket");
  const peers = new Set<import("node:net").Socket>(); let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  const server = createServer(socket => { peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket)); accept(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const port = createLinuxProviderPort(path, () => {}); // transport test; no native admission minted.
  try {
    const pending = port.exchange(new Uint8Array([0, 0, 0, 2, 123, 125]));
    await accepted; const before = performance.now(); port.close();
    await expect(pending).rejects.toThrow("private provider closed");
    expect(performance.now() - before).toBeLessThan(500);
    await expect(port.exchange(new Uint8Array())).rejects.toThrow("private provider closed");
  } finally {
    port.close(); for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelling one actual Unix exchange leaves other and later exchanges usable",async()=>{
 const {createServer}=await import("node:net"),{createLinuxProviderPort}=await import("./linux-session-admission.ts");
 const directory=mkdtempSync(join(tmpdir(),"winter-private-provider-")),path=join(directory,"socket"),peers=new Set<import("node:net").Socket>();let first=true,accepted!:()=>void;
 const ready=new Promise<void>(resolve=>{accepted=resolve;});
 const server=createServer(socket=>{peers.add(socket);socket.on("error",()=>{});socket.on("close",()=>peers.delete(socket));const held=first;first=false;socket.on("data",data=>{if(held)accepted();else socket.end(data);});});
 await new Promise<void>(resolve=>server.listen(path,resolve));const port=createLinuxProviderPort(path,()=>{}),abort=new AbortController(),frame=new Uint8Array([0,0,0,2,123,125]);
 try {
  const held=port.exchange(frame,abort.signal);void held.catch(()=>{});await ready;
  expect(await port.exchange(frame)).toEqual(frame);abort.abort();await expect(held).rejects.toThrow("invocation cancelled");expect(await port.exchange(frame)).toEqual(frame);
 } finally {port.close();for(const socket of peers)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
