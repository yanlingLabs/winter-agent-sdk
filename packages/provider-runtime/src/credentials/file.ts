// A file-backed credential store. FROZEN as of P6 T2's merge (R6-12, `credentials/**`).
//
// Handles `{ kind: "file" }` in its three formats, `{ kind: "aws-default-chain" }`, and `none`.
//
// The AWS default chain here is DELIBERATELY TWO LINKS: the injected environment, then a shared
// credentials file. R6-16 scopes this phase to exactly that — **no IMDS, no STS**. That is not a
// simplification to revisit casually: an IMDS link would make a credential lookup issue a network
// request to `169.254.169.254`, which on a non-EC2 host hangs until a timeout and on an EC2 host
// silently succeeds with an instance role nobody configured. The test asserts the negative
// behaviourally (neither source present ⇒ `null`), which is the only assertion an absent-link claim
// can actually be proved by.
//
// `env`, `home` and `readFile` are all INJECTED: nothing here reads `process.env`, `os.homedir()` or
// the real filesystem implicitly, so a test can point the whole store at a mkdtemp directory.

import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../types.ts";
import { CredentialResolutionError, isNoCredential, readOnlyWriteRefusal, redactRef, unsupported } from "./types.ts";

const NAME = "file credential store";

/** Guards against a pathological credentials file: 1 MiB is orders of magnitude above any real one. */
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

export interface FileCredentialStoreOptions {
  env: Record<string, string | undefined>;
  /** The home directory the default `~/.aws/credentials` location resolves under. Injected so a test never reads the real one. */
  home: string;
  /** Reads a file as UTF-8, or rejects. Injectable for tests that want to simulate an IO failure without creating one. */
  readFile?: (path: string) => Promise<string>;
  /**
   * Returns a file's size in bytes, or rejects. Defaults to `node:fs/promises` `stat`.
   *
   * Its job is to make the size cap bound what is PULLED INTO MEMORY rather than only what is kept:
   * checking the length after reading means a multi-gigabyte file addressed by a `{ kind: "file" }`
   * ref is fully buffered first and rejected second. A custom `readFile` with no matching `stat`
   * skips the pre-check — the post-read cap still applies — because a test double's "file" has no
   * size to ask about.
   */
  stat?: (path: string) => Promise<{ size: number }>;
}

/** Reads a file, mapping "not found" to `null` and any other IO failure to a typed error whose message carries NO file content. */
async function readOptional(path: string, read: (p: string) => Promise<string>, stat: ((p: string) => Promise<{ size: number }>) | undefined): Promise<string | null> {
  try {
    if (stat !== undefined) {
      let size: number | undefined;
      try {
        size = (await stat(path)).size;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw new CredentialResolutionError("io", `${NAME}: cannot stat ${path} (${typeof code === "string" ? code : "stat failed"})`);
      }
      if (size > MAX_CREDENTIAL_FILE_BYTES) {
        throw new CredentialResolutionError("malformed", `${NAME}: ${path} is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes — refusing to read it as a credentials file`);
      }
    }
    const text = await read(path);
    // Kept as a backstop for the injected-reader path, and for a file that grew between the stat
    // and the read.
    if (text.length > MAX_CREDENTIAL_FILE_BYTES) {
      throw new CredentialResolutionError("malformed", `${NAME}: ${path} is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes — refusing to parse it as a credentials file`);
    }
    return text;
  } catch (err) {
    if (err instanceof CredentialResolutionError) throw err;
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // The message names the PATH and the errno, never the contents — a failed read can still have
    // buffered part of a key, and an error string is the easiest thing in a system to end up in a log.
    throw new CredentialResolutionError("io", `${NAME}: cannot read ${path} (${typeof code === "string" ? code : "read failed"})`);
  }
}

/**
 * Parses the INI-ish shared-credentials format: `[profile]` headers, `key = value` lines, `#`/`;`
 * comments. Hand-rolled because it is fifteen lines and this package takes no dependencies.
 * Deliberately lenient about whitespace and case-insensitive on keys, like the real format; values
 * are taken verbatim after the first `=`.
 */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      current = new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || current === undefined) continue;
    current.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return sections;
}

