// P7a (D19) -- THE END-TO-END REBRAND TEST.
//
// `brand-gate.test.ts` proves no file SPELLS a Winter-owned name. That is a necessary condition and
// not a sufficient one: every literal could be replaced by a correctly-derived constant that nothing
// ever threads a real profile into, and the gate would be just as green while a reuser's session
// still wrote into `~/.winter`. This file is the other half -- one session, one host-supplied
// profile, driven through the REAL wiring (`buildProductionWiring`, the real registry, the real
// adapters, mkdtemp homes), asserting that each of the thirteen names actually MOVED.
//
// WHY `acme` AND NOT A MUTATION OF `WINTER_BRAND`: every field differs from Winter's, so a value
// that failed to move is visibly Winter's rather than plausibly the reuser's.
//
// TWO FIELDS BEYOND THE TASK BRIEF'S OWN LIST, both forced by an obligation the brief states
// elsewhere: `packageName: "acme"` (the `User-Agent` obligation, `acme/<version>`, is a statement
// about `packageName` -- a profile leaving it as Winter's could not satisfy it) and
// `pluginManifestDir: ".acme-plugin"` (the `.claude-plugin` obligation is about a literal STAYING
// fixed BESIDE the brand's own dir, which needs the brand to have one). `processLabel` is left at
// Winter's on purpose: the spine recorded it as inert in this package (it names the PUBLISHED
// artifact's executable, not the host's product), so a fixture asserting it moved would be asserting
// a change nothing makes.
//
// HERMETIC, per the Global Constraints: mkdtemp homes and cwds, an in-memory credential store, a
// loopback fake bound to `127.0.0.1:0` and closed in `finally`, and NOTHING that reaches
// `~/.winter`, `~/.acme` or the Keychain. The temp-root assertion is deliberately a STRING
// comparison -- `/private/tmp/acme-<uid>` is a real shared directory and this test must not create
// one; the directory-creating half runs under an `ACME_TMPDIR` pointed at a mkdtemp.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrand, WINTER_BRAND, envName, mcpToolName, type BrandProfile, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { activeWinterIdentity, winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
// DEEP RELATIVE IMPORTS, and only into TEST-facing surfaces. The codex adapter, its quota manager
// and the Responses scenario table are not on `@yanlinglabs/winter-provider-runtime`'s or
// `…/winter-provider-conformance`'s public index -- the corpus test that already drives this exact
// adapter reaches them the same way (`corpus/openai.test.ts`). Widening a package's PUBLIC surface
// so one test can import from it would be the worse trade.
import { codexFake } from "@yanlinglabs/winter-provider-conformance";
import { createCodexOauthAdapter } from "../../provider-runtime/src/adapters/openai/codex-oauth.ts";
import { QuotaManager } from "../../provider-runtime/src/adapters/openai/quota.ts";
import { responsesCorpusScenarios } from "../../provider-conformance/src/corpus/openai-scenarios.ts";
import { SCENARIO } from "../../provider-conformance/src/corpus/openai.ts";
import { testContext, FAST_RETRY } from "../../provider-runtime/src/adapters/openai/testing.ts";
import { buildProductionWiring } from "./production-wiring.ts";
import { getRegisteredTool } from "./tools/registry.ts";
import { canonicalAliases, effectiveAliasTable } from "./toolsearch/aliases.ts";
import { sessionTempDir, resolveTempBase } from "./paths/temp.ts";
import { resolveSessionKeychainService } from "./provider/session-provider.ts";
import { WINTER_CODE_PRESET, winterCodePresetNames } from "./context/winter-code-preset.ts";
import { pluginManifestDirs, CLAUDE_PLUGIN_MANIFEST_DIR } from "./plugins/manifest.ts";
import { buildBaselineDenyRules } from "./engine.ts";
import {
  workflowScriptCarveOutSkip,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type EvaluationContext,
} from "./permissions/evaluator.ts";
import { emptyRuleSet } from "./permissions/ruleset.ts";

// --- the host's own product ----------------------------------------------------------------------

