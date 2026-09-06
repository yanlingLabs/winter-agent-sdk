import { describe, expect, test } from "bun:test";
import { extractAll, extractModuleLiterals, resolveRelativeSpecifier, type ExclusionClass } from "./literal-extractor.ts";

/**
 * Every source string in this file is WINTER-AUTHORED. Nothing here is copied from any upstream
 * project: the shapes are modelled on the ones the real extraction meets (a registry entry with a
 * URL builder, a header map, an OAuth block, a spread of a shared capability constant) but the
 * names, values and prose are ours. That is deliberate — a test fixture made of vendored source
 * would put upstream code in the repository through the back door.
 */

function classesOf(rejections: ReadonlyArray<{ exclusionClass: ExclusionClass }>): ExclusionClass[] {
  return [...new Set(rejections.map((r) => r.exclusionClass))].sort();
}

describe("accepted literal forms", () => {
  test("strings, numbers (incl. separators), booleans, null, substitution-free templates, nesting", () => {
    const module = extractModuleLiterals("x.ts", [
      "export const ENTRY = {",
      '  id: "acme",',
      "  contextLength: 1_000_000,",
      "  temperatureFloor: -1,",
      "  enabled: true,",
      "  retired: null,",
      "  note: `no substitutions here`,",
      '  models: [{ id: "a" }, { id: "b", nested: { deep: [1, 2, 3] } }],',
      "} as const;",
    ].join("\n"));

    expect(module.rejections).toEqual([]);
    expect(module.values.get("ENTRY")).toEqual({
      id: "acme",
      contextLength: 1000000,
      temperatureFloor: -1,
      enabled: true,
      retired: null,
      note: "no substitutions here",
      models: [{ id: "a" }, { id: "b", nested: { deep: [1, 2, 3] } }],
    });
  });

  test("`satisfies`, parenthesised and quoted/numeric keys all unwrap to the same value", () => {
    const module = extractModuleLiterals("x.ts", 'export const A = ({ "quoted-key": 1, 2: "two" }) satisfies Record<string, unknown>;');
    expect(module.values.get("A")).toEqual({ "quoted-key": 1, "2": "two" });
  });

  test("a spread of another accepted literal is inlined, in both objects and arrays", () => {
    const module = extractModuleLiterals("x.ts", [
      "const CAPS = { vision: true, contextLength: 42 };",
      'const BASE = ["p", "q"];',
      'export const M = { id: "m", ...CAPS, params: [...BASE, "r"] };',
    ].join("\n"));
    expect(module.rejections).toEqual([]);
    expect(module.values.get("M")).toEqual({ id: "m", vision: true, contextLength: 42, params: ["p", "q", "r"] });
  });
});