function awsFromSection(section: Map<string, string> | undefined): CredentialMaterial | null {
  if (section === undefined) return null;
  const accessKeyId = section.get("aws_access_key_id");
  const secretAccessKey = section.get("aws_secret_access_key");
  if (accessKeyId === undefined || accessKeyId.length === 0 || secretAccessKey === undefined || secretAccessKey.length === 0) return null;
  const sessionToken = section.get("aws_session_token");
  return {
    kind: "aws",
    accessKeyId,
    secretAccessKey,
    ...(sessionToken !== undefined && sessionToken.length > 0 ? { sessionToken } : {}),
  };
}

export function createFileCredentialStore(opts: FileCredentialStoreOptions): CredentialStore {
  const read = opts.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));
  // Only paired with the DEFAULT reader unless a caller supplies its own: statting the real
  // filesystem for a path a test double invented would be both wrong and slow.
  const stat = opts.stat ?? (opts.readFile === undefined ? (path: string) => nodeStat(path) : undefined);

  async function fromSharedCredentials(path: string, profile: string): Promise<CredentialMaterial | null> {
    const text = await readOptional(path, read, stat);
    if (text === null) return null;
    // A named profile that is not present is `null`, NOT a silent fall back to [default]: quietly
    // signing with the wrong account is a worse outcome than reporting that nothing was found.
    return awsFromSection(parseIni(text).get(profile));
  }

  async function fromServiceAccountJson(ref: Extract<CredentialRef, { kind: "file" }>): Promise<CredentialMaterial | null> {
    const text = await readOptional(ref.path, read, stat);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // The parser's own message would quote the offending region of the document — which is the
      // document holding a private key. Only the locator survives.
      throw new CredentialResolutionError("malformed", `${NAME}: ${redactRef(ref)} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) throw new CredentialResolutionError("malformed", `${NAME}: ${redactRef(ref)} is not a service-account object`);
    const obj = parsed as Record<string, unknown>;
    const clientEmail = obj["client_email"];
    const privateKeyPem = obj["private_key"];
    const tokenUri = obj["token_uri"];
    if (typeof clientEmail !== "string" || typeof privateKeyPem !== "string" || typeof tokenUri !== "string") {
      throw new CredentialResolutionError("malformed", `${NAME}: ${redactRef(ref)} is missing client_email, private_key or token_uri`);
    }
    return { kind: "gcp-service-account", clientEmail, privateKeyPem, tokenUri };
  }

  return {
    async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
      if (isNoCredential(ref)) return null;

      if (ref.kind === "file") {
        switch (ref.format) {
          case "raw": {
            const text = await readOptional(ref.path, read, stat);
            if (text === null) return null;
            const value = text.trim();
            return value.length === 0 ? null : { kind: "api-key", key: value };
          }
          case "aws-shared-credentials":
            return await fromSharedCredentials(ref.path, ref.profile ?? "default");
          case "gcp-service-account-json":
            return await fromServiceAccountJson(ref);
        }
      }

      if (ref.kind === "aws-default-chain") {
        // Link 1: the injected environment.
        const accessKeyId = opts.env["AWS_ACCESS_KEY_ID"];
        const secretAccessKey = opts.env["AWS_SECRET_ACCESS_KEY"];
        if (accessKeyId !== undefined && accessKeyId.length > 0 && secretAccessKey !== undefined && secretAccessKey.length > 0) {
          const sessionToken = opts.env["AWS_SESSION_TOKEN"];
          return {
            kind: "aws",
            accessKeyId,
            secretAccessKey,
            ...(sessionToken !== undefined && sessionToken.length > 0 ? { sessionToken } : {}),
          };
        }
        // Link 2: the shared credentials file. There is no link 3 (R6-16).
        const path = opts.env["AWS_SHARED_CREDENTIALS_FILE"] ?? join(opts.home, ".aws", "credentials");
        return await fromSharedCredentials(path, opts.env["AWS_PROFILE"] ?? "default");
      }

      throw unsupported(NAME, ref);
    },
    async set(): Promise<void> {
      throw readOnlyWriteRefusal(NAME);
    },
    async delete(): Promise<void> {
      throw readOnlyWriteRefusal(NAME);
    },
  };
}