const ACME_PARTIAL: Partial<BrandProfile> = {
  productName: "Acme",
  packageName: "acme",
  homeDirName: ".acme",
  projectDirName: ".acme",
  instructionsFile: "ACME.md",
  envPrefix: "ACME_",
  mcpServerName: "acme",
  presetName: "acme_code",
  codexOriginator: "acme",
  tempRootName: "acme",
  keychainService: "com.acme.core",
  pluginManifestDir: ".acme-plugin",
};

const resolvedAcme = resolveBrand(ACME_PARTIAL);
if (!resolvedAcme.ok) throw new Error(`the acme fixture profile must be valid: ${resolvedAcme.reason}`);
const ACME: BrandProfile = resolvedAcme.brand;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDirNamed(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A branded session config. `winterHome` is deliberately NOT set: the point of the home assertion is
 * that `<PREFIX>HOME` is what resolves it, and an explicit root would answer the question for it.
 */
function acmeConfig(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    sessionId: "p7a-rebrand",
    cwd: process.cwd(),
    model: "winter-test/echo",
    persistSession: false,
    brand: ACME,
    ...over,
  } as RuntimeConfig;
}

/** `buildProductionWiring` against a branded config, always disposed. */
async function withWiring<T>(config: RuntimeConfig, env: Record<string, string | undefined>, body: (w: Awaited<ReturnType<typeof buildProductionWiring>>) => T | Promise<T>): Promise<T> {
  const wiring = await buildProductionWiring({
    config,
    env,
    // An in-memory store, never the composite -- the slot resolver probes credentials and the
    // Global Constraints forbid a test reaching the developer's Keychain.
    provider: { credentials: createMemoryCredentialStore([]) },
  });
  try {
    return await body(wiring);
  } finally {
    wiring.dispose();
  }
}

// ==================================================================================================

