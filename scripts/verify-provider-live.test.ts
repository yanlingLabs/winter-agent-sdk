// Phase 6 Task 8 (Lane D): the live gate's OPT-OUT is what this file proves.
//
// The live script itself is never exercised against a provider here — that is the whole point of it
// being opt-in. What must be true on every machine, including a developer's with real keys exported,
// is that a plain `bun test` cannot make it reach a vendor. So the fixtures below drive the pure
// planner directly, and then SPAWN the real script with every `WINTER_LIVE_*` variable stripped from
// the environment and assert on its exact output and exit code.
//
// Stripping rather than merely not-adding is the load-bearing part: `bun test` inherits the shell,
// and a developer who exported `WINTER_LIVE_OPENAI_API_KEY` an hour ago would otherwise have this
// very test spend their money.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { normalizeHttpError } from "@yanlinglabs/winter-provider-runtime";
import { errorResponse, startFake } from "winter-provider-conformance";
import { ADAPTERS_MODULE_VAR, collectAdapters, liveEnvPrefix, OPT_IN_VAR, planLiveRun, SKIPPED_LINE } from "./verify-provider-live.ts";

const CATALOG = loadCatalog();

/** `process.env` with every live-gate variable removed. Used for BOTH the in-process planner and the spawned child. */
function strippedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WINTER_LIVE")) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

describe("the environment variable spelling", () => {
  test("is one function for all three variables", () => {
    expect(liveEnvPrefix("openai")).toBe("WINTER_LIVE_OPENAI");
    expect(liveEnvPrefix("codex-oauth")).toBe("WINTER_LIVE_CODEX_OAUTH");
    expect(liveEnvPrefix("ollama-local")).toBe("WINTER_LIVE_OLLAMA_LOCAL");
    expect(liveEnvPrefix("azure-openai")).toBe("WINTER_LIVE_AZURE_OPENAI");
  });
});

describe("planLiveRun refuses by default", () => {
  test("no opt-in variable at all", () => {
    expect(planLiveRun(strippedEnv(), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("the opt-in variable set to anything but `1`", () => {
    for (const value of ["", "0", "true", "yes", "01"]) {
      expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: value }), CATALOG).optedIn).toBe(false);
    }
  });

  test("opted in but with NO provider key -- the case a CI runner would hit", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1" }), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("a key WITHOUT the opt-in variable is still nothing -- both are required", () => {
    expect(planLiveRun(strippedEnv({ WINTER_LIVE_OPENAI_API_KEY: "test-key-x" }), CATALOG).optedIn).toBe(false);
  });

  test("a blank key does not select a provider", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "   " }), CATALOG).optedIn).toBe(false);
  });

  test("an ambient conventional key is NEVER read (R6-10: no implicit scan)", () => {
    // The one variable a real developer is most likely to have exported.
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", OPENAI_API_KEY: "test-key-ambient-not-mine", ANTHROPIC_API_KEY: "test-key-ambient-not-mine" }), CATALOG);
    expect(plan.optedIn).toBe(false);
  });
});

describe("planLiveRun selects exactly what was named", () => {
  test("one provider, its default model from the catalog", () => {
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-x" }), CATALOG);
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.providerId).toBe("openai");
    expect(plan.targets[0]!.keyEnvName).toBe("WINTER_LIVE_OPENAI_API_KEY");
    expect(plan.targets[0]!.model).toBe(CATALOG.models.find((m) => m.providerId === "openai")!.key);
    expect("baseUrl" in plan.targets[0]!).toBe(false);
  });

  test("the model override wins, and a base url rides along", () => {
    const plan = planLiveRun(
      strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL_API_KEY: "unused", WINTER_LIVE_OLLAMA_LOCAL_MODEL: "qwen3:4b", WINTER_LIVE_OLLAMA_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" }),
      CATALOG,
    );
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets).toEqual([{ providerId: "ollama-local", keyEnvName: "WINTER_LIVE_OLLAMA_LOCAL_API_KEY", model: "qwen3:4b", baseUrl: "http://127.0.0.1:11434/v1" }]);
  });

  test("two named providers produce two targets, and nothing else does", () => {
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-a", WINTER_LIVE_ANTHROPIC_API_KEY: "test-key-b" }), CATALOG);
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets.map((t) => t.providerId).sort()).toEqual(["anthropic", "openai"]);
  });

  test("a key naming a provider the catalog does not have selects nothing", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_NOT_A_PROVIDER_API_KEY: "test-key-x" }), CATALOG).optedIn).toBe(false);
  });
});

describe("collectAdapters duck-types whatever a lane's barrel exports", () => {
  const adapter = (id: string) => ({ id, version: "1.0.0", family: "openai", protocol: "openai-responses", streamTurn: () => {}, validateCredential: async () => ({ ok: true }), listModels: async () => ({}), mapEffort: () => ({}), capabilities: () => ({}) });

  test("finds them in an exported array, in a named export, and in a nested record", () => {
    expect(collectAdapters({ adapters: [adapter("a"), adapter("b")] }).map((a) => a.id)).toEqual(["a", "b"]);
    expect(collectAdapters({ openaiResponses: adapter("c") }).map((a) => a.id)).toEqual(["c"]);
    expect(collectAdapters({ byFamily: { openai: adapter("d") } }).map((a) => a.id)).toEqual(["d"]);
  });

  test("de-duplicates by adapter id", () => {
    const one = adapter("dup");
    expect(collectAdapters({ a: one, b: [one] })).toHaveLength(1);
  });

  test("ignores anything that is not adapter-SHAPED -- an export name is never trusted", () => {
    expect(collectAdapters({ adapters: [{ id: "x" }, null, 3, "s", { id: "y", version: "1", streamTurn: 5, validateCredential: 6 }] })).toEqual([]);
    expect(collectAdapters({})).toEqual([]);
  });
});

