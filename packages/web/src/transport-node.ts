// THE DEFAULT TRANSPORT -- `node:http` / `node:https`, which exist and behave alike under Node and Bun.
//
// It connects to `request.address` -- the validated IP literal -- and nothing else:
//   - `host` IS the literal, so no runtime resolves a name for this socket (neither Node's `net`
//     nor Bun's client resolves an IP literal);
//   - `lookup` is pinned as well: should any runtime consult it anyway, it can only answer the
//     validated address;
//   - under Node, the socket's `remoteAddress` is compared with the pinned address the moment the
//     TCP connection is up (before the TLS handshake, before any request byte), and the request is
//     destroyed on a mismatch. Bun's client exposes no `remoteAddress`; there the first two hold.
// The logical hostname travels as the `Host` header and, for TLS, as `servername` -- SNI and
// certificate validation by name (`rejectUnauthorized` is never turned off). `agent: false`: no
// connection is pooled or reused across hops, so a socket opened for one validated address never
// carries a request for another.
//
// PROXIES. Node's `http`/`https` never consult `HTTP(S)_PROXY` for a request with its own agent.
// Bun's `node:http` DOES honour them (measured on 1.3.14). The proxy is then handed the pinned
// literal (`CONNECT 203.0.113.7:443`), never the hostname, so it has no name to re-resolve and can
// only reach the address that was validated; TLS still runs end to end with the origin. Proxy
// credentials stay inside the runtime: nothing here reads the proxy URL, and every failure is
// reported by its error code alone, never its message.
import http from "node:http";
import https from "node:https";
import type { LookupFunction, Socket } from "node:net";
import { formatAddress, parseIpLiteral } from "./address.ts";
import type { WebFetchTransport, WebFetchTransportRequest, WebFetchTransportResponse } from "./net.ts";

export interface NodeWebFetchTransportOptions {
  /** Trust anchors (PEM) for TLS. As with `tls.connect`'s own `ca`, they REPLACE the default set. For tests and private PKI. */
  ca?: string | Buffer | ReadonlyArray<string | Buffer>;
}

/** Is `remote` (a socket's `remoteAddress`) the validated `expected` address? An IPv4-mapped remote equals its IPv4 address. */
export function sameAddress(a: string, b: string): boolean {
  const pa = parseIpLiteral(a.split("%")[0]!);
  const pb = parseIpLiteral(b);
  if (pa === undefined || pb === undefined) return false;
  const norm = (x: Uint8Array): string => {
    // An IPv4-mapped IPv6 remote (a dual-stack socket) is the same IPv4 address.
    if (x.length === 16 && x.subarray(0, 10).every((v) => v === 0) && x[10] === 0xff && x[11] === 0xff) return formatAddress(x.slice(12));
    return formatAddress(x);
  };
  return norm(pa) === norm(pb);
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The `node:http(s)` transport. One per process is enough; it holds no connection state. */
export function createNodeWebFetchTransport(options: NodeWebFetchTransportOptions = {}): WebFetchTransport {
  return (request: WebFetchTransportRequest) =>
    new Promise<WebFetchTransportResponse>((resolve, reject) => {
      const secure = request.url.protocol === "https:";
      const port = request.url.port !== "" ? Number(request.url.port) : secure ? 443 : 80;
      const pinned: LookupFunction = (_hostname, opts, callback) => {
        const all = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
        if (all) (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: request.address, family: request.family }]);
        else callback(null, request.address, request.family);
      };
      const serverNameIsLiteral = parseIpLiteral(request.serverName) !== undefined;
      const req = (secure ? https : http).request({
        host: request.address,
        port,
        family: request.family,
        path: `${request.url.pathname}${request.url.search}`,
        method: "GET",
        headers: request.headers,
        agent: false,
        lookup: pinned,
        ...(secure
          ? {
              ...(serverNameIsLiteral ? {} : { servername: request.serverName }),
              rejectUnauthorized: true,
              ...(options.ca !== undefined ? { ca: options.ca as string | Buffer | Array<string | Buffer> } : {}),
            }
          : {}),
      });
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      req.on("socket", (socket: Socket) => {
        const check = (): void => {
          const remote = socket.remoteAddress;
          if (remote !== undefined && remote !== "" && !sameAddress(remote, request.address)) {
            req.destroy(codedError("ERR_CONNECTED_ADDRESS_MISMATCH", "the socket connected to an address other than the validated one"));
          }
        };
        if (typeof socket.remoteAddress === "string" && socket.remoteAddress !== "") check();
        else socket.once("connect", check);
      });
      req.on("response", (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get(name: string): string | null {
              const value = res.headers[name.toLowerCase()];
              if (value === undefined) return null;
              return Array.isArray(value) ? value.join(", ") : String(value);
            },
          },
          body: res,
          cancel(): void {
            res.destroy();
          },
        });
      });
      req.on("error", fail);
      const abort = (): void => {
        const err = codedError("ABORT_ERR", "the request was aborted");
        fail(err);
        req.destroy(err);
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      req.end();
    });
}
