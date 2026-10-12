/** Immutable fixture entry: actual embedded SDK lifecycle, never a replacement agent loop.
 * No config-json/env/NDJSON can manufacture this fresh native admission. */
import { runEmbeddedSession } from "../../packages/runtime/src/embedded.ts";
import { admitFreshLinuxSession, linuxSessionBindings, linuxSessionConfig, closeLinuxSession } from "../../packages/runtime/src/guest/linux-session-admission.ts";
import type { UserFrame } from "@yanlinglabs/winter-agent-sdk";

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--native-bootstrap-fd", "3", "--native-owner-fd", "4"])) throw new Error("fixed native entry required");
const admission = admitFreshLinuxSession(3, 4);
const config = linuxSessionConfig(admission), binding = linuxSessionBindings(admission);
const userFrame: UserFrame = { type: "user", text: "Exercise the admitted source: Read seed, Edit hello to edited, Write written, then foreground Bash and report completion." };
let bytes = 0;
try {
  const code = await runEmbeddedSession({
    argv: ["--run", "--config-json", JSON.stringify(config)], env: {},
    linuxSessionAdmission: admission, protectedStoreBootstrap: binding.store,
    signal: binding.signal,
    input: (async function* () { yield JSON.stringify(userFrame) + "\n"; })(),
    write(chunk) { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) throw new Error("fixture output limit"); process.stdout.write(chunk); },
    writeErr(chunk) { process.stderr.write(chunk); },
    // Returning while alive is explicitly not native termination proof.
    onProtectedStoreOwnershipOutcome(outcome) { process.stderr.write(JSON.stringify({ freshStoreOutcome: outcome }) + "\n"); },
  });
  process.exitCode = code;
} finally { closeLinuxSession(admission); }
