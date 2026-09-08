// P7a spine, Step 1 (D19, WS-01 §2): the brand profile's own tests.
//
// WRITTEN BEFORE brand.ts existed. The point of this file is not "the defaults are spelled right"
// (though it asserts that byte for byte, against WS-01 §2's tables) -- it is that a REUSER's
// profile resolves, and that every validation rule the pinned interface names has a refusing case.
// A brand module whose validator accepts anything is the same as no validator: the one thing a
// host must never be able to do is present Winter as somebody else (`codexOriginator` in
// FIRST_PARTY_ORIGINATORS), and the one thing a host must never be able to do BY ACCIDENT is hand
// in a token that silently produces a broken path or env name (a home dir with no dot, an env
// prefix with no trailing underscore).
import { describe, test, expect } from "bun:test";
import {
  BRAND_TOKEN_RE,
  FIRST_PARTY_ORIGINATORS,
  WINTER_BRAND,
  envName,
  mcpToolName,
  resolveBrand,
  userAgent,
  type BrandProfile,
} from "./brand.ts";

describe("WINTER_BRAND: WS-01 §2's values, byte for byte", () => {
  test("resolveBrand() with nothing returns exactly WINTER_BRAND", () => {
    const resolved = resolveBrand();
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.brand).toEqual(WINTER_BRAND);
  });

  test("every field carries WS-01 §2's own literal", () => {
    // Spelled out rather than looped: this is the table the whole sweep gate exists to protect, and
    // a loop over Object.entries(WINTER_BRAND) would assert nothing at all.
    expect(WINTER_BRAND).toEqual({
      productName: "Winter",
      packageName: "winter-agent-sdk",
      homeDirName: ".winter",
      projectDirName: ".winter",
      instructionsFile: "WINTER.md",
      envPrefix: "WINTER_",
      keychainService: "com.winter.core",
      mcpServerName: "winter",
      presetName: "winter_code",
      processLabel: "winter",
      codexOriginator: "winter",
      tempRootName: "winter",
      pluginManifestDir: ".winter-plugin",
      contactUrl: "https://github.com/yanlingLabs/winter-agent-sdk",
    });
  });

  test("resolveBrand() hands back a FRESH object -- a caller cannot mutate the shared constant", () => {
    const first = resolveBrand();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.brand).not.toBe(WINTER_BRAND as BrandProfile);
    first.brand.productName = "Mutated";
    expect(WINTER_BRAND.productName).toBe("Winter");
    expect((resolveBrand() as { ok: true; brand: BrandProfile }).brand.productName).toBe("Winter");
  });
});

describe("resolveBrand: a reuser's partial profile", () => {
  const ACME: Partial<BrandProfile> = { productName: "Acme", homeDirName: ".acme", envPrefix: "ACME_", codexOriginator: "acme" };

  test("the four supplied fields win and every other field defaults to Winter's", () => {
    const resolved = resolveBrand(ACME);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.brand.productName).toBe("Acme");
    expect(resolved.brand.homeDirName).toBe(".acme");
    expect(resolved.brand.envPrefix).toBe("ACME_");
    expect(resolved.brand.codexOriginator).toBe("acme");
    // NOT defaulted away: the fields Acme did not name keep Winter's values, which is what makes a
    // partial profile usable at all (a host that only wants its own home dir should not have to
    // re-spell twelve other names to get one).
    expect(resolved.brand.packageName).toBe(WINTER_BRAND.packageName);
    expect(resolved.brand.projectDirName).toBe(WINTER_BRAND.projectDirName);
    expect(resolved.brand.instructionsFile).toBe(WINTER_BRAND.instructionsFile);
    expect(resolved.brand.mcpServerName).toBe(WINTER_BRAND.mcpServerName);
  });

  test("an explicitly-undefined field is the same as an absent one", () => {
    // Cast, deliberately: `exactOptionalPropertyTypes` is on repo-wide, so `Partial<BrandProfile>`
    // does NOT admit an explicit `undefined` from TypeScript. This input is reachable anyway -- a
    // JS host, or an options object built by spreading -- and resolveBrand treats it as "absent"
    // rather than as "the field is the string 'undefined'" or a type refusal.
    const resolved = resolveBrand({ productName: undefined, homeDirName: ".acme" } as unknown as Partial<BrandProfile>);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.brand.productName).toBe("Winter");
  });

  test("the derived helpers follow the resolved profile, not Winter's", () => {
    const acme = (resolveBrand({ ...ACME, mcpServerName: "acme", packageName: "acme-agent-sdk" }) as { ok: true; brand: BrandProfile }).brand;
    expect(envName(acme, "HOME")).toBe("ACME_HOME");
    expect(mcpToolName(acme, "send_message")).toBe("mcp__acme__send_message");
    expect(userAgent(acme, "1.2.3")).toBe("acme-agent-sdk/1.2.3");
  });
});