/** Spawns the real script with a stripped environment plus `extra`, and collects everything it wrote. */
async function run(extra: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "verify-provider-live.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: strippedEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    proc.kill();
  }
}

describe("the script itself, spawned", () => {

  test("with no opt-in it prints ONE line and exits 0", async () => {
    const result = await run({});
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
    expect(result.stderr).toBe("");
  }, 30_000);

  test("opted in but with no provider key, it STILL skips -- a CI runner cannot go live by accident", async () => {
    const result = await run({ [OPT_IN_VAR]: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
  }, 30_000);

  test("opted in with an ambient conventional key present, it still skips", async () => {
    const result = await run({ [OPT_IN_VAR]: "1", OPENAI_API_KEY: "test-key-ambient-must-not-be-used", ANTHROPIC_API_KEY: "test-key-ambient-must-not-be-used" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Review round 1, I1: a provider's response body must never reach the operator's terminal.
//
// The hazard is not hypothetical and not this file's invention: `normalizeHttpError`
// (provider-runtime/src/errors.ts) puts a 200-character snippet of the provider's error BODY into
// `ProviderError.message`, and `ProviderRequestError` carries that message as a real `Error`. The
// first assertion below pins that premise against the real normalizer rather than assuming it; the
// spawned run then proves the gate never prints it.
// ---------------------------------------------------------------------------------------------
describe("a provider's response body never reaches stdout or stderr", () => {
  const MARKER = "MARKER-provider-body-must-not-be-printed-9f3a";

  test("PREMISE: the real normalizer does put the response body into the error message", () => {
    const err = normalizeHttpError(500, new Headers(), JSON.stringify({ error: { message: MARKER, code: "internal_error" } }));
    // If this ever stops being true the fixture below would pass vacuously, so it is asserted rather
    // than assumed.
    expect(err.message).toContain(MARKER);
    expect(err.providerCode).toBe("internal_error");
  });

  test("a live run whose adapter fails prints identity only -- never the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-live-render-"));
    const fake = await startFake({
      routes: [
        {
          path: "/*",
          handler: () => errorResponse(500, { error: { message: MARKER, code: "internal_error" } }),
        },
      ],
    });
    try {
      // A self-contained adapter module: it imports NOTHING, because a file in the OS temp directory
      // cannot resolve this workspace's packages. It reproduces the exact observable shape of a
      // `ProviderRequestError` built by `normalizeHttpError` -- the shape the assertion above pins --
      // and it reaches the fake with a real fetch, so the marker in the thrown message really did
      // come off the wire.
      writeFileSync(
        join(dir, "adapters.ts"),
        `class ProviderRequestError extends Error {
  code; status; providerCode; retryable;
  constructor(fields) {
    super(fields.message);
    this.name = "ProviderRequestError";
    this.code = fields.code;
    this.status = fields.status;
    this.providerCode = fields.providerCode;
    this.retryable = fields.retryable;
  }
}
async function failFromWire(ctx) {
  const res = await fetch(ctx.connection.baseUrl);
  const body = await res.text();
  throw new ProviderRequestError({ code: "server", message: "HTTP " + res.status + " \\u2014 " + body.slice(0, 200), status: res.status, providerCode: "internal_error", retryable: true });
}
export const adapters = [
  {
    id: "winter.openai-responses",
    version: "0.0.0-fixture",
    family: "openai",
    protocol: "openai-responses",
    async validateCredential() { return { ok: true }; },
    async listModels(ctx) { return failFromWire(ctx); },
    streamTurn(_req, ctx) { return (async function* () { yield* []; await failFromWire(ctx); })(); },
    async countTokens(_req, ctx) { return failFromWire(ctx); },
    mapEffort() { return { ok: true, value: undefined }; },
    capabilities() { return { toolCalling: "native", readableState: "none" }; },
  },
];
`,
        "utf8",
      );

      const result = await run({
        [OPT_IN_VAR]: "1",
        WINTER_LIVE_OPENAI_API_KEY: "test-key-live-render",
        WINTER_LIVE_OPENAI_BASE_URL: fake.url,
        [ADAPTERS_MODULE_VAR]: join(dir, "adapters.ts"),
      });

      const everything = `${result.stdout}\n${result.stderr}`;
      // The whole point.
      expect(everything).not.toContain(MARKER);
      // ...and it is not passing because nothing ran: the adapter WAS reached, the cases DID fail,
      // and what got printed was identity.
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(everything).toContain("winter.openai-responses@0.0.0-fixture");
      expect(everything).toContain("ProviderRequestError");
      expect(everything).toContain("code=server");
      expect(everything).toContain("status=500");
      expect(everything).toContain("providerCode=internal_error");
      expect(result.code).toBe(1);
      // The classifier leg's own throws collapse to a reason code, never a message.
      expect(everything).toContain("provider_error");
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
