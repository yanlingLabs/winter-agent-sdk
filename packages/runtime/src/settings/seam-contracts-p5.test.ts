// RULING R5-2 (2026-09-04-winter-phase-05-workflows-skills-context.md): every seam Task 2/Task 3
// ships is accompanied by an executable contract test -- a PRODUCER FAKE plus the CONSUMER
// SEMANTICS -- that both sides keep green. This is the P4 file's own shape (tools/
// seam-contracts-p4.test.ts, subagents/seam-contracts-p4.test.ts) carried into Phase 5.
//
// LANES W/S/C/K: THIS FILE IS THE SEAM AUTHORITY -- keep it green; do not edit it. If your change
// makes one of these tests fail, your change is inconsistent with the seam contract Task 2 pinned,
// not a reason to relax the assertion. If the contract itself is genuinely wrong, that is a spine
// change: raise it with the controller rather than editing this file from a lane worktree (R5-12's
// no-touch list names this task's files, not lane territory).
//
// Sections, one per seam Task 2 produces:
//   (i)   the provider seam extension -- ProviderRequest.system, ProviderTurn.usage, ContextAccountant (R5-3)
//   (ii)  onCompaction -- the deferred loaded-set reset (R5-4 / WS-09 §8.5)
//   (iii) settings resolution + the two trust filters (R5-8 as amended, RULING P5-A)
//   (iv)  the WorkspaceTrustSource seam (R5-6 -> P5-A)
//   (v)   loadAgentDefinitions' pluginAgents tier (R4-7 carry)
//   (vi)  buildHookEntriesFromSettings -> buildHookRegistry (WS-08 OQ3 absorbed here)
//   (vii) ajv (R5-7) -- both dialects, and the error shape capture (6) observed
import { describe, test, expect } from "bun:test";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createContextAccountant,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type ContextAccountant,
  type Provider,
  type ProviderRequest,
  type ProviderTurn,
  type ProviderUsage,
} from "../engine.ts";
import { echoProvider, scriptedProvider, testProviderByName, recordedProviderSystems, resetRecordedProviderSystems } from "../provider/mock.ts";
import "../tools/descriptors/index.ts";
import {
  createLoadedToolSet,
  getRegisteredTool,
  isLoadFirstBlocked,
  onCompaction,
  onRegistryChange,
  registerMcpServerTools,
  resolveDeferral,
  unregisterMcpServerTools,
  type DeferralActivation,
} from "../tools/registry.ts";
import { loadAgentDefinitions } from "../subagents/definitions.ts";

// --- (i) the provider seam extension (R5-3) -------------------------------------------------------

