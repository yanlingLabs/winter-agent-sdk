// WS-23 review (I-1, M-1): source guards for what an EMBEDDED session must never do, because inside a
// Worker it reaches the host daemon's process-wide state.
//   - `process.chdir` / `process.umask(mask)`: process-wide even from a Worker (measured). The Worker
//     entry also makes both throw; this keeps the sources from depending on them at all.
//   - `?? process.cwd()`: a fallback that silently becomes the DAEMON's cwd inside a Worker. The
//     runtime and provider-runtime take the session cwd explicitly; two sdk (wrapper) sites run on
//     the HOST side, where the process cwd is the right default -- listed with why.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..");
const TREES = ["runtime/src", "provider-runtime/src", "sdk/src"];

function sources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".fixture.ts") && !entry.name.endsWith(".d.ts")) {
        out.push({ path: relative(PACKAGES, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  for (const tree of TREES) walk(join(PACKAGES, tree));
  return out;
}

/** Code lines only: a comment that names the call is documentation, not a call. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

describe("embedded-session source guards", () => {
  test("no source calls process.chdir or process.umask(...) -- the Worker entry's fence is the only mention", () => {
    const hits = sources()
      .filter((s) => s.path !== "runtime/src/embedded-worker.ts")
      .flatMap((s) => codeLines(s.text).filter((l) => /process\.chdir\b|process\.umask\s*\(/.test(l)).map((l) => `${s.path}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  test("no `?? process.cwd()` fallback outside the two host-side wrapper sites", () => {
    const HOST_SIDE: Record<string, string> = {
      "sdk/src/query.ts": "the wrapper's Options.cwd default -- runs in the HOST, whose cwd a host that states none means",
      "sdk/src/settings/resolve.ts": "resolveSettings/resolveSettingsDetailed are PINNED public exports (optional opts); the runtime's one caller passes the session cwd",
    };
    const hits = sources()
      .filter((s) => HOST_SIDE[s.path] === undefined)
      .flatMap((s) => codeLines(s.text).filter((l) => /\?\?\s*process\.cwd\(\)/.test(l)).map((l) => `${s.path}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
});
