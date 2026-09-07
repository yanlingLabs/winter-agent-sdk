// Azure OpenAI's corpus harnesses — both surfaces, over the same questions the rest of the family
// answers.
//
// Azure is a CONNECTION-PROFILE VARIANT (ruling R6-A), so this file supplies harnesses rather than a
// second set of cases: `openAiCorpusCases` is asked of `azure-openai@1` verbatim, which is the only
// way "Azure passes the corpus" means the same thing as "OpenAI passes the corpus".
//
// What is genuinely Azure's, and therefore asserted here on EVERY recorded request rather than in
// one case: the mandatory `api-version` query, and the deployment path on the classic surface. The
// fake refuses a request without `api-version` the way Azure does, so an adapter that dropped it on
// (say) only its retried request would fail loudly rather than pass twenty-two cases.

import { FAST_RETRY, descriptor, testContext, testDiscoveryContext, type DescriptorOverrides, AZURE_PREVIEW_API_VERSION } from "@yanlinglabs/winter-provider-runtime/testing";
import { discoverModels, createAzureOpenAIAdapter } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";
import { apiVersionOf, deploymentOf } from "../fakes/azure-openai.ts";
import type { RecordedRequest } from "../fakes/server.ts";
import type { CorpusHarness, HarnessOverrides } from "./openai.ts";

export const AZURE_CLASSIC_API_VERSION = "2026-05-01";
export const AZURE_DEPLOYMENT = "corpus-deployment";
/** A short stall budget, matching the OpenAI run's: the stall case must fail fast. */
const STALL_MS = 200;

function descriptorsFor(base: DescriptorOverrides, overrides?: DescriptorOverrides): (model: string) => ReturnType<typeof descriptor> {
  return (model) => descriptor({ ...base, ...overrides, key: `corpus/${model}`, upstreamId: model, providerId: "azure-openai", continuationDomain: ["corpus-domain"] });
}

/** Every Azure request must carry `api-version`; a classic-surface one must also address a deployment. */
function assertAzureRequest(preview: boolean): (recorded: RecordedRequest) => void {
  return (recorded) => {
    const apiVersion = apiVersionOf(recorded);
    if (apiVersion === undefined) throw new Error(`an Azure request reached the wire with no api-version: ${recorded.path}${recorded.search}`);
    if (preview) {
      if (!recorded.path.startsWith("/openai/v1/")) throw new Error(`the preview surface addressed ${recorded.path} rather than /openai/v1/...`);
      return;
    }
    if (deploymentOf(recorded) !== AZURE_DEPLOYMENT) throw new Error(`the classic surface addressed deployment ${String(deploymentOf(recorded))} rather than ${AZURE_DEPLOYMENT}`);
  };
}

/** The CLASSIC surface: the deployment path, chat completions, `api-key` auth. */
export function azureClassicHarness(): CorpusHarness {
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "summary", continuation: "opaque-provider-state" };
  const adapterFor = (overrides?: HarnessOverrides): ProviderAdapter =>
    createAzureOpenAIAdapter({ retry: FAST_RETRY, descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor) });
  const ctxFor = (url: string): ReturnType<typeof testContext> =>
    testContext({ providerId: "azure-openai", baseUrl: url, local: true, deployment: AZURE_DEPLOYMENT, apiVersion: AZURE_CLASSIC_API_VERSION, stallTimeoutMs: STALL_MS });
  return {
    name: "azure-openai@1 (deployment path)",
    surface: "chat",
    // The classic surface speaks chat completions, which has no encrypted-reasoning-item channel —
    // so this target's continuation answer is a FACT about the surface, recorded as a skip.
    capabilities: { tools: true, vision: true, continuation: "none", effort: true },
    discovery: "live",
    requiresCredential: true,
    // Azure's model listing sits under `/openai`, never at the root.
    discoveryRoutePrefix: "/openai",
    assertRequest: assertAzureRequest(false),
    stream: (endpoint, req, overrides) => adapterFor(overrides).streamTurn(req, ctxFor(endpoint.url)),
    discover: (endpoint, opts) =>
      discoverModels(
        adapterFor(),
        testDiscoveryContext({
          providerId: "azure-openai",
          baseUrl: endpoint.url,
          local: true,
          deployment: AZURE_DEPLOYMENT,
          apiVersion: AZURE_CLASSIC_API_VERSION,
          stallTimeoutMs: STALL_MS,
          ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
        }),
        opts?.cache,
      ),
  };
}

/** The PREVIEW surface: `/openai/v1/responses`, the full Responses wire, encrypted continuation and all. */
export function azurePreviewHarness(): CorpusHarness {
  const base: DescriptorOverrides = { efforts: ["low", "medium", "high"], readableState: "summary", summaryValues: ["detailed"], continuation: "opaque-provider-state" };
  const adapterFor = (overrides?: HarnessOverrides): ProviderAdapter =>
    createAzureOpenAIAdapter({ retry: FAST_RETRY, descriptors: overrides?.unlisted === true ? () => undefined : descriptorsFor(base, overrides?.descriptor) });
  const ctxFor = (url: string): ReturnType<typeof testContext> => testContext({ providerId: "azure-openai", baseUrl: url, local: true, apiVersion: AZURE_PREVIEW_API_VERSION, stallTimeoutMs: STALL_MS });
  return {
    name: "azure-openai@1 (/openai/v1 preview)",
    surface: "responses",
    capabilities: { tools: true, vision: true, continuation: "opaque", effort: true },
    discovery: "live",
    requiresCredential: true,
    discoveryRoutePrefix: "/openai",
    assertRequest: assertAzureRequest(true),
    stream: (endpoint, req, overrides) => adapterFor(overrides).streamTurn(req, ctxFor(endpoint.url)),
    discover: (endpoint, opts) =>
      discoverModels(
        adapterFor(),
        testDiscoveryContext({ providerId: "azure-openai", baseUrl: endpoint.url, local: true, apiVersion: AZURE_PREVIEW_API_VERSION, stallTimeoutMs: STALL_MS, ...(opts?.maxItems !== undefined ? { maxItems: opts.maxItems } : {}) }),
        opts?.cache,
      ),
  };
}