describe("(i) provider seam: system prompt in, usage out, and the accountant that reads it", () => {
  test("a PRODUCER passes `system` alongside `messages`; a CONSUMER may ignore it and still satisfy Provider", async () => {
    let seen: ProviderRequest | undefined;
    const consumer: Provider = {
      async generate(input) {
        seen = input;
        return { kind: "text", text: "ok" };
      },
    };
    await consumer.generate({ messages: [{ role: "user", content: "hi" }], system: "you are winter" });
    expect(seen?.system).toBe("you are winter");
    expect(seen?.messages).toHaveLength(1);
    // `system` is OPTIONAL: a producer that has no assembled prompt yet omits the key entirely,
    // which is exactly what runEngine does at Task 2 (Task 3 owns the one producer -- there must
    // never be a second, per the "sweep producers by MEANING" lesson).
    await consumer.generate({ messages: [] });
    expect(seen).not.toHaveProperty("system");
  });

  test("the mock provider records the `system` it was handed, on EVERY mode", async () => {
    resetRecordedProviderSystems();
    await echoProvider.generate({ messages: [{ role: "user", content: "hi" }], system: "S1" });
    await scriptedProvider([{ kind: "text", text: "x" }]).generate({ messages: [], system: "S2" });
    await testProviderByName("reflect").generate({ messages: [], system: "S3" });
    expect(recordedProviderSystems()).toEqual(["S1", "S2", "S3"]);
  });

  test("recording never changes a mock mode's own behaviour", async () => {
    resetRecordedProviderSystems();
    const echoed = await echoProvider.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(echoed).toMatchObject({ kind: "text", text: "echo: hi" });

    const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "c1", name: "t", input: {} }] }]);
    expect(await scripted.generate({ messages: [] })).toMatchObject({ kind: "tool_use" });
    // still throws once exhausted -- the wrapper must not swallow it
    await expect(scripted.generate({ messages: [] })).rejects.toThrow("no more scripted turns");

    const boom = testProviderByName("boom");
    await expect(boom.generate({ messages: [] })).rejects.toThrow("scripted failure");
  });

  test("a mock turn carries synthetic `usage` -- deterministic, and never overwriting a turn that already has one", async () => {
    const a = await echoProvider.generate({ messages: [{ role: "user", content: "hello there" }] });
    const b = await echoProvider.generate({ messages: [{ role: "user", content: "hello there" }] });
    expect(a.usage).toBeDefined();
    expect(a.usage).toEqual(b.usage as ProviderUsage); // same input -> same synthetic usage
    expect(a.usage!.inputTokens).toBeGreaterThan(0);
    expect(a.usage!.outputTokens).toBeGreaterThan(0);

    const explicit: ProviderTurn = { kind: "text", text: "x", usage: { inputTokens: 7, outputTokens: 9 } };
    const scripted = await scriptedProvider([explicit]).generate({ messages: [] });
    expect(scripted.usage).toEqual({ inputTokens: 7, outputTokens: 9 });
  });

  test("ContextAccountant: contextTokens() is the LAST turn's input+output, not a running total (R5-3 verbatim)", () => {
    const accountant: ContextAccountant = createContextAccountant();
    expect(accountant.contextTokens()).toBe(0); // nothing recorded yet
    accountant.record({ inputTokens: 100, outputTokens: 20 });
    expect(accountant.contextTokens()).toBe(120);
    accountant.record({ inputTokens: 500, outputTokens: 5 });
    expect(accountant.contextTokens()).toBe(505); // replaced, never 625
  });

  test("ContextAccountant: cache counters are informational and never enter contextTokens()", () => {
    const accountant = createContextAccountant();
    accountant.record({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 9000, cacheWriteTokens: 9000 });
    expect(accountant.contextTokens()).toBe(11);
  });

  test("ContextAccountant: limit() defaults to the disclosed 200000 and is configurable per session", () => {
    expect(createContextAccountant().limit()).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(createContextAccountant().limit()).toBe(200000);
    expect(createContextAccountant({ limit: 8000 }).limit()).toBe(8000);
  });

  test("ContextAccountant: the compaction trigger a consumer computes from it (R5-4's threshold read)", () => {
    const accountant = createContextAccountant({ limit: 1000 });
    const overThreshold = (threshold: number) => accountant.contextTokens() >= threshold * accountant.limit();
    accountant.record({ inputTokens: 900, outputTokens: 19 });
    expect(overThreshold(0.92)).toBe(false); // 919 < 920
    accountant.record({ inputTokens: 900, outputTokens: 20 });
    expect(overThreshold(0.92)).toBe(true); // 920 >= 920 -- AT the threshold counts
  });
});

// --- (ii) onCompaction: the deferred loaded-set reset (R5-4 / WS-09 §8.5) -------------------------