describe("resolveBrand: every validation rule refuses something", () => {
  // One refusing case per rule in the pinned interface block, plus the reason string each produces.
  // `reason` is asserted by SUBSTRING (the field name) rather than verbatim: the field a host got
  // wrong is the load-bearing half of the message, and pinning the whole sentence would make every
  // wording improvement a test edit.
  const cases: Array<[string, Partial<BrandProfile>, string]> = [
    ["envPrefix with no trailing underscore", { envPrefix: "ACME" }, "envPrefix"],
    ["envPrefix in lowercase", { envPrefix: "acme_" }, "envPrefix"],
    ["homeDirName with no leading dot", { homeDirName: "acme" }, "homeDirName"],
    ["projectDirName with no leading dot", { projectDirName: "acme" }, "projectDirName"],
    ["pluginManifestDir with no leading dot", { pluginManifestDir: "acme-plugin" }, "pluginManifestDir"],
    ["instructionsFile in lowercase", { instructionsFile: "acme.md" }, "instructionsFile"],
    ["instructionsFile with the wrong extension", { instructionsFile: "ACME.txt" }, "instructionsFile"],
    ["packageName with an underscore", { packageName: "acme_sdk" }, "packageName"],
    ["mcpServerName starting with a digit", { mcpServerName: "1acme" }, "mcpServerName"],
    ["processLabel in mixed case", { processLabel: "Acme" }, "processLabel"],
    ["tempRootName with a slash", { tempRootName: "acme/tmp" }, "tempRootName"],
    ["keychainService in mixed case", { keychainService: "com.Acme.core" }, "keychainService"],
    ["an empty productName", { productName: "" }, "productName"],
    ["a productName over 64 characters", { productName: "a".repeat(65) }, "productName"],
    // P7a fix wave (item 7). `contactUrl` is PARSED rather than pattern-matched, so the refusing
    // cases are about what a URL parser and a scheme check reject -- and the http/mailto pair is
    // the point: both parse cleanly, and neither may be published to a vendor as a contact.
    ["a contactUrl that is not a URL at all", { contactUrl: "github.com/acme" }, "contactUrl"],
    ["a plaintext http contactUrl", { contactUrl: "http://acme.example/support" }, "contactUrl"],
    ["a mailto contactUrl", { contactUrl: "mailto:support@acme.example" }, "contactUrl"],
    ["a javascript: contactUrl", { contactUrl: "javascript:alert(1)" }, "contactUrl"],
    ["an empty contactUrl", { contactUrl: "" }, "contactUrl"],
  ];
  for (const [label, partial, field] of cases) {
    test(`refuses ${label}`, () => {
      const resolved = resolveBrand(partial);
      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.reason).toContain(field);
    });
  }

  test("refuses a first-party codexOriginator -- every one of them", () => {
    // The rule CLAUDE.md and WS-01 §3 both carry: the originator is deliberately non-first-party.
    // Looping the exported list (rather than spot-checking "codex") is what makes adding a name to
    // FIRST_PARTY_ORIGINATORS automatically add a test for it.
    expect(FIRST_PARTY_ORIGINATORS.length).toBeGreaterThan(0);
    for (const originator of FIRST_PARTY_ORIGINATORS) {
      const resolved = resolveBrand({ codexOriginator: originator });
      expect([originator, resolved.ok]).toEqual([originator, false]);
      expect(resolved.ok === false && resolved.reason).toContain("codexOriginator");
    }
  });

  test("a first-party originator is refused for BEING first-party, not for its grammar", () => {
    // "anthropic" is a perfectly well-formed brand token: it matches BRAND_TOKEN_RE. If this ever
    // started failing the grammar check instead, the impersonation rule would be doing no work.
    expect(BRAND_TOKEN_RE.test("anthropic")).toBe(true);
    const resolved = resolveBrand({ codexOriginator: "anthropic" });
    expect(resolved.ok === false && resolved.reason).toContain("first-party");
  });

  test("presetName is NOT held to BRAND_TOKEN_RE -- Winter's own value has an underscore", () => {
    // A uniform token rule over every field would refuse WINTER_BRAND itself. This is the test that
    // catches a future "tidy the validator" refactor doing exactly that.
    expect(BRAND_TOKEN_RE.test(WINTER_BRAND.presetName)).toBe(false);
    expect(resolveBrand({ presetName: "acme_code" }).ok).toBe(true);
  });

  test("the FIRST refusal names one field -- a profile wrong in two places still refuses", () => {
    const resolved = resolveBrand({ envPrefix: "acme", homeDirName: "acme" });
    expect(resolved.ok).toBe(false);
  });

  test("P7a fix wave (item 7): a real https contactUrl is ACCEPTED, path/port/query and all", () => {
    // The positive leg for the parse. Without it every refusal above would pass just as happily
    // against a validator that rejected every contact URL, which is a different bug.
    for (const url of ["https://acme.example", "https://acme.example/support", "https://acme.example:8443/support?team=agents", "https://github.com/acme/acme-agent-sdk"]) {
      const resolved = resolveBrand({ contactUrl: url });
      expect([url, resolved.ok]).toEqual([url, true]);
      expect(resolved.ok && resolved.brand.contactUrl).toBe(url);
    }
  });

  test("P7a fix wave (item 7): a contactUrl carrying a raw control byte is refused -- it is written into a header", () => {
    // Header injection, and the reason the check is not just `protocol === "https:"`: `new URL`
    // accepts several C0 bytes (stripping or percent-encoding them), and this value is written
    // verbatim into a request header by `renderIdentityHeaders`.
    for (const byte of [0x00, 0x0a, 0x0d, 0x1b]) {
      const url = `https://acme.example/${String.fromCharCode(byte)}x`;
      const resolved = resolveBrand({ contactUrl: url });
      expect([byte, resolved.ok]).toEqual([byte, false]);
    }
  });
});

