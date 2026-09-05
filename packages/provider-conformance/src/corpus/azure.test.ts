// Azure OpenAI's corpus run — both surfaces, asked the family's own questions verbatim.

import { describe, expect, test } from "bun:test";
import { createAzureOpenAIAdapter } from "../../../provider-runtime/src/adapters/openai/azure.ts";
import { FAST_RETRY, testContext } from "../../../provider-runtime/src/adapters/openai/testing.ts";
import { createMemoryCredentialStore } from "../../../provider-runtime/src/credentials/memory.ts";
import type { CredentialRef, ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { SCENARIO, openAiCorpusCases, type CorpusHarness } from "./openai.ts";
import { chatCorpusScenarios, responsesCorpusScenarios } from "./openai-scenarios.ts";
import { AZURE_CLASSIC_API_VERSION, AZURE_DEPLOYMENT, azureClassicHarness, azurePreviewHarness } from "./azure.ts";
import { FAKE_ENTRA_TOKEN, apiVersionOf, startAzureFake } from "../fakes/azure-openai.ts";
import { openAiModelsRoutes } from "../fakes/openai-models.ts";
import type { FakeServer } from "../fakes/server.ts";

async function withAzureFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startAzureFake({
    chatScenarios: chatCorpusScenarios(),
    responsesScenarios: responsesCorpusScenarios(),
    routes: openAiModelsRoutes({ pages: [{ rows: [{ id: "alpha" }, { id: "beta" }] }], pathPrefix: "/openai" }),
  });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const RUNS: CorpusHarness[] = [azureClassicHarness(), azurePreviewHarness()];

describe("WS-13 §13 corpus — Azure OpenAI (R6-A: a profile variant, asked the family's own questions)", () => {
  for (const harness of RUNS) {
    test(`${harness.name} answers every required case`, async () => {
      const report = await withAzureFake((fake) => runAdapterCorpus({ adapter: harness.name, fake, model: SCENARIO.happy, cases: openAiCorpusCases(harness) }));
      if (!report.ok) throw new Error(`\n${formatCorpusReport(report)}`);
      expect(report.outcomes.filter((o) => o.status === "missing")).toEqual([]);
      expect(report.outcomes).toHaveLength(23);
    }, 30_000);
  }

  test("the classic surface skips opaque continuation as a FACT about the surface", async () => {
    const report = await withAzureFake((fake) => runAdapterCorpus({ adapter: "azure-classic", fake, model: SCENARIO.happy, cases: openAiCorpusCases(azureClassicHarness()) }));
    // Chat completions has no encrypted-reasoning-item channel; that is the surface's answer, and it
    // is recorded rather than omitted.
    expect(report.outcomes.find((o) => o.id === "opaque-continuation")?.status).toBe("skipped");
    expect(report.outcomes.find((o) => o.id === "effort-mapping")?.status).toBe("passed");
  }, 30_000);
});

describe("azure specifics on the live wire", () => {
  test("every request carries `api-version`, and the classic surface addresses the deployment", async () => {
    await withAzureFake(async (fake) => {
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      await drain(
        adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: AZURE_DEPLOYMENT, apiVersion: AZURE_CLASSIC_API_VERSION })),
      );
      const recorded = fake.requests.at(-1)!;
      expect(recorded.path).toBe(`/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions`);
      expect(apiVersionOf(recorded)).toBe(AZURE_CLASSIC_API_VERSION);
      expect(recorded.headers["api-key"]).toBeDefined();
      // The resource key rides Azure's OWN header, never `Authorization`.
      expect(recorded.headers.authorization).toBeUndefined();
    });
  });

  test("`apiVersion: \"preview\"` selects the /openai/v1 Responses surface", async () => {
    await withAzureFake(async (fake) => {
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, apiVersion: "preview" })));
      const recorded = fake.requests.at(-1)!;
      expect(recorded.path).toBe("/openai/v1/responses");
      expect(apiVersionOf(recorded)).toBe("preview");
      // The Responses body shape, not the chat one — proof the delegate is this lane's own adapter.
      expect(JSON.parse(recorded.body)).toHaveProperty("input");
      expect(JSON.parse(recorded.body)).toHaveProperty("store", false);
    });
  });

  test("an Entra bearer rides `Authorization`, and the resource key never appears alongside it", async () => {
    await withAzureFake(async (fake) => {
      const ref: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "azure-openai:entra" };
      const credentials = createMemoryCredentialStore([[ref, { kind: "bearer", token: FAKE_ENTRA_TOKEN }]]);
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      const ctx = { ...testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: AZURE_DEPLOYMENT, apiVersion: AZURE_CLASSIC_API_VERSION }), credentials, authRef: ref };
      await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, ctx));
      const recorded = fake.requests.at(-1)!;
      expect(recorded.headers.authorization).toBe("Bearer ***");
      expect(recorded.headers["api-key"]).toBeUndefined();
    });
  });

  test("a missing api-version or deployment is refused with NOTHING on the wire", async () => {
    await withAzureFake(async (fake) => {
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      const before = fake.requests.length;
      const noVersion = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: AZURE_DEPLOYMENT })));
      const noDeployment = await drain(adapter.streamTurn({ model: SCENARIO.happy, messages: [] }, testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, apiVersion: AZURE_CLASSIC_API_VERSION })));
      for (const events of [noVersion, noDeployment]) {
        const error = events.find((e) => e.type === "error");
        expect(error?.type === "error" ? error.error.code : "").toBe("capability");
      }
      expect(fake.requests).toHaveLength(before);
    });
  });

  test("validateCredential SUCCEEDS for a valid key — its probe carries `api-version` too", async () => {
    // It could not, before: `validateViaModels` built `/openai/models` with no query, Azure (and
    // this fake) answered 400, and the 400 normalized to `network` — so a perfectly valid key
    // reported as unreachable. No target's `validateCredential` was exercised anywhere, which is
    // exactly why nothing caught it.
    await withAzureFake(async (fake) => {
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      const ctx = testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: AZURE_DEPLOYMENT, apiVersion: AZURE_CLASSIC_API_VERSION });
      const status = await adapter.validateCredential(ctx.authRef, ctx);
      expect(status).toEqual({ ok: true });
      const probe = fake.requests.at(-1)!;
      expect(probe.path).toBe("/openai/models");
      expect(apiVersionOf(probe)).toBe(AZURE_CLASSIC_API_VERSION);
    });
  });

  test("validateCredential reports a REJECTED key as invalid rather than unreachable", async () => {
    const { startFake, jsonResponse } = await import("../fakes/server.ts");
    const fake = await startFake({ routes: [{ path: "/openai/models", method: "GET", handler: () => jsonResponse({ error: { code: "401", message: "Access denied due to invalid subscription key." } }, 401) }] });
    try {
      const adapter = createAzureOpenAIAdapter({ retry: FAST_RETRY });
      const ctx = testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: AZURE_DEPLOYMENT, apiVersion: AZURE_CLASSIC_API_VERSION });
      const status = await adapter.validateCredential(ctx.authRef, ctx);
      expect(status.ok).toBe(false);
      expect(status.ok === false ? status.code : "").toBe("invalid");
    } finally {
      await fake.close();
    }
  });

  test("the fake itself refuses a request with no api-version — so a dropped parameter cannot pass quietly", async () => {
    // A guard on the GUARD: if this ever returns 200, every `api-version` assertion above becomes
    // vacuous, because nothing would fail when the parameter went missing.
    await withAzureFake(async (fake) => {
      const response = await fetch(`${fake.url}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions`, { method: "POST", body: JSON.stringify({ model: SCENARIO.happy }) });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("MissingApiVersionParameter");
    });
  });
});

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}