describe("(ii) onCompaction resets the deferred loaded set to `evidenced` and announces it", () => {
  const SRV = "p5onCompactionSrv";

  function withMcpServer<T>(fn: () => T): T {
    registerMcpServerTools(
      SRV,
      [
        { name: "alpha", inputSchema: { type: "object" } },
        { name: "beta", inputSchema: { type: "object" } },
        { name: "gamma", inputSchema: { type: "object" } },
      ],
      { deferredDefault: true },
    );
    try {
      return fn();
    } finally {
      unregisterMcpServerTools(SRV);
    }
  }

  test("a deferred tool NOT in `evidenced` becomes searchable-not-loaded again; an evidenced one stays loaded", () => {
    withMcpServer(() => {
      const alpha = `mcp__${SRV}__alpha`;
      const beta = `mcp__${SRV}__beta`;
      const activation: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
      const loaded = createLoadedToolSet();
      loaded.load([alpha, beta]);
      expect(isLoadFirstBlocked(alpha, "default", activation, loaded)).toBe(false);
      expect(isLoadFirstBlocked(beta, "default", activation, loaded)).toBe(false);

      onCompaction(loaded, [alpha]);

      expect(loaded.isLoaded(alpha)).toBe(true);
      expect(loaded.isLoaded(beta)).toBe(false);
      // "searchable-not-loaded": still a registered, still a DEFERRED descriptor -- so ToolSearch can
      // find it again -- but blocked from execution until it is re-loaded.
      expect(resolveDeferral(getRegisteredTool(beta)!.descriptor, "default", activation)).toBe("deferred");
      expect(isLoadFirstBlocked(beta, "default", activation, loaded)).toBe(true);
    });
  });

  test("it INTERSECTS -- a name in `evidenced` that was never loaded does not become loaded", () => {
    withMcpServer(() => {
      const loaded = createLoadedToolSet();
      loaded.load([`mcp__${SRV}__alpha`]);
      onCompaction(loaded, [`mcp__${SRV}__alpha`, `mcp__${SRV}__gamma`]);
      expect(loaded.snapshot().sort()).toEqual([`mcp__${SRV}__alpha`]);
    });
  });

  test("an evidenced name whose descriptor is GONE (its server disconnected mid-session) is dropped too", () => {
    const alpha = `mcp__${SRV}__alpha`;
    const loaded = createLoadedToolSet();
    withMcpServer(() => {
      loaded.load([alpha]);
      expect(loaded.isLoaded(alpha)).toBe(true);
    });
    // server unregistered by withMcpServer's finally -- the name is evidenced but no longer registered
    onCompaction(loaded, [alpha]);
    expect(loaded.isLoaded(alpha)).toBe(false);
  });

  test("an empty `evidenced` clears the set entirely", () => {
    withMcpServer(() => {
      const loaded = createLoadedToolSet();
      loaded.load([`mcp__${SRV}__alpha`, `mcp__${SRV}__beta`]);
      onCompaction(loaded, []);
      expect(loaded.snapshot()).toEqual([]);
    });
  });

  test("it fires onRegistryChange EXACTLY ONCE per call -- the advertised set changed, and a consumer that re-derives init.tools must be told", () => {
    withMcpServer(() => {
      const loaded = createLoadedToolSet();
      loaded.load([`mcp__${SRV}__alpha`, `mcp__${SRV}__beta`]);
      let changes = 0;
      const unsubscribe = onRegistryChange(() => {
        changes++;
      });
      try {
        onCompaction(loaded, [`mcp__${SRV}__alpha`]);
        expect(changes).toBe(1);
        onCompaction(loaded, []);
        expect(changes).toBe(2);
      } finally {
        unsubscribe();
      }
    });
  });

  test("it is idempotent: compacting twice with the same evidence changes nothing the second time", () => {
    withMcpServer(() => {
      const loaded = createLoadedToolSet();
      loaded.load([`mcp__${SRV}__alpha`, `mcp__${SRV}__beta`]);
      onCompaction(loaded, [`mcp__${SRV}__alpha`]);
      const first = loaded.snapshot().sort();
      onCompaction(loaded, [`mcp__${SRV}__alpha`]);
      expect(loaded.snapshot().sort()).toEqual(first);
    });
  });
});

// --- (v) loadAgentDefinitions' pluginAgents tier (the P4 carry behind R4-7) ----------------------

