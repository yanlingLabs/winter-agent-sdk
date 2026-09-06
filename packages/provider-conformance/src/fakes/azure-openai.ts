// Lane A's Azure OpenAI fake.
//
// Azure's two surfaces differ in ADDRESSING, not in wire shape, so this fake reuses the family's own
// SSE scripting and adds what is genuinely Azure's: the deployment path, the mandatory `api-version`
// query on every call (including every discovery page), and the `api-key` header.
//
// THE ROUTES REFUSE A MISSING `api-version` THE WAY AZURE DOES. A fake that answered 200 regardless
// would let an adapter that forgot the parameter pass every fixture and fail in production on its
// first call — which is exactly the class of bug the "assert on the LIVE REQUEST" rule exists to
// catch, so the assertion is built into the server rather than left to each case.

import { jsonResponse, startFake, type FakeRoute, type FakeServer, type RecordedRequest, type ScenarioResponder } from "./server.ts";
import { chatModelOf, toolAdjacencyRefusal } from "./openai-chat.ts";
import { callPairingRefusal, responsesModelOf } from "./openai-responses.ts";

export const FAKE_AZURE_KEY = "test-key-azure-0000";
export const FAKE_ENTRA_TOKEN = "test-token-entra-0000";

export interface AzureFakeOptions {
  /** modelId -> scripted answer for the CLASSIC deployment path (chat completions). */
  chatScenarios?: Record<string, ScenarioResponder | Response[]>;
  /** modelId -> scripted answer for the PREVIEW `/openai/v1/responses` surface. */
  responsesScenarios?: Record<string, ScenarioResponder | Response[]>;
  /** Rows served by `/openai/models` and `/openai/v1/models`. */
  models?: unknown[];
  routes?: FakeRoute[];
}

/** The deployment segment a request addressed, or `undefined` for the preview surface. */
export function deploymentOf(recorded: RecordedRequest): string | undefined {
  const match = /^\/openai\/deployments\/([^/]+)\//.exec(recorded.path);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/** The `api-version` a request carried, or `undefined`. */
export function apiVersionOf(recorded: RecordedRequest): string | undefined {
  return new URLSearchParams(recorded.search).get("api-version") ?? undefined;
}

function requireApiVersion(recorded: RecordedRequest): Response | undefined {
  if (apiVersionOf(recorded) !== undefined) return undefined;
  return jsonResponse({ error: { code: "MissingApiVersionParameter", message: "The api-version query parameter is required." } }, 400);
}

/**
 * Azure enforces the SAME body invariants as the surface it is a variant of, so this fake does too
 * (Lane A r3 carry): a `tool` message must answer the `tool_calls` message immediately before it,
 * and a `function_call_output` must follow the `function_call` it answers.
 *
 * "Coverage transfers via the shared mappers" is true of the ADAPTER and says nothing about the
 * FAKE. A fake that accepts anything cannot fail a pin — round 3's broken decoration shape passed
 * every fixture for exactly that reason — and Azure is the surface a host is most likely to reach
 * through a profile, so it is the last one that should be the lenient twin.
 */
function bodyRefusal(recorded: RecordedRequest): Response | undefined {
  return toolAdjacencyRefusal(recorded.body) ?? callPairingRefusal(recorded.body);
}

function dispatch(scenarios: Record<string, ScenarioResponder | Response[]> | undefined, modelOf: (r: RecordedRequest) => string | undefined): (req: Request, recorded: RecordedRequest) => Response | Promise<Response> {
  const attempts = new Map<string, number>();
  return (_req, recorded) => {
    const refusal = requireApiVersion(recorded) ?? bodyRefusal(recorded);
    if (refusal !== undefined) return refusal;
    const model = modelOf(recorded) ?? deploymentOf(recorded);
    const key = model ?? "";
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const entry = model !== undefined ? scenarios?.[model] : undefined;
    if (entry === undefined) return jsonResponse({ error: { code: "DeploymentNotFound", message: `fake: no scenario for ${JSON.stringify(model)}` } }, 404);
    if (Array.isArray(entry)) return entry[Math.min(attempt - 1, entry.length - 1)]!;
    return entry(recorded, attempt);
  };
}

/** Starts a fake serving both Azure surfaces plus their discovery endpoints. */
export async function startAzureFake(opts: AzureFakeOptions): Promise<FakeServer> {
  const models = (_req: Request, recorded: RecordedRequest): Response => {
    const refusal = requireApiVersion(recorded);
    if (refusal !== undefined) return refusal;
    return jsonResponse({ object: "list", data: opts.models ?? [] });
  };
  return startFake({
    routes: [
      { path: "/openai/deployments/*", method: "POST", handler: dispatch(opts.chatScenarios, chatModelOf) },
      { path: "/openai/v1/responses", method: "POST", handler: dispatch(opts.responsesScenarios, responsesModelOf) },
      { path: "/openai/models", method: "GET", handler: models },
      { path: "/openai/v1/models", method: "GET", handler: models },
      ...(opts.routes ?? []),
    ],
  });
}