describe("the derived-name helpers", () => {
  test("envName(WINTER_BRAND, 'HOME')", () => {
    expect(envName(WINTER_BRAND, "HOME")).toBe("WINTER_HOME");
    expect(envName(WINTER_BRAND, "TMPDIR")).toBe("WINTER_TMPDIR");
    expect(envName(WINTER_BRAND, "PROJECT_DIR_NAME")).toBe("WINTER_PROJECT_DIR_NAME");
  });

  test("mcpToolName(WINTER_BRAND, 'send_message')", () => {
    expect(mcpToolName(WINTER_BRAND, "send_message")).toBe("mcp__winter__send_message");
  });

  test("userAgent(WINTER_BRAND, '0.0.1')", () => {
    expect(userAgent(WINTER_BRAND, "0.0.1")).toBe("winter-agent-sdk/0.0.1");
  });

  test("the helpers take a PICK, not a whole profile -- a caller with one field can call them", () => {
    expect(envName({ envPrefix: "ACME_" }, "HOME")).toBe("ACME_HOME");
    expect(mcpToolName({ mcpServerName: "acme" }, "advisor")).toBe("mcp__acme__advisor");
    expect(userAgent({ packageName: "acme-agent-sdk" }, "9.9.9")).toBe("acme-agent-sdk/9.9.9");
  });
});