describe("(v) pluginAgents is a FOURTH definition source, at the BOTTOM of the precedence chain", () => {
  function agentFile(dir: string, name: string, body: string, description: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n${body}\n`);
  }

  const pluginAgent = (plugin: string, prompt: string) => ({ description: `from ${plugin}`, prompt, plugin });

  test("a plugin agent loads when no other source claims the name", () => {
    withTempTree(({ cwd, home }) => {
      const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, pluginAgents: { reviewer: pluginAgent("acme", "plugin body") } });
      expect(defs.get("reviewer")?.prompt).toBe("plugin body");
      expect(defs.get("reviewer")?._source).toBe("plugin");
      expect(defs.get("reviewer")?._plugin).toBe("acme");
    });
  });

  test("precedence is programmatic > project > user > plugin (R4-7), verified one rung at a time", () => {
    withTempTree(({ cwd, home }) => {
      agentFile(join(home, ".winter", "agents"), "reviewer", "user body", "user");
      agentFile(join(cwd, ".winter", "agents"), "reviewer", "project body", "project");
      const plugins = { reviewer: pluginAgent("acme", "plugin body") };

      // plugin alone
      expect(loadAgentDefinitions({ cwd: join(cwd, "empty"), home: join(home, "empty"), trustedWorkspace: true, pluginAgents: plugins }).get("reviewer")?._source).toBe("plugin");
      // user beats plugin
      expect(loadAgentDefinitions({ cwd: join(cwd, "empty"), home, trustedWorkspace: true, pluginAgents: plugins }).get("reviewer")?._source).toBe("user");
      // project beats user (trusted)
      expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true, pluginAgents: plugins }).get("reviewer")?._source).toBe("project");
      // programmatic beats everything
      const programmatic = { reviewer: { description: "prog", prompt: "programmatic body" } };
      expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true, pluginAgents: plugins, programmatic }).get("reviewer")?._source).toBe("programmatic");
    });
  });

  test("plugin agents are NOT workspace-trust gated -- loading the plugin at all is the host's own decision (R4-7 gates .winter/agents, not this)", () => {
    withTempTree(({ cwd, home }) => {
      const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, pluginAgents: { helper: pluginAgent("acme", "body") } });
      expect(defs.get("helper")?._source).toBe("plugin");
    });
  });

  test("the `plugin` marker never leaks into the definition itself -- it becomes _plugin, alongside _source", () => {
    withTempTree(({ cwd, home }) => {
      const def = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, pluginAgents: { helper: pluginAgent("acme", "body") } }).get("helper");
      expect(def).not.toHaveProperty("plugin");
      expect(def?._plugin).toBe("acme");
    });
  });

  test("two plugins contributing DIFFERENT names both load; only a name collision shadows", () => {
    withTempTree(({ cwd, home }) => {
      const defs = loadAgentDefinitions({
        cwd,
        home,
        trustedWorkspace: false,
        pluginAgents: { alpha: pluginAgent("acme", "a"), beta: pluginAgent("other", "b") },
      });
      expect([...defs.keys()].sort()).toEqual(["alpha", "beta"]);
      expect(defs.get("beta")?._plugin).toBe("other");
    });
  });

  test("omitting pluginAgents entirely is byte-identical to the pre-P5 behaviour", () => {
    withTempTree(({ cwd, home }) => {
      agentFile(join(home, ".winter", "agents"), "reviewer", "user body", "user");
      const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false });
      expect([...defs.keys()]).toEqual(["reviewer"]);
      expect(defs.get("reviewer")?._source).toBe("user");
      expect(defs.get("reviewer")).not.toHaveProperty("_plugin");
    });
  });
});

// --- (vii) ajv (R5-7) -----------------------------------------------------------------------------

describe("(vii) ajv is a real runtime dependency, in both dialects Lane K/Lane W need", () => {
  test("draft-07 compiles and validates through the default entry point", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile({ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false });
    expect(validate({ x: 1 })).toBe(true);
    expect(validate({ x: "no" })).toBe(false);
  });

  test("2020-12 compiles through ajv/dist/2020 -- a SEPARATE constructor, not a flag on the default one", () => {
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { x: { type: "number" } }, required: ["x"] });
    expect(validate({ x: 1 })).toBe(true);
    expect(validate({})).toBe(false);
  });

  test("a validation failure names the JSON-Pointer path and the expected type -- capture (6)'s observed error shape", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile({ type: "object", properties: { x: { type: "number" } }, required: ["x"] });
    validate({ x: "not-a-number" });
    const first = validate.errors?.[0];
    expect(first?.instancePath).toBe("/x");
    expect(first?.message).toContain("number");
  });
});

// Shared throwaway-directory helper for the sections that touch the filesystem (added by the later
// slices below). Every one uses mkdtemp roots -- never ~/.winter, ~/.norma, ~/.claude (phase Global
// Constraints).
export function withTempTree<T>(fn: (dirs: { cwd: string; home: string }) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "winter-p5-seam-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "winter-p5-seam-home-"));
  try {
    return fn({ cwd, home });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
