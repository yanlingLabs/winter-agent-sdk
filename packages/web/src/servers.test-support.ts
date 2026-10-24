// Test support: a throwaway CA and leaf certificate (made by `openssl` at test time, never committed),
// loopback HTTPS servers, and transports that map the synthetic public test addresses onto them.
// Runtime-neutral (node:* only), so the same tests run under `node --test` and `bun test`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeWebFetchTransport } from "./transport-node.ts";
import type { WebFetchTransport, WebFetchTransportRequest } from "./net.ts";

/** Every hostname the test leaf certificate is valid for. */
export const TEST_HOSTS = ["logical.test", "public.test", "rebind.test", "mixed.test", "redirect.test", "chain.test", "other.test", "proxy.test"] as const;

export interface TestPki {
  ca: string;
  key: string;
  cert: string;
}

let pki: TestPki | undefined | null;

/** A fresh CA + leaf (SANs: `TEST_HOSTS` and 127.0.0.1), or `undefined` when `openssl` is not available. */
export function testPki(): TestPki | undefined {
  if (pki !== undefined) return pki ?? undefined;
  const dir = mkdtempSync(join(tmpdir(), "winter-web-pki-"));
  try {
    const run = (args: string[]): void => void execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=winter-web test CA"]);
    run(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=logical.test"]);
    writeFileSync(join(dir, "ext.cnf"), `subjectAltName=${[...TEST_HOSTS.map((h) => `DNS:${h}`), "IP:127.0.0.1"].join(",")}\n`);
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", "ext.cnf"]);
    pki = { ca: readFileSync(join(dir, "ca.crt"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8"), cert: readFileSync(join(dir, "leaf.crt"), "utf8") };
  } catch {
    pki = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return pki ?? undefined;
}

export interface TestServer {
  port: number;
  /** Every request path the server saw, in order. */
  hits: string[];
  /** The Host header of every request. */
  hosts: string[];
  close(): Promise<void>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, server: TestServer) => void | Promise<void>;

/** A loopback HTTPS server with the test leaf certificate. Binds 127.0.0.1 only. */
export async function startHttpsServer(handler: Handler): Promise<TestServer> {
  const p = testPki();
  if (p === undefined) throw new Error("openssl is not available");
  const sockets = new Set<import("node:net").Socket>();
  const server: TestServer = {
    port: 0,
    hits: [],
    hosts: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  };
  const srv = https.createServer({ key: p.key, cert: p.cert }, (req, res) => {
    server.hits.push(req.url ?? "");
    server.hosts.push(req.headers.host ?? "");
    Promise.resolve(handler(req, res, server)).catch(() => res.destroy());
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  srv.unref();
  server.port = (srv.address() as AddressInfo).port;
  return server;
}

/** The node transport trusting the test CA. */
export function trustingTransport(): WebFetchTransport {
  const p = testPki();
  return createNodeWebFetchTransport(p !== undefined ? { ca: p.ca } : {});
}

/**
 * The test "internet": a synthetic public address (`PUBLIC_A`, `PUBLIC_B`) is mapped to the loopback
 * server -- the stand-in for a public host -- while everything else goes to the real address. Every
 * request the transport is handed is recorded, so a test proves what was (and was not) dialled.
 */
export const PUBLIC_A = "93.184.216.34";
export const PUBLIC_B = "2606:4700:4700::1111";

export function mappedTransport(port: number, seen: WebFetchTransportRequest[] = []): { transport: WebFetchTransport; seen: WebFetchTransportRequest[] } {
  const real = trustingTransport();
  return {
    seen,
    transport: (request) => {
      seen.push(request);
      if (request.address !== PUBLIC_A && request.address !== PUBLIC_B) return real(request);
      const url = new URL(request.url.toString());
      url.hostname = "127.0.0.1";
      url.port = String(port);
      return real({ ...request, url, address: "127.0.0.1", family: 4 });
    },
  };
}