describe("rejected forms — the whole point of the module", () => {
  const source = [
    'import { SHARED_HEADERS, FROZEN_PARAMS } from "../shared.ts";',
    'import { helper } from "@/lib/elsewhere";',
    "export const ENTRY = {",
    '  id: "acme",',
    "  urlBuilder: (base, model) => `${base}/${model}`,",
    "  headers: { \"X-Client-Version\": \"1.2.3\" },",
    "  extraHeaders: SHARED_HEADERS,",
    '  oauth: { clientIdDefault: "public-id", clientSecretEnv: "ACME_SECRET" },',
    '  anonymousApiKey: "anonymous",',
    "  poolConfig: { size: 4 },",
    "  requestDefaults: { temperature: 0 },",
    "  frozen: FROZEN_PARAMS,",
    "  computed: Object.freeze([1, 2]),",
    "  built: new URL(\"https://example.test\"),",
    "  fromEnv: process.env.ACME_BASE_URL,",
    "  interpolated: `https://${region}.example.test`,",
    "  viaProperty: helper.value,",
    "  method() { return 1; },",
    "  get accessor() { return 2; },",
    "};",
  ].join("\n");

  const module = extractModuleLiterals("open-sse/config/providers/registry/acme/index.ts", source, {
    materializedPaths: new Set(["open-sse/config/providers/registry/acme/index.ts"]),
  });
  const entry = module.values.get("ENTRY") as Record<string, unknown>;
  const byPath = new Map(module.rejections.map((r) => [r.path, r]));

  test("only the inert fields survive", () => {
    expect(entry).toEqual({ id: "acme" });
  });

  test("a URL builder is rejected as `url-builder` — WS-13 §13 names this exact hazard", () => {
    expect(byPath.get("ENTRY.urlBuilder")?.exclusionClass).toBe("url-builder");
  });

  test("header maps are rejected as `identity-header` whatever their shape", () => {
    expect(byPath.get("ENTRY.headers")?.exclusionClass).toBe("identity-header");
    // Rejected by NAME, so it never even reaches the unresolved-identifier path — the point of the
    // name check is that a credential/identity field is never READ, not merely never written out.
    expect(byPath.get("ENTRY.extraHeaders")?.exclusionClass).toBe("identity-header");
  });

  test("OAuth blocks and literal anonymous keys are `credential-material`", () => {
    expect(byPath.get("ENTRY.oauth")?.exclusionClass).toBe("credential-material");
    expect(byPath.get("ENTRY.anonymousApiKey")?.exclusionClass).toBe("credential-material");
  });

  test("functions, methods, accessors, calls and `new` are all `executable-value`", () => {
    for (const path of ["ENTRY.method", "ENTRY.accessor", "ENTRY.computed", "ENTRY.built"]) {
      expect(byPath.get(path)?.exclusionClass).toBe("executable-value");
    }
    // `Object.freeze([...])` is rejected DELIBERATELY: "accept a call whose callee looks inert" is a
    // rule that decays the first time upstream renames a helper.
    expect(byPath.get("ENTRY.computed")?.reason).toContain("Object.freeze");
  });

  test("an environment read is `env-read`, distinct from a plain property access", () => {
    expect(byPath.get("ENTRY.fromEnv")?.exclusionClass).toBe("env-read");
    expect(byPath.get("ENTRY.viaProperty")?.exclusionClass).toBe("dynamic-expression");
  });

  test("a template WITH substitutions is `dynamic-expression`", () => {
    expect(byPath.get("ENTRY.interpolated")?.exclusionClass).toBe("dynamic-expression");
  });

  test("an identifier from an unmaterialized module is `unresolved-reference`, and names the specifier", () => {
    const rejection = byPath.get("ENTRY.frozen");
    expect(rejection?.exclusionClass).toBe("unresolved-reference");
    expect(rejection?.reason).toContain("../shared.ts");
    expect(rejection?.reason).toContain("outside the materialized allowlist");
  });

  test("out-of-allowlist imports are recorded so boundary drift stays visible", () => {
    expect(module.outOfAllowlistImports.sort()).toEqual(["../shared.ts", "@/lib/elsewhere"]);
  });

  test("the classes are exactly the closed set this fixture exercises", () => {
    expect(classesOf(module.rejections)).toEqual(["credential-material", "dynamic-expression", "env-read", "executable-value", "identity-header", "unresolved-reference", "unsupported-shape", "url-builder"]);
  });
});

describe("total on hostile input", () => {
  test("a syntactically broken module never throws, and invents no data", () => {
    // The TypeScript parser is error-TOLERANT by design: it RECOVERS from `{{{ ;` rather than
    // failing, so the contract worth pinning is not "no value" but "no exception, and nothing the
    // source did not actually contain". A parser that silently repairs a file into plausible-looking
    // data is the failure mode that would matter, and this asserts it does not happen.
    const module = extractModuleLiterals("broken.ts", "export const A = {{{ ;");
    expect(module.values.get("A")).toEqual({});
    for (const value of module.values.values()) expect(value).toEqual({});
  });

  test("nesting past the depth bound is refused rather than overflowing the stack", () => {
    const deep = `export const A = ${"[".repeat(80)}1${"]".repeat(80)};`;
    const module = extractModuleLiterals("deep.ts", deep);
    expect(module.rejections.some((r) => r.reason.includes("nested deeper than"))).toBe(true);
  });

  test("`undefined` is refused — a fact Winter does not have is recorded by OMITTING the key", () => {
    const module = extractModuleLiterals("x.ts", "export const A = { a: 1, b: undefined };");
    expect(module.values.get("A")).toEqual({ a: 1 });
  });
});

