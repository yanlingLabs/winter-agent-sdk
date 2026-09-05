// Lane A's `/v1/models` fake — the discovery-edge-case surface.
//
// WS-13 §7 names the behaviours discovery has to survive, and each one is a SHAPE this file can
// produce rather than a story a test tells: pagination, duplicate ids, malformed rows, a removal
// between two calls, a body that is not JSON at all, and a failure that must fall back to a cached
// answer WITHOUT the caller reading the fallback as the current truth.

import { jsonResponse, type FakeRoute, type RecordedRequest } from "./server.ts";

export interface ModelRow {
  id?: unknown;
  display_name?: string;
  context_window?: number;
  [k: string]: unknown;
}

export interface ModelsPage {
  rows: ModelRow[];
  hasMore?: boolean;
}

export interface OpenAiModelsFakeOptions {
  /**
   * Pages, in order. Page N+1 is served when the request carries an `after` cursor equal to page
   * N's last id — so a fixture proves the adapter actually PAGED rather than asking twice.
   */
  pages: ModelsPage[];
  /**
   * Answer the Nth call (1-based) AND EVERY CALL AFTER IT with this status.
   *
   * Persistent rather than a single blip, and the distinction is load-bearing: the cached-fallback
   * probe needs a SECOND failure to prove that a failure with no cache PROPAGATES, and a one-shot
   * failure quietly succeeds on that call instead.
   */
  failOnCall?: { call: number; status: number; body?: unknown };
  /** Serve a body that is not JSON. */
  notJson?: boolean;
  /** Path prefix, for a surface whose discovery does not sit at the root (Azure's `/openai/models`). */
  pathPrefix?: string;
}

/**
 * Routes for `/models` and `/v1/models`.
 *
 * The cursor is honoured rather than ignored: a page is chosen by matching `after` against the
 * previous page's last id, so an adapter that sends no cursor (or the wrong one) re-reads page 1 and
 * a duplicate-id assertion catches it.
 */
export function openAiModelsRoutes(opts: OpenAiModelsFakeOptions): FakeRoute[] {
  let calls = 0;
  const handler = (_req: Request, recorded: RecordedRequest): Response => {
    calls += 1;
    if (opts.failOnCall !== undefined && calls >= opts.failOnCall.call) {
      return jsonResponse(opts.failOnCall.body ?? { error: { message: "discovery is unavailable", type: "server_error", code: "server_error" } }, opts.failOnCall.status);
    }
    if (opts.notJson === true) return new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } });
    const after = new URLSearchParams(recorded.search).get("after");
    let index = 0;
    if (after !== null) {
      const found = opts.pages.findIndex((page) => {
        const last = page.rows.at(-1);
        return last !== undefined && last.id === after;
      });
      index = found >= 0 ? found + 1 : 0;
    }
    const page = opts.pages[index] ?? { rows: [] };
    return jsonResponse({ object: "list", data: page.rows, has_more: page.hasMore === true });
  };
  const prefix = opts.pathPrefix ?? "";
  return [
    { path: `${prefix}/models`, method: "GET", handler },
    { path: `${prefix}/v1/models`, method: "GET", handler },
  ];
}

/** Ollama's own `/api/tags` shape — the local adapter's second discovery door. */
export function ollamaTagsRoute(models: Array<{ name: string; model?: string }>): FakeRoute {
  return {
    path: "/api/tags",
    method: "GET",
    handler: () => jsonResponse({ models: models.map((m) => ({ name: m.name, model: m.model ?? m.name, size: 1, details: { family: "llama" } })) }),
  };
}

/** A `/v1/models` that answers 404 — what a server which only speaks `/api/tags` does. */
export function modelsNotFoundRoutes(): FakeRoute[] {
  const handler = (): Response => jsonResponse({ error: { message: "not found", code: "not_found" } }, 404);
  return [
    { path: "/models", method: "GET", handler },
    { path: "/v1/models", method: "GET", handler },
  ];
}
