// Run as a CHILD process by net.test.ts (`<runtime> proxy-child.test-support.ts`): an environment
// proxy must be in place before the runtime's first request, and a runtime may keep what it read --
// so this never runs inside the shared test process. Prints one JSON line.
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { fetchWebResource } from "./net.ts";
import { startHttpsServer, trustingTransport } from "./servers.test-support.ts";

const server = await startHttpsServer((_req, res) => void res.end("ok"));
const lines: string[] = [];
const proxy = createServer((_req, res) => {
  lines.push("plain request");
  res.statusCode = 502;
  res.end();
});
proxy.on("connect", (req, clientSocket: Socket, head) => {
  lines.push(`CONNECT ${req.url}`);
  const [host, port] = (req.url ?? "").split(":");
  if (host !== "127.0.0.1") return void clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  const upstream = connect(Number(port), "127.0.0.1", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
const proxyUrl = `http://proxyuser:proxysecret@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
process.env["HTTPS_PROXY"] = proxyUrl;
process.env["https_proxy"] = proxyUrl;
const result = await fetchWebResource(`https://proxy.test:${server.port}/`, { transport: trustingTransport(), resolveHost: async () => ["127.0.0.1"], privateAddressPolicy: "allow", timeoutMs: 5_000 });
console.log(JSON.stringify({ ok: result.ok, code: result.ok ? undefined : result.code, lines, expected: `CONNECT 127.0.0.1:${server.port}`, leaked: JSON.stringify(result).includes("proxysecret") }));
process.exit(0);
