// E2 (dist-session fixes, 2026-09-22): the advisor on ANOTHER provider than the session's, on the REAL
// catalog, in exactly the shape a host builds for it.
//
// The Winter daemon has been DROPPING every cross-provider advisor ("`runtimes.advisorModel`: names a
// different provider than the session's own model ... dropping the advisor" on every spawn -- advisor
// `codex-oauth/gpt-5.6-sol`, sessions on deepseek) on the reading that `AdvisorConfig` has no provider
// identity. It has one, the same one `WebFetchConfig.digestModel` has: the PROVIDER-QUALIFIED TAG.
// `resolveSlotToProvider`'s qualified-key door takes the provider from the key's own prefix, the
// reviewer is resolved under THAT provider (never the session's), and it is built on the advisor's
// OWN `authRef` (Ruling E-1 step 1). `cross-provider-credential.test.ts` proves the wire half on a
// fixture catalog; this file pins the route on the real rows the daemon names, so a host can rely on
// it without a second spelling of the same fact on the config.
import { describe, expect, test } from "bun:test";
import type { CredentialRef, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider } from "./session-provider.ts";

const SESSION_REF: CredentialRef = { kind: "keychain", account: "deepseek-anthropic:default", service: "com.example.test-only" };
const ADVISOR_REF: CredentialRef = { kind: "keychain", account: "codex-oauth:default", service: "com.example.test-only" };

/** The daemon's Winter-leg spawn shape: the session's BARE model id plus `Options.provider`, and the advisor as a qualified tag with its own provider's credential locator. */
function hostConfig(advisor: RuntimeConfig["advisor"]): RuntimeConfig {
  return {
    sessionId: "e2",
    cwd: process.cwd(),
    model: "deepseek-v4-flash",
    persistSession: false,
    provider: { providerId: "deepseek-anthropic", authRef: SESSION_REF },
    ...(advisor !== undefined ? { advisor } : {}),
  } as RuntimeConfig;
}

describe("E2: a provider-qualified advisor tag runs on ITS OWN provider and credential, whatever the session's provider", () => {
  test("session on deepseek-anthropic, advisor `codex-oauth/gpt-5.6-sol` + codex-oauth's own authRef -> the reviewer is codex-oauth's row, built on the advisor's ref", () => {
    const wiring = buildSessionProvider({ config: hostConfig({ model: "codex-oauth/gpt-5.6-sol", authRef: ADVISOR_REF }), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    expect(wiring.resolved?.modelKey).toBe("deepseek-anthropic/deepseek-v4-flash");

    const reviewer = wiring.resolveReviewer?.();
    expect(reviewer).toBeDefined();
    // The qualified tag's own provider -- never re-read under the session's provider, never a bare-id match elsewhere.
    expect(reviewer!.model).toBe("codex-oauth/gpt-5.6-sol");

    // Ruling E-1: the ROUTE's own credential, flagged cross-provider. The session's locator is not it.
    const target = wiring.registry.resolve({ model: "codex-oauth/gpt-5.6-sol", provider: { providerId: "codex-oauth" } });
    if (target instanceof WinterProviderResolutionError) throw target;
    const material = wiring.describeTargetMaterial(target, { authRef: ADVISOR_REF });
    expect(material.crossProvider).toBe(true);
    expect(material.source).toBe("route");
    expect(material.authRef).toEqual(ADVISOR_REF);
    expect(material.authRef).not.toEqual(SESSION_REF);
  });

  test("the same qualified tag with NO authRef still names its own provider -- the credential then comes from that provider's own record, never the session's", () => {
    const wiring = buildSessionProvider({ config: hostConfig({ model: "codex-oauth/gpt-5.6-sol" }), env: {}, catalog: loadCatalog(), credentials: createMemoryCredentialStore() });
    expect(wiring.resolveReviewer?.()?.model).toBe("codex-oauth/gpt-5.6-sol");
    const target = wiring.registry.resolve({ model: "codex-oauth/gpt-5.6-sol", provider: { providerId: "codex-oauth" } });
    if (target instanceof WinterProviderResolutionError) throw target;
    const material = wiring.describeTargetMaterial(target);
    expect(material.crossProvider).toBe(true);
    expect(material.source).toBe("provider-record");
    expect(material.authRef).not.toEqual(SESSION_REF);
  });

  test("an old caller's SAME-provider advisor (qualified model + the session's own authRef) is unchanged", () => {
    const wiring = buildSessionProvider({
      config: hostConfig({ model: "deepseek-anthropic/deepseek-v4-pro", authRef: SESSION_REF }),
      env: {},
      catalog: loadCatalog(),
      credentials: createMemoryCredentialStore(),
    });
    expect(wiring.resolveReviewer?.()?.model).toBe("deepseek-anthropic/deepseek-v4-pro");
  });
});
