// Azure's addressing rules, as pure functions. The live half is in the conformance package.

import { describe, expect, test } from "bun:test";
import { AZURE_PREVIEW_API_VERSION, azureProfile, azureRouting, azureTurnUrl, createAzureOpenAIAdapter } from "./azure.ts";
import { createLocalOpenAIAdapter } from "./local.ts";
import { testContext } from "./testing.ts";

const BASE = "https://my-resource.openai.azure.test";

describe("azure routing: refused rather than defaulted", () => {
  test("a missing `api-version` is a typed refusal — Winter will not guess which surface you meant", () => {
    expect(() => azureRouting(testContext({ baseUrl: BASE, deployment: "gpt41" }), {})).toThrow(/apiVersion/);
  });

  test("a missing `deployment` is a refusal on the CLASSIC surface, where the deployment IS the address", () => {
    expect(() => azureRouting(testContext({ baseUrl: BASE, apiVersion: "2026-05-01" }), {})).toThrow(/deployment/);
  });

  test("the preview surface needs no deployment at all", () => {
    const routing = azureRouting(testContext({ baseUrl: BASE, apiVersion: AZURE_PREVIEW_API_VERSION }), {});
    expect(routing).toEqual({ apiVersion: "preview", preview: true });
  });

  test("a construction-time default fills in only what the profile left out", () => {
    const routing = azureRouting(testContext({ baseUrl: BASE, deployment: "gpt41" }), { defaultApiVersion: "2026-05-01" });
    expect(routing).toEqual({ apiVersion: "2026-05-01", preview: false, deployment: "gpt41" });
  });
});

describe("azure URLs", () => {
  test("the classic surface is the deployment path with a mandatory api-version query", () => {
    expect(azureTurnUrl(BASE, { apiVersion: "2026-05-01", preview: false, deployment: "gpt41" })).toBe(`${BASE}/openai/deployments/gpt41/chat/completions?api-version=2026-05-01`);
  });

  test("the preview surface is `/openai/v1/responses`, still carrying api-version", () => {
    expect(azureTurnUrl(BASE, { apiVersion: "preview", preview: true })).toBe(`${BASE}/openai/v1/responses?api-version=preview`);
  });

  test("the deployment name is PERCENT-ENCODED — it is untrusted profile input going into a path", () => {
    const url = azureTurnUrl(BASE, { apiVersion: "2026-05-01", preview: false, deployment: "../../evil path" });
    expect(url).toContain("/openai/deployments/..%2F..%2Fevil%20path/chat/completions");
    // The traversal never becomes a path segment, so the request cannot address another route.
    expect(new URL(url).pathname).toBe("/openai/deployments/..%2F..%2Fevil%20path/chat/completions");
  });
});

describe("adapter identities", () => {
  test("azure declares its own protocol and version", () => {
    const adapter = createAzureOpenAIAdapter();
    expect({ id: adapter.id, version: adapter.version, family: adapter.family, protocol: adapter.protocol }).toEqual({
      id: "winter.azure-openai",
      version: "1",
      family: "openai",
      protocol: "azure-openai",
    });
  });

  test("the local adapter's id is overridable, because a registry resolves an adapter BY the catalog's adapterId", () => {
    expect(createLocalOpenAIAdapter().id).toBe("winter.local-openai");
    expect(createLocalOpenAIAdapter({ id: "winter.openai-chat-completions" }).id).toBe("winter.openai-chat-completions");
    expect(createLocalOpenAIAdapter().family).toBe("local-openai");
    expect(createLocalOpenAIAdapter({ surface: "responses" }).protocol).toBe("openai-responses");
  });

  test("a profile carries the three facts a host has to name in one place", () => {
    expect(azureProfile({ baseUrl: BASE, deployment: "gpt41", apiVersion: "2026-05-01" })).toEqual({
      providerId: "azure-openai",
      baseUrl: BASE,
      apiVersion: "2026-05-01",
      deployment: "gpt41",
    });
  });
});
