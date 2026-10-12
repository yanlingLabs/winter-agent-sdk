import { describe, expect, test } from "bun:test";
import { createGuestFileHelper, type GuestFileAuthority, type GuestFileRequest, type GuestFileReply, type GuestFileHelperPort } from "./file-helper.ts";

const authority: GuestFileAuthority = { workspaceId: "workspace", sessionId: "session", incarnationId: "boot", leaseEpoch: 1, configRevision: 2, grantRevision: 3, policyRevision: 4 };
function fixture(readOnly = false) {
  const calls: GuestFileRequest[] = [];
  const port: GuestFileHelperPort = {
    async execute(request) {
      calls.push(request);
      const payload = request.operation === "read" ? Buffer.from("hello 雪") : Buffer.from(request.dataBase64!, "base64");
      return { protocolVersion: 1, requestId: request.requestId, authority: request.authority, exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, bytes: payload.length, ...(request.operation === "read" ? { dataBase64: payload.toString("base64") } : {}) }) };
    },
  };
  const helper = createGuestFileHelper({ authority, roots: [{ id: "source", guestPath: "/workspace/source", readOnly }], expectedUid: 10001, port, maxBytes: 1024 });
  return { calls, port, helper };
}
describe("compartment file-helper protocol", () => {
  test("read/write use the authenticated compartment port, stable root and exact bytes", async () => {
    const f = fixture();
    expect(Buffer.from(await f.helper.read("source", "directory/file.txt")).toString()).toBe("hello 雪");
    await f.helper.write("source", "file.txt", Buffer.from("written 雪"));
    expect(f.calls.map((call) => call.operation)).toEqual(["read", "write"]);
    expect(f.calls[0]?.root.guestPath).toBe("/workspace/source");
    expect(f.calls[1]?.expectedUid).toBe(10001);
    expect(Buffer.from(f.calls[1]!.dataBase64!, "base64").toString()).toBe("written 雪");
  });
  test("plan/root constraints and bad request shapes cannot reach the worker", async () => {
    const f = fixture(true);
    await expect(f.helper.write("source", "file", Buffer.from("denied"))).rejects.toMatchObject({ code: "read_only" });
    for (const path of ["../control", "/absolute", "a/../../b", "a\0b", "./file", "a//file"]) await expect(f.helper.read("source", path)).rejects.toMatchObject({ code: "path_denied" });
    await expect(f.helper.read("foreign", "file")).rejects.toMatchObject({ code: "path_denied" });
    expect(f.calls).toEqual([]);
  });
  test("abort and byte bound reject before admission, context is immutable", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.helper.read("source", "file", controller.signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(f.helper.write("source", "file", new Uint8Array(1025))).rejects.toMatchObject({ code: "payload_limit" });
    await f.helper.read("source", "file");
    expect(Object.isFrozen(f.calls[0])).toBe(true); expect(Object.isFrozen(f.calls[0]!.authority)).toBe(true); expect(Object.isFrozen(f.calls[0]!.root)).toBe(true);
  });
  test("all authority revisions and request IDs bind responses; stale write is uncertain", async () => {
    for (const key of ["workspaceId", "sessionId", "incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const) {
      const f = fixture();
      f.port.execute = async (request) => ({ protocolVersion: 1, requestId: request.requestId, authority: { ...request.authority, [key]: typeof request.authority[key] === "number" ? -1 : "foreign" }, exitCode: 0, stdout: '{"version":1,"ok":true,"bytes":1}' });
      await expect(f.helper.write("source", "file", Buffer.from("x"))).rejects.toMatchObject({ code: "binding_mismatch", effectsUncertain: true });
    }
  });
  test("worker errno refusals, malformed success and disconnect are not successful file results", async () => {
    const f = fixture();
    f.port.execute = async (request) => ({ protocolVersion: 1, requestId: request.requestId, authority: request.authority, exitCode: 1, stdout: '{"version":1,"ok":false,"code":"path_denied","errno":18}' });
    await expect(f.helper.read("source", "file")).rejects.toMatchObject({ code: "path_denied", errno: 18 });
    f.port.execute = async (request) => ({ protocolVersion: 1, requestId: request.requestId, authority: request.authority, exitCode: 0, stdout: '{"version":1,"ok":true,"bytes":1,"dataBase64":"!!!"}' });
    await expect(f.helper.read("source", "file")).rejects.toMatchObject({ code: "invalid_response" });
    let attempts = 0;
    f.port.execute = async () => { attempts++; throw new Error("stream lost"); };
    await expect(f.helper.write("source", "file", Buffer.from("x"))).rejects.toMatchObject({ code: "transport_lost", effectsUncertain: true });
    expect(attempts).toBe(1);
  });
  test("partial writes/flush failures retain uncertainty and oversized responses refuse", async () => {
    const f = fixture();
    const reply = (request: GuestFileRequest, stdout: string): GuestFileReply => ({ protocolVersion: 1, requestId: request.requestId, authority: request.authority, exitCode: 1, stdout });
    f.port.execute = async (request) => reply(request, '{"version":1,"ok":false,"code":"flush_failed","errno":28}');
    await expect(f.helper.write("source", "file", Buffer.from("x"))).rejects.toMatchObject({ code: "flush_failed", effectsUncertain: true, errno: 28 });
    f.port.execute = async (request) => reply(request, "x".repeat(3000));
    await expect(f.helper.read("source", "file")).rejects.toMatchObject({ code: "invalid_response" });
  });
});
