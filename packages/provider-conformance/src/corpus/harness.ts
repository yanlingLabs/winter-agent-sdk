// The HARNESS SHAPE a corpus target supplies -- extracted from `corpus/openai.ts` by the P7a fix
// wave (item 1) and re-exported from there, so every existing importer is unchanged.
//
// WHY IT IS ITS OWN MODULE. `corpus/azure.ts` needs only these types, and it IS re-exported from this
// package's published barrel (`azureCorpus`). `corpus/openai.ts` imports `foldProviderStream` from
// `../../../runtime/src/provider/bridge.ts` -- a relative path into `winter-agent-runtime`, which is
// `"private": true` and never published -- so a type-only import of these three from THERE dragged
// the entire private runtime into this package's declaration build, and tsc refused it outright
// (TS6059, every runtime file "not under rootDir"). A type is not a reason to depend on a package,
// and the barrel's own self-containment is what makes the published `.d.ts` possible at all.
//
// Nothing here reaches outside `@yanlinglabs/winter-provider-runtime` and this package's own fakes,
// which is the property that has to stay true.
import type { DiscoveryCache, ModelCatalogResult, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import type { DescriptorOverrides } from "@yanlinglabs/winter-provider-runtime/testing";
import type { RecordedRequest } from "../fakes/server.ts";

export interface HarnessOverrides {
  /**
   * Resolve every model to NO descriptor — the `allowUnlisted` gateway shape, where a model has no
   * catalog evidence at all.
   *
   * Spelled as a positive statement rather than as an absent option (ruling on finding I3): the
   * adapters now REQUIRE a lookup, so "this model has no evidence" is something a caller says out
   * loud, and forgetting to say anything is a compile error instead of a silent loss of every
   * §8.2 refusal.
   */
  unlisted?: boolean;
  /** Vary the descriptor this turn resolves. */
  descriptor?: DescriptorOverrides;
}

export interface HarnessCapabilities {
  tools: boolean;
  vision: boolean;
  /** `opaque` = Responses' encrypted reasoning items; `exposed` = DeepSeek's replayable text; `none` = neither. */
  continuation: "opaque" | "exposed" | "none";
  effort: boolean;
}

export interface CorpusHarness {
  name: string;
  surface: "responses" | "chat";
  capabilities: HarnessCapabilities;
  /**
   * `live` = the provider serves a catalog endpoint this corpus can page through; `static` = the
   * adapter's catalog is compiled in (codex serves only its own slugs for a ChatGPT account), so the
   * paging questions do not exist for it and the case asks the ones that do.
   */
  discovery: "live" | "static";
  /**
   * False for a declared-LOCAL endpoint, where having no credential is a valid configuration
   * (`local-none` is a first-class auth kind, WS-13 §6) rather than a missing one.
   */
  requiresCredential: boolean;
  /** Where this surface's model listing lives, when it is not at the root (Azure's `/openai/models`). */
  discoveryRoutePrefix?: string;
  /** Runs a turn against `endpoint`. `endpoint` is usually the runner's fake, but a case may point it at a closed server. */
  stream(endpoint: { url: string }, req: TurnRequest, overrides?: HarnessOverrides): AsyncIterable<ProviderEvent>;
  /** Live discovery against `endpoint`. */
  discover(endpoint: { url: string }, opts?: { maxItems?: number; maxBytes?: number; cache?: DiscoveryCache; signal?: AbortSignal }): Promise<ModelCatalogResult>;
  /** Target-specific assertions every recorded request must satisfy (Azure's `api-version`). */
  assertRequest?(recorded: RecordedRequest): void;
}