describe("P7a (D19): a host's own brand reaches every Winter-owned name", () => {
  test("`ACME_HOME` resolves the session's home, and `WINTER_HOME` beside it is IGNORED", async () => {
    const acmeHome = tempDirNamed("p7a-acme-home-");
    const winterDecoy = tempDirNamed("p7a-winter-decoy-");
    const cwd = tempDirNamed("p7a-cwd-");

    // Both set. Principle 4 one level down: a reuser's runtime must not honour OUR names.
    await withWiring(acmeConfig({ cwd }), { ACME_HOME: acmeHome, WINTER_HOME: winterDecoy }, (wiring) => {
      expect(wiring.engineOptions.winterHome).toBe(acmeHome);
      expect(wiring.engineOptions.winterHome).not.toBe(winterDecoy);
    });
  });

  test("the user and project instructions files are `ACME.md`; a `WINTER.md` beside them is not read", async () => {
    const acmeHome = tempDirNamed("p7a-acme-home-");
    const cwd = tempDirNamed("p7a-cwd-");
    writeFileSync(join(acmeHome, "ACME.md"), "ACME-USER-INSTRUCTIONS");
    writeFileSync(join(acmeHome, "WINTER.md"), "WINTER-USER-DECOY");
    writeFileSync(join(cwd, "ACME.md"), "ACME-PROJECT-INSTRUCTIONS");
    writeFileSync(join(cwd, "WINTER.md"), "WINTER-PROJECT-DECOY");

    const config = acmeConfig({ cwd, systemPrompt: { type: "preset", preset: "claude_code" } });
    await withWiring(config, { ACME_HOME: acmeHome }, (wiring) => {
      const assembled = wiring.engineOptions.systemPromptAssembler.assemble({
        config,
        cwd,
        platform: "darwin",
        osVersion: "test",
        shell: "/bin/zsh",
        date: "2026-09-07",
        planMode: false,
        env: { ACME_HOME: acmeHome },
      });
      const blocks = assembled.userContextBlocks.join("\n");
      expect(blocks).toContain("ACME-USER-INSTRUCTIONS");
      expect(blocks).toContain("ACME-PROJECT-INSTRUCTIONS");
      expect(blocks).not.toContain("WINTER-USER-DECOY");
      expect(blocks).not.toContain("WINTER-PROJECT-DECOY");
    });
  });

  test("the standing server's canonical twins are advertised as `mcp__acme__*`, and `dispose()` gives the names back", async () => {
    const acmeHome = tempDirNamed("p7a-acme-home-");
    const cwd = tempDirNamed("p7a-cwd-");
    const winterSend = mcpToolName(WINTER_BRAND, "send_message");
    const acmeSend = mcpToolName(ACME, "send_message");
    const acmeList = mcpToolName(ACME, "list_agents");

    // Before: Winter's own spelling, which is what a descriptor file registers at module load.
    expect(getRegisteredTool(winterSend)).toBeDefined();
    expect(getRegisteredTool(acmeSend)).toBeUndefined();

    await withWiring(acmeConfig({ cwd }), { ACME_HOME: acmeHome }, () => {
      // The registered tool, under the reuser's spelling, with its DESCRIPTOR renamed too -- an
      // entry whose descriptor still said `mcp__winter__…` would be advertised under that name.
      const twin = getRegisteredTool(acmeSend);
      expect(twin).toBeDefined();
      expect(twin?.descriptor.canonicalName).toBe(acmeSend);
      expect(twin?.descriptor.advertisedName).toBe(acmeSend);
      expect(getRegisteredTool(acmeList)?.descriptor.canonicalName).toBe(acmeList);
      expect(getRegisteredTool(winterSend)).toBeUndefined();

      // ...and the ALIAS TABLE points at the same spelling. This is the pairing that matters: a
      // table naming a tool nobody registered makes `SendMessage`'s canonical target resolve to
      // nothing, which is exactly what deriving only one of the two halves would have produced.
      expect(canonicalAliases(ACME)).toEqual({ SendMessage: acmeSend, ListAgents: acmeList });
      expect(effectiveAliasTable(undefined, ACME)["SendMessage"]).toBe(acmeSend);
      expect(getRegisteredTool(effectiveAliasTable(undefined, ACME)["SendMessage"] as string)).toBeDefined();
    });

    // After teardown the process-global registry is exactly as it was.
    expect(getRegisteredTool(winterSend)).toBeDefined();
    expect(getRegisteredTool(acmeSend)).toBeUndefined();
  });

  test("the shared temp root is `/private/tmp/acme-<uid>` -- computed as a STRING, never created", () => {
    // `/private/tmp` is shared between every user on the machine and this suite must not mkdir into
    // it (D18's own reason for the uid suffix). So the default-base derivation is asserted as the
    // string it would produce, and the directory-creating half runs under `ACME_TMPDIR` below.
    const uid = process.getuid!();
    expect(resolveTempBase({}, ACME)).toBe("/tmp");
    expect(join(realpathSync(resolveTempBase({}, ACME)), `${ACME.tempRootName}-${uid}`)).toBe(`/private/tmp/acme-${uid}`);

    // The real function, under a mkdtemp base named by the brand's OWN env variable.
    const base = tempDirNamed("p7a-acme-tmp-");
    const paths = sessionTempDir({
      tempProjectKey: "proj",
      backendUuid: "11111111-1111-4111-8111-111111111111",
      env: { [envName(ACME, "TMPDIR")]: base, WINTER_TMPDIR: "/nonexistent-decoy" },
      brand: ACME,
    });
    // <base>/acme-<uid>/acme-<uid>/proj/<uuid> -- the shared root and the engine dir, both branded.
    expect(paths.root).toBe(join(realpathSync(base), `acme-${uid}`, `acme-${uid}`, "proj", "11111111-1111-4111-8111-111111111111"));
    expect(paths.root).not.toContain(`winter-${uid}`);
  });

  test("the codex `originator` and the `User-Agent` on the WIRE are the reuser's, not Winter's", async () => {
    const acmeHome = tempDirNamed("p7a-acme-home-");
    const cwd = tempDirNamed("p7a-cwd-");
    const fake = await codexFake.startCodexFake({ scenarios: responsesCorpusScenarios() });
    try {
      await withWiring(acmeConfig({ cwd }), { ACME_HOME: acmeHome }, async () => {
        // The identity the whole adapter family reads, installed by the session's own wiring.
        expect(activeWinterIdentity()).toEqual({ product: "acme", codexOriginator: "acme" });
        expect(winterUserAgent().startsWith("acme/")).toBe(true);

        const ref = { kind: "keychain", account: `codex-oauth:${codexFake.FAKE_ACCOUNT_ID}` } as const;
        const credentials = createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: codexFake.FAKE_ACCESS_TOKEN, refreshToken: codexFake.FAKE_REFRESH_TOKEN, accountId: codexFake.FAKE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 }]]);
        const adapter = createCodexOauthAdapter({
          generatedBaseUrl: fake.url,
          tokenUrl: `${fake.url}/oauth/token`,
          retry: FAST_RETRY,
          quota: new QuotaManager(),
          descriptors: () => undefined,
        });
        // `testContext` supplies NO `baseUrl`: the codex backend is the adapter's own
        // `generatedBaseUrl`, and a loopback URL arriving as a USER endpoint would be refused by the
        // endpoint policy before a request was ever made.
        const ctx = { ...testContext({ providerId: "codex-oauth", stallTimeoutMs: 5_000 }), credentials, authRef: ref };
        const events = [];
        for await (const event of adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, ctx)) events.push(event);
        expect(events.filter((e) => e.type === "error")).toEqual([]);

        const turn = fake.requests.find((r: { path: string }) => r.path.endsWith("/responses"));
        expect(turn).toBeDefined();
        // WS-01 §3's hard rule, one level down: the originator is never a FIRST-PARTY value, and it
        // is never somebody ELSE's product either.
        expect(turn?.headers.originator).toBe("acme");
        expect(turn?.headers["user-agent"]).toBe(winterUserAgent());
        expect(turn?.headers["user-agent"]?.startsWith("winter-agent-sdk/")).toBe(false);
      });
    } finally {
      await fake.close();
    }

    // The identity is a per-session installation, given back on teardown.
    expect(activeWinterIdentity()).toEqual({ product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator });
  });

  test("R-7a-8: the keychain store and the cross-provider `authRef` read ONE source -- `com.acme.core`", () => {
    // The case that used to be wrong: a host that set ONLY `brand.keychainService`. `query()` does
    // emit the deprecated top-level key for such a session, but a reader of that key alone is a
    // half-fix that tests green, so the single source is a named function both sites call.
    expect(resolveSessionKeychainService(acmeConfig())).toBe("com.acme.core");

    // The two surfaces agree when both are present (the wrapper folds them), and the profile wins.
    expect(resolveSessionKeychainService(acmeConfig({ keychainService: "com.acme.core" }))).toBe("com.acme.core");

    // An UNBRANDED session that chose nothing still chooses nothing -- absent, never Winter's name
    // substituted in, which is what keeps `authRef` byte-identical to before P7a.
    expect(resolveSessionKeychainService({ sessionId: "s", cwd: process.cwd(), model: "winter-test/echo" } as RuntimeConfig)).toBeUndefined();
  });

  test("P7a fix r1 (I-2): the P5-B workflow-script carve-out follows the brand, so a branded session can still write its own scripts", () => {
    // WS-11 §1.3's edit-then-rerun loop -- persist the script, `Edit` it, re-invoke with
    // `{scriptPath}` -- rests on the managed `<home>/projects/**` write deny being SKIPPED for a
    // path inside the carve-out. `isProjectsBaselineDeny` matched `~/.winter/projects` literally,
    // while `buildBaselineDenyRules` now emits `~/.acme/projects` for a branded session and the
    // resolved-root twin is not emitted at all when `<PREFIX>HOME` is unset (the anchors coincide).
    // So every baseline entry failed the test, nothing was skipped, and the loop was denied outright.
    const home = "/synthetic/home/tester";
    const winterHome = join(home, ACME.homeDirName);
    const scriptPath = join(winterHome, "projects", "key", "uuid", "workflows", "scripts", "wf-abc.js");
    const entries = buildBaselineDenyRules(undefined, ACME);

    // The branded floor names the branded directory, and Winter's own is absent from it.
    const contents = entries.map((e) => e.ruleValue.ruleContent);
    expect(contents.some((c) => typeof c === "string" && c.startsWith("~/.acme/projects"))).toBe(true);
    expect(contents.some((c) => typeof c === "string" && c.includes(".winter"))).toBe(false);

    const ctx: EvaluationContext = {
      policy: { mode: "default", version: 0, rules: emptyRuleSet() },
      cwd: "/work",
      sessionRoot: "/work",
      home,
      trustedWorkspace: false,
      brand: ACME,
      hookStage: NO_OPINION_HOOK_STAGE,
      promptStage: NO_OPINION_PROMPT_STAGE,
      autoEngine: NO_OPINION_AUTO_ENGINE,
      specialChecks: NO_SPECIAL_CHECKS,
    };
    const skip = workflowScriptCarveOutSkip({ toolName: "Write", input: { file_path: scriptPath } }, ctx);
    expect(skip, "a write inside the carve-out must earn a skip predicate at all").toBeDefined();
    // EVERY managed `<home>/projects…` deny is skipped -- that is what unblocks the loop.
    const projectsDenies = entries.filter((e) => typeof e.ruleValue.ruleContent === "string" && (e.ruleValue.ruleContent as string).startsWith("~/.acme/projects"));
    expect(projectsDenies.length).toBeGreaterThan(0);
    expect(projectsDenies.every((e) => skip!(e))).toBe(true);
    // ...and nothing ELSE is: the backups floor and the run-dir denials are untouched by the skip.
    const others = entries.filter((e) => typeof e.ruleValue.ruleContent === "string" && !(e.ruleValue.ruleContent as string).startsWith("~/.acme/projects"));
    expect(others.some((e) => skip!(e))).toBe(false);

    // A sibling under the same session -- a transcript, not a script -- earns no carve-out at all.
    expect(workflowScriptCarveOutSkip({ toolName: "Write", input: { file_path: join(winterHome, "projects", "key", "uuid", "transcript.jsonl") } }, ctx)).toBeUndefined();
  });

  test("the preset's NAME follows the brand; its TEXT does not move by one byte", () => {
    expect(winterCodePresetNames(ACME)).toEqual(["claude_code", "acme_code"]);
    // `claude_code` is a Claude-MIRRORING literal (WS-01 §5) and stays fixed under every brand.
    expect(winterCodePresetNames(ACME)[0]).toBe("claude_code");
    // The authored text is Winter's whoever runs it -- WS-11 §6.2 is about CATEGORIES, not names.
    expect(WINTER_CODE_PRESET).toBe(WINTER_CODE_PRESET.trim());
    expect(WINTER_CODE_PRESET.length).toBeGreaterThan(0);
  });

  test("`.claude-plugin` stays literal beside the reuser's own manifest dir", () => {
    // The manifest directory the OFFICIAL runtime reads is not ours to rebrand (WS-01 §5): a plugin
    // authored for `@anthropic-ai/claude-agent-sdk` must keep loading after the package swap.
    expect(pluginManifestDirs(ACME)).toEqual([".acme-plugin", ".claude-plugin"]);
    expect(CLAUDE_PLUGIN_MANIFEST_DIR).toBe(".claude-plugin");
    // Preference order: the reuser's own spelling is read first.
    expect(pluginManifestDirs(ACME)[0]).toBe(".acme-plugin");
  });

  test("under the DEFAULT profile every derivation is byte-identical to Winter's own names", () => {
    // The other half of the contract: the whole suite is the proof, and this is the summary of it.
    expect(canonicalAliases()).toEqual({ SendMessage: "mcp__winter__send_message", ListAgents: "mcp__winter__list_agents" });
    expect(winterCodePresetNames()).toEqual(["claude_code", "winter_code"]);
    expect(pluginManifestDirs()).toEqual([".winter-plugin", ".claude-plugin"]);
    expect(envName(WINTER_BRAND, "HOME")).toBe("WINTER_HOME");
    expect(WINTER_BRAND.keychainService).toBe("com.winter.core");
  });
});