describe("cross-module resolution stays inside the allowlist", () => {
  test("two passes resolve a leaf module's reference to a shared constant declared LATER in file order", () => {
    // The single-pass failure this guards: `registry/acme` sorts before `shared.ts`, so a one-pass
    // extractor drops the spread purely because of filename ordering.
    const { modules } = extractAll([
      { path: "open-sse/config/providers/registry/acme/index.ts", text: 'import { CAPS } from "../../shared.ts";\nexport const acmeProvider = { id: "acme", models: [{ id: "m", ...CAPS }] };' },
      { path: "open-sse/config/providers/shared.ts", text: "export const CAPS = { toolCalling: true, contextLength: 128000 };" },
    ]);
    const acme = modules.get("open-sse/config/providers/registry/acme/index.ts")!;
    expect(acme.rejections).toEqual([]);
    expect(acme.values.get("acmeProvider")).toEqual({ id: "acme", models: [{ id: "m", toolCalling: true, contextLength: 128000 }] });
  });

  test("a THREE-DEEP chain running backwards against filename order still resolves (fixpoint, not two passes)", () => {
    // The exact shape of the real tree at the pin, and the bug a fixed two-pass version shipped:
    // `index.ts` sorts FIRST, `shared.ts` LAST, and the chain runs index -> registry -> shared. With
    // two passes the leaf resolved but `index.ts` was handed the stale first-pass copy, so every
    // model that spread a shared capability constant silently lost its context window, modalities
    // and endpoint — while the row still looked complete. Files are passed in SORTED order here
    // deliberately: that ordering is what the real fetch produces and what made the bug real.
    const { modules, passes } = extractAll([
      { path: "open-sse/config/providers/index.ts", text: 'import { acmeProvider } from "./registry/acme/index.ts";\nexport const REGISTRY = { acme: acmeProvider };' },
      { path: "open-sse/config/providers/registry/acme/index.ts", text: 'import { CAPS } from "../../shared.ts";\nexport const acmeProvider = { id: "acme", models: [{ id: "m", ...CAPS }] };' },
      { path: "open-sse/config/providers/shared.ts", text: "export const CAPS = { contextLength: 1050000, supportsVision: true };" },
    ]);
    const registry = modules.get("open-sse/config/providers/index.ts")!.values.get("REGISTRY") as { acme: { models: Array<Record<string, unknown>> } };
    expect(registry.acme.models[0]).toEqual({ id: "m", contextLength: 1050000, supportsVision: true });
    expect(passes).toBeGreaterThan(2);
  });

  test("a reference into a materialized module whose OWN binding was rejected says so precisely", () => {
    const { modules } = extractAll([
      { path: "open-sse/config/providers/registry/acme/index.ts", text: 'import { FROZEN } from "../../shared.ts";\nexport const acmeProvider = { id: "acme", unsupportedParams: FROZEN };' },
      { path: "open-sse/config/providers/shared.ts", text: 'export const FROZEN = Object.freeze(["temperature"]);' },
    ]);
    const rejection = modules.get("open-sse/config/providers/registry/acme/index.ts")!.rejections.find((r) => r.path.endsWith("unsupportedParams"));
    expect(rejection?.exclusionClass).toBe("unresolved-reference");
    expect(rejection?.reason).toContain("which IS materialized");
  });

  test("extensionless specifiers resolve rather than reading as boundary violations", () => {
    expect(resolveRelativeSpecifier("a/b/index.ts", "./gateways", (p) => p === "a/b/gateways.ts")).toBe("a/b/gateways.ts");
    expect(resolveRelativeSpecifier("a/b/index.ts", "./nested", (p) => p === "a/b/nested/index.ts")).toBe("a/b/nested/index.ts");
    expect(resolveRelativeSpecifier("a/b/index.ts", "../shared.ts", () => true)).toBe("a/shared.ts");
    expect(resolveRelativeSpecifier("a/b/index.ts", "@/lib/x")).toBeUndefined();
  });
});
