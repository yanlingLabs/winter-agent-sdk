/** Reusable admitted entry. No argv/env/options/config authority enters this API. */
import { decodeFrame } from "@yanlinglabs/winter-agent-sdk";
import { runEmbeddedSession } from "../embedded.ts";
import { linuxSessionBindings, linuxSessionConfig, linuxSessionProfile, closeLinuxSession, type LinuxSessionAdmission } from "./linux-session-admission.ts";
import { LINUX_SESSION_CHUNK_BYTES, LINUX_SESSION_FRAME_BYTES } from "./linux-host-query-profile.ts";
import type { ProtectedStoreOwnershipOutcome } from "./store-bootstrap.ts";

export interface AdmittedLinuxSessionOptions {
  admission: LinuxSessionAdmission;
  /** NDJSON transport stays open after logical end_input to carry pending permission answers. */
  input: AsyncIterable<string>;
  write(chunk: string): void;
  writeErr(chunk: string): void;
  signal?: AbortSignal;
  /** Trusted lifecycle observer. A numeric result or closed entry is never native termination proof. */
  onProtectedStoreOwnershipOutcome(outcome: Readonly<ProtectedStoreOwnershipOutcome>): void;
}
/** Bounded pull-based framing, without a second parser/agent loop. Errors cancel the admitted run. */
export async function* boundedLinuxSessionInput(input: AsyncIterable<string>, cancel: () => void, cancelOnEOF = true): AsyncGenerator<string> {
  let complete = false;
  let carry = "";
  try {
    for await (const chunk of input) {
      if (typeof chunk !== "string" || Buffer.byteLength(chunk) > LINUX_SESSION_CHUNK_BYTES) throw new Error("Linux session input chunk bound");
      carry += chunk;
      let end: number;
      while ((end = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, end); carry = carry.slice(end + 1);
        if (Buffer.byteLength(line) > LINUX_SESSION_FRAME_BYTES) throw new Error("Linux session input frame bound");
        if (line.length !== 0) { decodeFrame(line); yield line + "\n"; }
      }
      if (Buffer.byteLength(carry) > LINUX_SESSION_FRAME_BYTES) throw new Error("Linux session input frame bound");
    }
    if (carry.length !== 0) throw new Error("Linux session input truncated frame");
    complete = true;
  } finally {
    // Actual transport EOF/error/consumer cancellation differs from logical end_input.
    if (!complete || cancelOnEOF) cancel();
  }
}
/** Transport framing only; does not grant a session or tool capability. */
export function boundedLinuxSessionOutput(write: (chunk: string) => void, cancel: () => void): (chunk: string) => void {
  return chunk => {
    try {
      if (Buffer.byteLength(chunk) > LINUX_SESSION_FRAME_BYTES) throw new Error("Linux session output frame bound");
      // Each transport chunk fits 256KiB even for four-byte codepoints; preserve surrogate pairs.
      for (let offset = 0; offset < chunk.length;) {
        let end = Math.min(offset + 65536, chunk.length);
        if (end < chunk.length && /[\uD800-\uDBFF]/.test(chunk[end - 1]!)) end--;
        write(chunk.slice(offset, end)); offset = end;
      }
    } catch (error) { cancel(); throw error; }
  };
}
export async function runAdmittedLinuxSession(options: AdmittedLinuxSessionOptions): Promise<number> {
  const controller = new AbortController(), cancel = (): void => controller.abort();
  const signals: AbortSignal[] = [];
  try {
    // Reject forged/closed admissions before reading transport, touching callbacks or acquiring stores.
    const config = linuxSessionConfig(options.admission), binding = linuxSessionBindings(options.admission), profile = linuxSessionProfile(options.admission);
    if (typeof options.write !== "function" || typeof options.writeErr !== "function" || typeof options.onProtectedStoreOwnershipOutcome !== "function") throw new Error("Linux session transport/lifecycle observer unavailable");
    for (const signal of [binding.signal, options.signal]) {
      if (signal === undefined) continue;
      signal.addEventListener("abort", cancel, { once: true }); signals.push(signal);
      if (signal.aborted) cancel();
    }
    return await runEmbeddedSession({
      argv: ["--run", "--config-json", JSON.stringify(config)], env: {},
      linuxSessionAdmission: options.admission, protectedStoreBootstrap: binding.store,
      input: boundedLinuxSessionInput(options.input, cancel, profile !== "fresh"), signal: controller.signal,
      write: boundedLinuxSessionOutput(options.write, cancel), writeErr: boundedLinuxSessionOutput(options.writeErr, cancel),
      onProtectedStoreOwnershipOutcome: options.onProtectedStoreOwnershipOutcome,
    });
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", cancel);
    // Entry-owned handle cleanup is distinct from retained native store ownership.
    closeLinuxSession(options.admission);
  }
}
