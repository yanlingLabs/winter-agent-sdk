// The catalog validator — hand-rolled, dependency-free, total.
//
// FROZEN as of P6 T2's merge (R6-12). Zero dependencies is a REQUIREMENT, not a preference: this
// package is inside the sdk fence (Node-portable, no Bun), and WS-13 §4's "decodable in Bun and
// Swift without executing upstream code" is a claim a validator with an npm dependency graph
// quietly weakens. `ajv` exists in packages/runtime and is deliberately not reached for here.
//
// It is TOTAL: it never throws on any input, including `null`, a string, a cyclic object, or a
// deeply-nested one — every rejection comes back as a message in `errors`. Callers are
// `loadCatalog()` (which throws on a bad bundled catalog, because that is a build defect), Lane X's
// generator (which reports the whole error list), and the catalog's own tests.
//
// Every error message names a JSON-pointer-ish path so a generator can point at the offending row.

import type {
  CapabilityEvidence,
  CatalogValidationError,
  CatalogValidationResult,
  EvidenceConfidence,
  EvidenceSource,
  ModelStatus,
  ProviderAuthKind,
  ProviderProtocol,
  ModelFamilyDescriptor,
  ReasoningCapabilities,
  SlotBasis,
  SlotStatus,
  ToolCalling,
  WinterCatalog,
  WinterModelDescriptor,
  WinterProviderDescriptor,
} from "./types.ts";
// WS-13c: the grammars and the reserved-name list have ONE definition, in `families.ts`, because the
// validator, the runtime's slot resolver and the Agent tool's renderer all key on them. A second
// copy of `^[a-z0-9][a-z0-9.-]{0,31}$` here would be a second answer to "is this a legal slot name".
import { CLAUDE_FAMILY_ID, CLAUDE_RESERVED_SLOT_NAMES, CURRENCY_RE, FAMILY_ID_RE, isSlotServableRow, OTHER_FAMILY_ID, SLOT_NAME_RE } from "./families.ts";

// --- the closed vocabularies. An UNKNOWN value fails (WS-13 §13's acceptance test: "unknown
// category/auth/executor/protocol values fail extraction") -- forward-compat leniency belongs on the
// SWIFT decoder, which ignores unknown FIELDS, not on this gate, which is what stops a typo'd
// protocol from shipping as a silently-unroutable row. -----------------------------------------
const PROTOCOLS: readonly ProviderProtocol[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "google-generate-content",
  "bedrock-converse",
  "azure-openai",
  "custom",
];
const AUTH_KINDS: readonly ProviderAuthKind[] = ["api-key", "oauth-approved", "cloud-credential-chain", "local-none", "custom"];
const EVIDENCE_SOURCES: readonly EvidenceSource[] = ["official-doc", "live-discovery", "live-probe", "upstream-static", "user-override", "local-override", "winter-default"];
const EVIDENCE_CONFIDENCES: readonly EvidenceConfidence[] = ["verified", "declared", "inferred", "unknown"];
const TOOL_CALLING: readonly ToolCalling[] = ["native", "emulated", "none"];
const MODEL_STATUSES: readonly ModelStatus[] = ["candidate", "experimental", "supported", "deprecated", "blocked"];
const MODEL_ENDPOINTS = ["chat", "responses", "embeddings", "image", "audio", "video"] as const;
const MODEL_DISCOVERY = ["none", "openai-models", "provider-native", "local"] as const;
const CATALOG_AUTHORITY = ["authoritative", "partial", "unknown"] as const;
const RISK_CLASSES = ["approved", "review-required", "blocked"] as const;
const PROVIDER_SCOPES = ["llm", "stt", "tts", "embedding", "image", "video", "search"] as const;
const UPSTREAM_PROJECTS = ["OmniRoute", "winter"] as const;
const PRICING_BASES = ["token", "subscription", "free"] as const;
const ADMISSION_BASES = ["api-key", "oauth-documented", "keyless-documented", "local", "cloud-credential"] as const;
const ADMISSION_TIERS = ["fetched-document", "pinned-upstream", "spec-ruling", "local", "audit"] as const;
/** WS-13c §2: where a slot's ranking and text came from, and how far it has been reviewed. */
const SLOT_BASES: readonly SlotBasis[] = ["user-ruling", "vendor-doc", "winter-curated"];
const SLOT_STATUSES: readonly SlotStatus[] = ["candidate", "supported"];
/**
 * WS-13c §1: a FAMILY's own promotion state.
 *
 * Structurally the same two members as `SLOT_STATUSES`, and a separate vocabulary on purpose (fix
 * round 1, M-2): it was hard-coded inline in `checkFamily`, so the JSON Schema's
 * `ModelFamilyDescriptor.properties.status.enum` was a second, unpinned copy. Being in
 * `CATALOG_VOCABULARIES` is what makes the "every vocabulary is covered" parity test demand a case
 * for it — the two can no longer drift in silence, and if the family and slot vocabularies ever
 * diverge (a family reaching `supported` on different evidence than a slot, say) the split is
 * already there.
 */
const FAMILY_STATUSES: readonly ModelFamilyDescriptor["status"][] = ["candidate", "supported"];

/**
 * The header NAMES a reviewed row may put in `identityHeaders` (fix-wave R-FW-2).
 *
 * ONE ENTRY, and widening it is a deliberate edit with a vendor document behind it. `Client-Agent`
 * is AI Horde's documented `<name>:<version>:<contact>` client-identity field. A row that needs a
 * different second identity field adds its name here, in review, beside the document that names it —
 * which is the whole difference between a Winter-authored identity and an imported one.
 */
export const WINTER_IDENTITY_HEADER_NAMES: readonly string[] = ["Client-Agent"];

/** Every identity value names the PRODUCT. `identity.ts` substitutes the placeholders at request time. */
export const WINTER_IDENTITY_VALUE_PREFIX = "winter-agent-sdk";

/**
 * The two tokens an `identityHeaders` VALUE may carry, substituted by the adapter at request time
 * (provider-runtime's `renderIdentityHeaders`).
 *
 * `<version>` predates P7a. `<product>` is D19's: the product token is `brand.packageName` now, so a
 * row that hard-codes Winter's own name is honest for Winter and a LIE for a reuser — it would put
 * Winter's identity on a request the reuser's product made. A row written with `<product>` is
 * truthful under every brand, which is why it is the preferred spelling and why the value check
 * below accepts it as a prefix in its own right.
 */
export const IDENTITY_PRODUCT_PLACEHOLDER = "<product>";
export const IDENTITY_VERSION_PLACEHOLDER = "<version>";
const CONTINUATIONS = ["none", "plaintext", "opaque-provider-state", "server-response-handle"] as const;
const READABLE_STATES = ["none", "summary", "full-exposed"] as const;
const REPLAY_SCOPES = ["current-tool-loop", "current-turn", "selected-turns", "all-turns"] as const;
const TOOL_LOOP_REQUIREMENTS = ["hard-error", "silent-degradation", "not-required"] as const;

/**
 * The closed vocabularies, exported as ONE object so the JSON Schema can be checked against the
 * validator rather than the two drifting apart in silence.
 *
 * The schema is the cross-language contract (Lane X's generator, the Swift decoder) and nothing in
 * this repo executes it — no ajv in the fence — so without a parity test its `enum` arrays are
 * prose. A validator that rejects a value the schema permits (or the reverse) is a row that passes
 * one gate and fails the other, discovered by whoever is furthest from the change.
 */
export const CATALOG_VOCABULARIES = {
  protocols: PROTOCOLS,
  authKinds: AUTH_KINDS,
  evidenceSources: EVIDENCE_SOURCES,
  evidenceConfidences: EVIDENCE_CONFIDENCES,
  toolCalling: TOOL_CALLING,
  modelStatuses: MODEL_STATUSES,
  modelEndpoints: MODEL_ENDPOINTS,
  modelDiscovery: MODEL_DISCOVERY,
  catalogAuthority: CATALOG_AUTHORITY,
  riskClasses: RISK_CLASSES,
  providerScopes: PROVIDER_SCOPES,
  upstreamProjects: UPSTREAM_PROJECTS,
  pricingBases: PRICING_BASES,
  admissionBases: ADMISSION_BASES,
  admissionTiers: ADMISSION_TIERS,
  slotBases: SLOT_BASES,
  slotStatuses: SLOT_STATUSES,
  familyStatuses: FAMILY_STATUSES,
  continuations: CONTINUATIONS,
  readableStates: READABLE_STATES,
  replayScopes: REPLAY_SCOPES,
  toolLoopRequirements: TOOL_LOOP_REQUIREMENTS,
} as const satisfies Record<string, readonly string[]>;

// --- secrets floor (WS-13 §6/§13, R6-10: "descriptors never contain secrets; a catalog test greps
// for key-shaped strings"). Two independent checks, because either alone has a hole:
//
//   1. FIELD NAMES. A descriptor has no legitimate field called `apiKey`/`secret`/`token`/…, so any
//      such key holding a non-empty string is a rejection regardless of what the value looks like.
//      This catches the credential shapes no regex knows (a bare hex string, a short local token).
//   2. VALUE SHAPES. Recognisable credential formats, wherever they appear -- including inside a
//      `sourceRef` URL or a `displayName`, which check (1) would never look at.
//
// Deliberately NOT matched: model ids and endpoint URLs. `AIza`-prefixed and `sk-`-prefixed
// patterns both demand enough trailing entropy that no real model id or hostname reaches them.
const SECRET_FIELD_NAME_RE = /^(?:api[_-]?key|apikey|secret|secret[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|private[_-]?key|client[_-]?secret|session[_-]?token|credential|credentials|authorization|auth[_-]?token|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id)$/i;

const SECRET_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "PEM private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OpenAI/Anthropic-style `sk-` key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/ },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/ },
  // `{35,}` rather than `{35}\b`: the exact-length-then-boundary spelling silently MISSES a key with
  // one extra character (verified — a 36-char tail never matches `{35}\b`, because the 36th char
  // leaves no word boundary and an exact quantifier cannot backtrack to help). A scanner whose
  // failure mode is "close, so it let it through" is the wrong failure mode for a secrets floor.
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35,}/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/ },
  { name: "JWT", re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "inline Bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i },
  { name: "OpenRouter-style `sk-or-` key", re: /\bsk-or-[A-Za-z0-9_-]{10,}/ },
];

/**
 * Recursively scans any JSON value for credential material. Exported because Lane X's generator
 * runs it over the RAW extraction before a row ever reaches a descriptor, and the catalog's own
 * test runs it over the committed file — one implementation, two call sites, no drift.
 *
 * Depth- and breadth-bounded and cycle-safe: a hostile or malformed input can make it return
 * findings, never hang or overflow the stack.
 */
export function scanForSecrets(value: unknown, path = "", seen: Set<object> = new Set(), depth = 0): string[] {
  const findings: string[] = [];
  if (depth > 64) return [`${path || "<root>"}: nesting deeper than 64 levels — refusing to scan further`];
  if (typeof value === "string") {
    for (const { name, re } of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) findings.push(`${path || "<root>"}: looks like a secret (${name})`);
    }
    return findings;
  }
  if (value === null || typeof value !== "object") return findings;
  if (seen.has(value)) return findings;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) findings.push(...scanForSecrets(value[i], `${path}[${i}]`, seen, depth + 1));
    return findings;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const child = path ? `${path}.${k}` : k;
    if (SECRET_FIELD_NAME_RE.test(k) && typeof v === "string" && v.length > 0) {
      findings.push(`${child}: a descriptor must never carry a credential-shaped FIELD (\`${k}\`)`);
    }
    findings.push(...scanForSecrets(v, child, seen, depth + 1));
  }
  return findings;
}

// --- small total checkers -----------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Errors {
  readonly list: CatalogValidationError[] = [];
  /**
   * `code` defaults to the generic `invalid` on purpose. A machine code is only worth having where
   * something ELSE keys on it (R6b-3's admission gate), and retro-coding sixty shape checks would
   * mint sixty codes nothing reads — each of which then becomes a contract a later edit can break.
   */
  add(path: string, message: string, code = "invalid"): void {
    this.list.push({ code, path, message: `${path}: ${message}` });
  }
  /** Requires a non-empty string. Returns undefined (and records) when absent or wrong-typed, so callers can keep going. */
  str(obj: Record<string, unknown>, key: string, path: string): string | undefined {
    const v = obj[key];
    if (typeof v !== "string") {
      this.add(`${path}.${key}`, `expected a string, got ${describe(v)}`);
      return undefined;
    }
    if (v.length === 0) {
      this.add(`${path}.${key}`, "must not be empty");
      return undefined;
    }
    return v;
  }
  optStr(obj: Record<string, unknown>, key: string, path: string): void {
    const v = obj[key];
    if (v === undefined) return;
    if (typeof v !== "string" || v.length === 0) this.add(`${path}.${key}`, `expected a non-empty string when present, got ${describe(v)}`);
  }
  enum<T extends string>(obj: Record<string, unknown>, key: string, path: string, allowed: readonly T[]): void {
    const v = obj[key];
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      this.add(`${path}.${key}`, `unknown value ${describe(v)} — allowed: ${allowed.join(", ")}`);
    }
  }
  optEnum<T extends string>(obj: Record<string, unknown>, key: string, path: string, allowed: readonly T[]): void {
    if (obj[key] === undefined) return;
    this.enum(obj, key, path, allowed);
  }
  strArray(obj: Record<string, unknown>, key: string, path: string): string[] {
    const v = obj[key];
    if (!Array.isArray(v)) {
      this.add(`${path}.${key}`, `expected an array of strings, got ${describe(v)}`);
      return [];
    }
    const out: string[] = [];
    for (let i = 0; i < v.length; i++) {
      const item = v[i];
      if (typeof item !== "string" || item.length === 0) this.add(`${path}.${key}[${i}]`, `expected a non-empty string, got ${describe(item)}`);
      else out.push(item);
    }
    return out;
  }
  enumArray<T extends string>(obj: Record<string, unknown>, key: string, path: string, allowed: readonly T[], minItems = 1): void {
    const v = obj[key];
    if (!Array.isArray(v)) {
      this.add(`${path}.${key}`, `expected an array, got ${describe(v)}`);
      return;
    }
    if (v.length < minItems) this.add(`${path}.${key}`, `expected at least ${minItems} entr${minItems === 1 ? "y" : "ies"}`);
    for (let i = 0; i < v.length; i++) {
      const item = v[i];
      if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) {
        this.add(`${path}.${key}[${i}]`, `unknown value ${describe(item)} — allowed: ${allowed.join(", ")}`);
      }
    }
  }
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array(${v.length})`;
  if (typeof v === "object") return "an object";
  return JSON.stringify(v) ?? String(v);
}

/**
 * A citation that names the audit's `unknown` evidence class rather than a document.
 *
 * Anchored, and case-insensitive on the class name only: `audit:unknown`, `audit:unknown-pending`,
 * or the bare word. It deliberately does NOT match a URL that merely contains "unknown" somewhere in
 * its path — the rule is about a row that admits it has no decisive document, not about spelling.
 */
export const UNKNOWN_CITATION_RE = /^(?:audit:)?unknown(?:$|[:/\-\s])/i;

/** ISO-8601 instant, the only `observedAt` spelling the catalog admits (a date-only string is a rejection: evidence needs an instant, not a day). */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function checkEvidence(errs: Errors, value: unknown, path: string, checkValue: (v: unknown, p: string) => void, required: boolean): void {
  if (value === undefined) {
    if (required) errs.add(path, "required capability evidence is missing");
    return;
  }
  if (!isRecord(value)) {
    errs.add(path, `expected a CapabilityEvidence object, got ${describe(value)}`);
    return;
  }
  if (!("value" in value)) errs.add(`${path}.value`, "required");
  else checkValue(value.value, `${path}.value`);
  errs.enum(value, "source", path, EVIDENCE_SOURCES);
  errs.enum(value, "confidence", path, EVIDENCE_CONFIDENCES);
  // WINTER'S OWN SOURCES CANNOT BE `verified`. `winter-default` is a value chosen in the absence of
  // any statement and `local-override` is a non-vendor declaration — neither is something a probe or
  // a document confirmed, and `verified` is what promotes a row (WS-13 §13). Without this the two
  // new members would be a laundering route into the assurance the other five have to earn.
  const source = value["source"];
  if ((source === "winter-default" || source === "local-override") && value["confidence"] === "verified") {
    errs.add(`${path}.confidence`, `evidence sourced "${source}" is Winter's own and can never be "verified" — nothing external confirmed it`);
  }
  errs.optStr(value, "sourceRef", path);
  const observedAt = value["observedAt"];
  if (observedAt !== undefined && (typeof observedAt !== "string" || !ISO_INSTANT_RE.test(observedAt))) {
    errs.add(`${path}.observedAt`, `expected an ISO-8601 instant, got ${describe(observedAt)}`);
  }
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isFiniteNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function checkPricing(errs: Errors, v: unknown, path: string): void {
  if (!isRecord(v)) {
    errs.add(path, `expected a pricing object, got ${describe(v)}`);
    return;
  }
  for (const k of ["inputPerMTokUsd", "outputPerMTokUsd"]) {
    if (!isFiniteNonNegative(v[k])) errs.add(`${path}.${k}`, `expected a finite non-negative number, got ${describe(v[k])}`);
  }
  for (const k of ["cacheReadPerMTokUsd", "cacheWritePerMTokUsd"]) {
    if (v[k] !== undefined && !isFiniteNonNegative(v[k])) errs.add(`${path}.${k}`, `expected a finite non-negative number when present, got ${describe(v[k])}`);
  }
}

function checkReasoning(errs: Errors, v: unknown, path: string): void {
  if (!isRecord(v)) {
    errs.add(path, `expected a reasoning object, got ${describe(v)}`);
    return;
  }
  checkEvidence(errs, v["supported"], `${path}.supported`, (val, p) => {
    if (typeof val !== "boolean") errs.add(p, `expected a boolean, got ${describe(val)}`);
  }, true);
  errs.strArray(v, "efforts", path);
  errs.optStr(v, "defaultEffort", path);
  errs.enum(v, "continuation", path, CONTINUATIONS);
  const defaultEffort = v["defaultEffort"];
  const efforts = Array.isArray(v["efforts"]) ? (v["efforts"] as unknown[]) : [];
  if (typeof defaultEffort === "string" && !efforts.includes(defaultEffort)) {
    errs.add(`${path}.defaultEffort`, `${JSON.stringify(defaultEffort)} is not one of this model's own \`efforts\` — an adapter would have to invent it`);
  }
  checkEvidence(errs, v["readableState"], `${path}.readableState`, (val, p) => {
    if (typeof val !== "string" || !(READABLE_STATES as readonly string[]).includes(val)) errs.add(p, `unknown readable-state ${describe(val)}`);
  }, false);
  checkEvidence(errs, v["summaryRequest"], `${path}.summaryRequest`, (val, p) => {
    if (!isRecord(val)) return errs.add(p, `expected {field, values}, got ${describe(val)}`);
    if (typeof val["field"] !== "string" || val["field"].length === 0) errs.add(`${p}.field`, "expected a non-empty string");
    if (!Array.isArray(val["values"]) || val["values"].some((x) => typeof x !== "string")) errs.add(`${p}.values`, "expected an array of strings");
  }, false);
  checkEvidence(errs, v["replayScope"], `${path}.replayScope`, (val, p) => {
    if (typeof val !== "string" || !(REPLAY_SCOPES as readonly string[]).includes(val)) errs.add(p, `unknown replay scope ${describe(val)}`);
  }, false);
  checkEvidence(errs, v["continuationDomain"], `${path}.continuationDomain`, (val, p) => {
    if (!Array.isArray(val) || val.some((x) => typeof x !== "string")) errs.add(p, `expected an array of model keys, got ${describe(val)}`);
  }, false);
  checkEvidence(errs, v["completionEvent"], `${path}.completionEvent`, (val, p) => {
    if (typeof val !== "string" || val.length === 0) errs.add(p, `expected a non-empty event name, got ${describe(val)}`);
  }, false);
  checkEvidence(errs, v["toolLoopRequirement"], `${path}.toolLoopRequirement`, (val, p) => {
    if (typeof val !== "string" || !(TOOL_LOOP_REQUIREMENTS as readonly string[]).includes(val)) errs.add(p, `unknown tool-loop requirement ${describe(val)}`);
  }, false);
}

function checkProvider(errs: Errors, v: unknown, path: string): void {
  if (!isRecord(v)) {
    errs.add(path, `expected a provider descriptor, got ${describe(v)}`);
    return;
  }
  errs.str(v, "id", path);
  errs.str(v, "displayName", path);
  errs.str(v, "adapterId", path);
  errs.str(v, "family", path);
  errs.enumArray(v, "protocols", path, PROTOCOLS);
  errs.enumArray(v, "authKinds", path, AUTH_KINDS);
  errs.enum(v, "modelDiscovery", path, MODEL_DISCOVERY);
  errs.enum(v, "liveCatalogAuthority", path, CATALOG_AUTHORITY);
  errs.enum(v, "scope", path, PROVIDER_SCOPES);

  // --- P7a (Lane D): the PER-TENANT rows — WS-13b §2/§10's user-entered endpoint field -----------
  //
  // The spine declared the vocabulary and checked the two fields' SHAPE; these are the rules that
  // give them meaning, landing with the two rows that set them (`azure-ai`, `oci`).
  //
  // `requiresUserEndpoint: false` is refused rather than ignored (the spine's rule, kept): absence
  // already means "the row's endpoint is usable as shipped", so a row spelling the negative is
  // making a claim the vocabulary has no room for — most likely a typo for the positive.
  const requiresUserEndpoint = v["requiresUserEndpoint"];
  if (requiresUserEndpoint !== undefined && requiresUserEndpoint !== true) {
    errs.add(`${path}.requiresUserEndpoint`, `expected \`true\` or absence (absence means the row's endpoint is usable as shipped), got ${describe(requiresUserEndpoint)}`);
  }
  const endpointTemplate = v["endpointTemplate"];
  if (endpointTemplate !== undefined && (typeof endpointTemplate !== "string" || endpointTemplate.length === 0)) {
    errs.add(`${path}.endpointTemplate`, `expected a non-empty documentation string, got ${describe(endpointTemplate)}`);
  }
  const endpoints = v["defaultEndpoints"];
  if (requiresUserEndpoint === true) {
    // (a) THE TEMPLATE IS REQUIRED. It is the only thing the runtime's `endpoint-required` refusal
    // has to show a user — "this provider needs an endpoint" without the shape it must take is a
    // refusal nobody can act on.
    if (endpointTemplate === undefined) {
      errs.add(
        `${path}.endpointTemplate`,
        "required on a `requiresUserEndpoint` row — WS-13b §2/§10: the row ships no endpoint, so the DOCUMENTED SHAPE is the only thing the runtime's `endpoint-required` refusal can name. It is documentation and is never sent",
        "endpoint-template-missing",
      );
    }
    // (b) NO USABLE `api` ENDPOINT — presence, not shape.
    //
    // The rule is about what the row SHIPS, not about how convincing the string is. A sentinel that
    // wears its brackets (`https://<resource>.services.ai.azure.com/…`) is already refused two ways
    // over — `new URL` throws on it, and every consumer of `defaultEndpoints.api` treats the key's
    // presence as "there is an endpoint here". What a shape rule would NOT catch is the dangerous
    // one: a plausible placeholder (`https://tenant.example/v1`) that parses, validates, and is
    // copied into a connection profile by `connectionFrom` for a multi-provider adapter — the row
    // then resolves, generates, and reaches somebody else's host. So ANY `api` key is the refusal.
    if (isRecord(endpoints) && endpoints["api"] !== undefined) {
      errs.add(
        `${path}.defaultEndpoints.api`,
        `a \`requiresUserEndpoint\` row must ship NO \`api\` endpoint at all (got ${describe(endpoints["api"])}) — WS-13b §2: the base URL is per-tenant, and a sentinel standing in for one is not "no endpoint", it is an endpoint the runtime will copy into a connection profile and call. Put the shape in \`endpointTemplate\` instead`,
        "endpoint-sentinel",
      );
    }
  } else if (endpointTemplate !== undefined) {
    // (c) THE INVERSE. A template on a row that ships a usable endpoint is a row contradicting
    // itself: either the endpoint is real (and the template is a lie about needing one) or it is a
    // sentinel (and the row is (b) wearing a disguise). Neither is shippable.
    errs.add(
      `${path}.endpointTemplate`,
      "is only meaningful on a `requiresUserEndpoint` row — a row that ships a usable endpoint has nothing for a host to fill in. Set `requiresUserEndpoint: true` and drop `defaultEndpoints.api`, or drop the template",
      "endpoint-template-orphan",
    );
  }

  if (!isRecord(endpoints)) errs.add(`${path}.defaultEndpoints`, `expected an object of endpoint URLs, got ${describe(endpoints)}`);
  else {
    for (const [k, url] of Object.entries(endpoints)) {
      if (typeof url !== "string" || url.length === 0) {
        errs.add(`${path}.defaultEndpoints.${k}`, `expected a non-empty URL string, got ${describe(url)}`);
        continue;
      }
      // Generated endpoints are IMMUTABLE and reviewed (R6-11), so the bar here is a parseable
      // absolute URL on a scheme the endpoint policy admits. Loopback `http://` is legitimate and
      // expected: the twelve local providers are all localhost-by-default (WS-13 §12).
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        errs.add(`${path}.defaultEndpoints.${k}`, `not a parseable absolute URL: ${JSON.stringify(url)}`);
        continue;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") errs.add(`${path}.defaultEndpoints.${k}`, `unsupported scheme ${JSON.stringify(parsed.protocol)}`);
      if (parsed.username.length > 0 || parsed.password.length > 0) errs.add(`${path}.defaultEndpoints.${k}`, "URL carries userinfo — a credential must never ride an endpoint");
      if (parsed.search.length > 0) errs.add(`${path}.defaultEndpoints.${k}`, "URL carries a query string — parameters belong in the adapter's request, never in a stored endpoint");
    }
  }
  const upstream = v["upstream"];
  if (!isRecord(upstream)) errs.add(`${path}.upstream`, `expected {project, commit, sourcePaths}, got ${describe(upstream)}`);
  else {
    errs.enum(upstream, "project", `${path}.upstream`, UPSTREAM_PROJECTS);
    if (typeof upstream["commit"] !== "string") errs.add(`${path}.upstream.commit`, `expected a string (empty is legal: it marks a row no extraction produced), got ${describe(upstream["commit"])}`);
    if (!Array.isArray(upstream["sourcePaths"]) || upstream["sourcePaths"].some((x) => typeof x !== "string")) {
      errs.add(`${path}.upstream.sourcePaths`, `expected an array of strings, got ${describe(upstream["sourcePaths"])}`);
    }
  }
  // --- WS-13b §1 (D21 / R6b-3): the row's own evidence -------------------------------------------
  //
  // `pricingBasis` carries its OWN code because R6-H's cost path keys on it: a row that lost the
  // field would otherwise be priced per token by whatever `pricing` evidence its models happen to
  // carry, which for a seat is a confidently wrong number.
  if (v["pricingBasis"] === undefined) errs.add(`${path}.pricingBasis`, "required — WS-13b §1: every row records how the vendor charges for the credential Winter uses, because `subscription`/`free` rows must never feed R6-H token cost", "pricing-basis-missing");
  else errs.enum(v, "pricingBasis", path, PRICING_BASES);

  const admission = v["admission"];
  if (!isRecord(admission)) {
    errs.add(`${path}.admission`, `required — WS-13b §1 (D21): a row ships only through a DOCUMENTED third-party path, and the citation that admits it travels on the row. Got ${describe(admission)}`, "admission-missing");
  } else {
    errs.enum(admission, "basis", `${path}.admission`, ADMISSION_BASES);
    // R-FW-3: the evidence TIER is data, and required. It was a marker inside the citation string,
    // which meant nothing could key on it -- the one test that claimed to enforce it matched
    // `^https?://`, which a pinned-upstream citation satisfies just as happily as a fetched
    // document's URL. `admission-tier-missing` is its own code because `catalog-integrity` keys the
    // promotion rule on the value.
    if (admission["tier"] === undefined) {
      errs.add(`${path}.admission.tier`, "required — WS-13b §1 (fix-wave R-FW-3): every row records HOW GOOD its admission evidence is, because promotion is two-key (a live pass AND a fetched document) and a rule keyed on a substring inside the citation is a rule that drifts", "admission-tier-missing");
    } else {
      errs.enum(admission, "tier", `${path}.admission`, ADMISSION_TIERS);
    }
    const citation = admission["citation"];
    if (typeof citation !== "string" || citation.trim().length === 0) {
      errs.add(`${path}.admission.citation`, `expected a non-empty citation (a vendor URL, \`audit:<section>\`, \`spec:<section>\`, or \`local\`), got ${describe(citation)}`, "admission-missing");
    } else if (UNKNOWN_CITATION_RE.test(citation.trim())) {
      // R6b-3's second half. The audit's `unknown` class means "the decisive document was not
      // found", whose disposition is EXCLUDE — so this is not weak evidence to flag, it is a row
      // that may not ship at all, and the refusal has to be here rather than in a reviewer's head.
      errs.add(`${path}.admission.citation`, `cites the audit's \`unknown\` evidence class (${JSON.stringify(citation)}) — WS-13b §1: "a row whose evidence is \`unknown\` does not ship". Find the document or drop the row`, "admission-unknown");
    }
  }

  // WS-13b §7/§8.4 (R-FW-2): the row's SECOND identity field, if the vendor names one.
  //
  // Both halves are enforcement, not tidiness. A free-text NAME would let a row put a vendor's
  // product-identity header on the wire, which WS-13 §5 and D21 exist to forbid — so the name comes
  // from a Winter-authored allowlist and a row may not invent one. A free-text VALUE would let a row
  // present Winter as an editor or a first-party CLI in the very field whose purpose is honest
  // identity — so it must name Winter, in Winter's own form.
  const identityHeaders = v["identityHeaders"];
  if (identityHeaders !== undefined) {
    if (!isRecord(identityHeaders)) {
      errs.add(`${path}.identityHeaders`, `expected an object of header name -> value, got ${describe(identityHeaders)}`, "identity-header-invalid");
    } else {
      for (const [name, value] of Object.entries(identityHeaders)) {
        if (!WINTER_IDENTITY_HEADER_NAMES.some((allowed) => allowed.toLowerCase() === name.toLowerCase())) {
          errs.add(
            `${path}.identityHeaders.${name}`,
            `${JSON.stringify(name)} is not a Winter-authored identity header. WS-13 §5 / D21: a row may not name its own header here — a vendor's product-identity field is exactly what that rule forbids. Allowed: ${WINTER_IDENTITY_HEADER_NAMES.join(", ")}`,
            "identity-header-invalid",
          );
        }
        // TWO ACCEPTED PREFIXES, and the placeholder is the preferred one (P7a, D19): a value
        // starting `<product>` names whatever brand is running, which is truthful for Winter AND
        // for a reuser; the literal Winter token stays accepted for rows written before the
        // profile existed. Anything else still fails — the rule this enforces is not "spell it our
        // way", it is "an identity field must name the client that is actually speaking".
        if (typeof value !== "string" || !(value.startsWith(IDENTITY_PRODUCT_PLACEHOLDER) || value.startsWith(WINTER_IDENTITY_VALUE_PREFIX))) {
          errs.add(
            `${path}.identityHeaders.${name}`,
            `expected a value naming the product (starting ${JSON.stringify(IDENTITY_PRODUCT_PLACEHOLDER)} — preferred — or ${JSON.stringify(WINTER_IDENTITY_VALUE_PREFIX)}; both \`<product>\` and \`<version>\` are substituted by the adapter), got ${describe(value)} — an identity field that names anything else is not a configuration error, it is impersonation`,
            "identity-header-invalid",
          );
        }
      }
    }
  }

  const risk = v["risk"];
  if (!isRecord(risk)) errs.add(`${path}.risk`, `expected {class, reasons}, got ${describe(risk)}`);
  else {
    errs.enum(risk, "class", `${path}.risk`, RISK_CLASSES);
    if (!Array.isArray(risk["reasons"]) || risk["reasons"].some((x) => typeof x !== "string")) {
      errs.add(`${path}.risk.reasons`, `expected an array of strings, got ${describe(risk["reasons"])}`);
    } else if (risk["class"] !== "approved" && risk["reasons"].length === 0) {
      errs.add(`${path}.risk.reasons`, "a non-approved risk class must record WHY — an unexplained block is unreviewable");
    }
  }
}

/**
 * WS-13c §1's integrity rules that are LOCAL to one family descriptor (R13c-3).
 *
 * The cross-cutting ones — the Claude reservation, duplicate family ids, and every slot's model row
 * actually existing — need the whole document and live in `validateCatalog` below.
 *
 * Written in `checkProvider`'s style deliberately: same total-checker vocabulary, same
 * path-prefixed messages, and a specific `code` only where something else keys on it. The families
 * overlay is a hand-authored, reviewed file exactly like the provider and model overlays, so the
 * thing standing between a typo in it and a shipped catalog is this function.
 */
function checkFamily(errs: Errors, v: unknown, path: string): void {
  if (!isRecord(v)) {
    errs.add(path, `expected a model-family descriptor, got ${describe(v)}`);
    return;
  }
  const id = errs.str(v, "id", path);
  if (id !== undefined && !FAMILY_ID_RE.test(id)) {
    errs.add(`${path}.id`, `${JSON.stringify(id)} is not a family id — expected ${FAMILY_ID_RE.source}`);
  }
  errs.str(v, "displayName", path);
  errs.str(v, "vendor", path);
  errs.str(v, "citation", path);
  errs.strArray(v, "vendorProviders", path);
  errs.enum(v, "status", path, FAMILY_STATUSES);

  const matchers = v["matchers"];
  if (!Array.isArray(matchers)) {
    errs.add(`${path}.matchers`, `expected an array of {pattern, note}, got ${describe(matchers)}`);
  } else {
    for (let i = 0; i < matchers.length; i++) {
      const m = matchers[i];
      const mp = `${path}.matchers[${i}]`;
      if (!isRecord(m)) {
        errs.add(mp, `expected {pattern, note}, got ${describe(m)}`);
        continue;
      }
      const pattern = errs.str(m, "pattern", mp);
      if (typeof m["note"] !== "string") errs.add(`${mp}.note`, `expected a string (empty is legal), got ${describe(m["note"])}`);
      // A pattern that does not COMPILE is the failure mode a reviewer cannot see: `familyIdOf`
      // builds a `RegExp` from it at every stamp, so a bad source would throw inside the pipeline
      // rather than report here.
      if (pattern !== undefined) {
        try {
          new RegExp(pattern);
        } catch (error) {
          errs.add(`${mp}.pattern`, `is not a compilable regular expression (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }

  const slots = v["slots"];
  if (!Array.isArray(slots)) {
    errs.add(`${path}.slots`, `expected an array of slots (0-4), got ${describe(slots)}`, "slots-invalid");
    return;
  }
  // D26: "four slots are the options". More than four is not a listing to truncate at render time —
  // it is a family whose author disagreed with the ruling, and the disagreement belongs in review.
  if (slots.length > 4) errs.add(`${path}.slots`, `a family carries at most 4 slots (WS-13c §1/D26), got ${slots.length}`, "slots-too-many");
  const seenNames = new Set<string>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const sp = `${path}.slots[${i}]`;
    if (!isRecord(slot)) {
      errs.add(sp, `expected a slot, got ${describe(slot)}`);
      continue;
    }
    const name = slot["name"];
    if (typeof name !== "string" || !SLOT_NAME_RE.test(name)) {
      errs.add(`${sp}.name`, `${describe(name)} is not a slot token — expected ${SLOT_NAME_RE.source}`, "slot-name-invalid");
    } else {
      if (seenNames.has(name)) errs.add(`${sp}.name`, `duplicate slot name ${JSON.stringify(name)} within family ${JSON.stringify(id ?? "?")}`, "slot-name-duplicate");
      seenNames.add(name);
    }
    errs.str(slot, "canonicalModelId", sp);
    errs.str(slot, "reason", sp);
    errs.str(slot, "citation", sp);
    errs.optStr(slot, "provider", sp);
    errs.enum(slot, "basis", sp, SLOT_BASES);
    errs.enum(slot, "status", sp, SLOT_STATUSES);
    const description = errs.str(slot, "description", sp);
    // Pricing lives on model rows, inside a `CapabilityEvidence<ModelPricing>` with a source and an
    // instant. A number in prose has none of that: it cannot be re-checked, it cannot be updated by
    // a pipeline run, and it is read by a user as a current price long after it stopped being one.
    if (description !== undefined && CURRENCY_RE.test(description)) {
      errs.add(`${sp}.description`, `carries a currency amount (${JSON.stringify(description)}) — WS-13c §1: pricing lives on model rows with its own evidence, never in a slot description`, "slot-description-currency");
    }
  }
}

function checkModel(errs: Errors, v: unknown, path: string): void {
  if (!isRecord(v)) {
    errs.add(path, `expected a model descriptor, got ${describe(v)}`);
    return;
  }
  const key = errs.str(v, "key", path);
  const providerId = errs.str(v, "providerId", path);
  const upstreamId = errs.str(v, "upstreamId", path);
  errs.str(v, "displayName", path);
  errs.strArray(v, "aliases", path);
  errs.enumArray(v, "endpoints", path, MODEL_ENDPOINTS);
  errs.strArray(v, "unsupportedParameters", path);
  errs.enum(v, "status", path, MODEL_STATUSES);

  // WS-13c §1: both derived fields are REQUIRED on every row. They carry their own codes because
  // the stamp is a PIPELINE step — a row that reached the document without one means the assembler
  // was bypassed, not that a hand-authored field was forgotten, and the two are worth telling apart.
  if (typeof v["modelFamily"] !== "string" || v["modelFamily"].length === 0) {
    errs.add(`${path}.modelFamily`, `required — WS-13c §1: every row carries its family id (or ${JSON.stringify(OTHER_FAMILY_ID)}), stamped at build by \`stampFamilyFields\`. Got ${describe(v["modelFamily"])}`, "model-family-missing");
  }
  if (typeof v["canonicalModelId"] !== "string" || v["canonicalModelId"].length === 0) {
    errs.add(`${path}.canonicalModelId`, `required — WS-13c §1: the vendor's model identity with the provider's spelling removed, stamped at build. Got ${describe(v["canonicalModelId"])}`, "model-canonical-missing");
  }

  // WS-13 §8.3: the key IS `<providerId>/<upstreamId-or-alias>`; a key that does not start with its
  // own provider is a routing bug waiting to happen (the registry splits on the first "/").
  if (key !== undefined && providerId !== undefined && !key.startsWith(`${providerId}/`)) {
    errs.add(`${path}.key`, `must be "<providerId>/<model>" — ${JSON.stringify(key)} does not start with ${JSON.stringify(`${providerId}/`)}`);
  }
  if (key !== undefined && providerId !== undefined && upstreamId !== undefined && key !== `${providerId}/${upstreamId}`) {
    errs.add(`${path}.key`, `expected ${JSON.stringify(`${providerId}/${upstreamId}`)} — the key's model half must be the upstreamId, with aliases in \`aliases\``);
  }

  const evidenceNumber = (val: unknown, p: string): void => {
    if (!isPositiveInt(val)) errs.add(p, `expected a positive integer, got ${describe(val)}`);
  };
  const evidenceBoolean = (val: unknown, p: string): void => {
    if (typeof val !== "boolean") errs.add(p, `expected a boolean, got ${describe(val)}`);
  };
  const evidenceStringArray = (val: unknown, p: string): void => {
    if (!Array.isArray(val) || val.some((x) => typeof x !== "string" || x.length === 0)) errs.add(p, `expected a non-empty array of strings, got ${describe(val)}`);
    else if (val.length === 0) errs.add(p, "expected at least one entry");
  };

  checkEvidence(errs, v["contextWindow"], `${path}.contextWindow`, evidenceNumber, false);
  checkEvidence(errs, v["maxInputTokens"], `${path}.maxInputTokens`, evidenceNumber, false);
  checkEvidence(errs, v["maxOutputTokens"], `${path}.maxOutputTokens`, evidenceNumber, false);
  checkEvidence(errs, v["inputModalities"], `${path}.inputModalities`, evidenceStringArray, true);
  checkEvidence(errs, v["outputModalities"], `${path}.outputModalities`, evidenceStringArray, true);
  checkEvidence(errs, v["toolCalling"], `${path}.toolCalling`, (val, p) => {
    if (typeof val !== "string" || !(TOOL_CALLING as readonly string[]).includes(val)) errs.add(p, `unknown tool-calling state ${describe(val)} — allowed: ${TOOL_CALLING.join(", ")}`);
  }, true);
  checkEvidence(errs, v["nativeTools"], `${path}.nativeTools`, evidenceBoolean, true);
  checkEvidence(errs, v["parallelTools"], `${path}.parallelTools`, evidenceBoolean, false);
  checkEvidence(errs, v["structuredOutput"], `${path}.structuredOutput`, evidenceBoolean, false);
  checkEvidence(errs, v["promptCaching"], `${path}.promptCaching`, evidenceBoolean, false);
  checkEvidence(errs, v["classifierEligible"], `${path}.classifierEligible`, evidenceBoolean, false);
  checkEvidence(errs, v["pricing"], `${path}.pricing`, (val, p) => checkPricing(errs, val, p), false);
  if (v["reasoning"] !== undefined) checkReasoning(errs, v["reasoning"], `${path}.reasoning`);
}

/**
 * Validates any JSON value as a `WinterCatalog`. Never throws.
 *
 * Beyond per-field shape and closed-vocabulary checks it enforces the four structural invariants
 * WS-13 §13's acceptance list names, plus the secrets floor:
 *
 *  - provider `id` unique across the catalog;
 *  - model `key` unique across the catalog (this is the registry's primary index);
 *  - within ONE provider, `upstreamId ∪ aliases` is collision-free — alias scope is per-provider by
 *    design (two providers may both serve a model called `sonnet`), and an alias colliding with a
 *    sibling's real id would make resolution order load-bearing;
 *  - every model's `providerId` names a provider that exists (an orphan row is unresolvable);
 *  - no credential-shaped field or value anywhere in the document.
 */
export function validateCatalog(json: unknown): CatalogValidationResult {
  const errs = new Errors();
  if (!isRecord(json)) return { ok: false, errors: [{ code: "invalid", path: "<root>", message: `<root>: expected a catalog object, got ${describe(json)}` }] };

  // 2 since WS-13c. Its own code because the family fields are NOT optional at 2: a document still
  // claiming 1 is one whose rows may lack `modelFamily`/`canonicalModelId` entirely, and every
  // consumer of the family layer would then read `undefined` from a catalog that validated.
  if (json["schemaVersion"] !== 2) errs.add("schemaVersion", `expected the literal 2, got ${describe(json["schemaVersion"])}`, "schema-version");
  errs.str(json, "catalogVersion", "<root>");

  const upstream = json["upstream"];
  if (!isRecord(upstream)) errs.add("upstream", `expected the pin object, got ${describe(upstream)}`);
  else {
    // Every field may be the EMPTY string: that is precisely how the hand-authored seed says "no
    // extraction produced this". What is not allowed is a missing or non-string field.
    for (const k of ["tag", "tagObject", "commit", "extractorVersion", "overlayVersion"]) {
      if (typeof upstream[k] !== "string") errs.add(`upstream.${k}`, `expected a string (empty is legal), got ${describe(upstream[k])}`);
    }
  }

  const providers = json["providers"];
  const providerIds = new Set<string>();
  if (!Array.isArray(providers)) errs.add("providers", `expected an array, got ${describe(providers)}`);
  else {
    for (let i = 0; i < providers.length; i++) {
      const path = `providers[${i}]`;
      checkProvider(errs, providers[i], path);
      const row = providers[i];
      if (isRecord(row) && typeof row["id"] === "string" && row["id"].length > 0) {
        if (providerIds.has(row["id"])) errs.add(`${path}.id`, `duplicate provider id ${JSON.stringify(row["id"])}`);
        providerIds.add(row["id"]);
      }
    }
  }

  // --- WS-13c §1: the family layer -----------------------------------------------------------------
  //
  // `families` is REQUIRED and may be EMPTY. A family is not: the upstream layer's own standalone
  // check (merge.ts's `mergeLayers`, provider-source-sync's `--offline` gate) validates a document
  // whose slots' model rows all live in the overlay it does not have, so the rules below are shaped
  // "IF a claude family is present, its slots are exactly the four, in order" rather than
  // "claude must be present". Presence on the SHIPPED catalog is pinned by catalog-integrity.
  const families = json["families"];
  const familyIds = new Set<string>();
  if (!Array.isArray(families)) {
    errs.add("families", `required — WS-13c §1: the vendor lineups the Agent tool's per-family enum and the slot resolver read. An empty array is legal; a missing key is not. Got ${describe(families)}`, "families-missing");
  } else {
    for (let i = 0; i < families.length; i++) {
      const path = `families[${i}]`;
      checkFamily(errs, families[i], path);
      const row = families[i];
      if (isRecord(row) && typeof row["id"] === "string" && row["id"].length > 0) {
        if (familyIds.has(row["id"])) errs.add(`${path}.id`, `duplicate family id ${JSON.stringify(row["id"])}`, "family-id-duplicate");
        familyIds.add(row["id"]);
      }
    }

    // D25, the concrete form of "no false information": `fable`/`opus`/`sonnet`/`haiku` name Claude
    // models and nothing else. A `gpt` family that used one would put a Claude name on an enum whose
    // resolution reaches an OpenAI model — the exact thing the ruling forbids.
    for (let i = 0; i < families.length; i++) {
      const row = families[i];
      if (!isRecord(row) || !Array.isArray(row["slots"])) continue;
      const id = typeof row["id"] === "string" ? row["id"] : "";
      const names = (row["slots"] as unknown[]).map((s) => (isRecord(s) && typeof s["name"] === "string" ? s["name"] : ""));
      if (id === CLAUDE_FAMILY_ID) {
        if (names.length !== CLAUDE_RESERVED_SLOT_NAMES.length || names.some((n, k) => n !== CLAUDE_RESERVED_SLOT_NAMES[k])) {
          errs.add(
            `families[${i}].slots`,
            `the \`claude\` family's slots are PINNED to [${CLAUDE_RESERVED_SLOT_NAMES.join(", ")}] in that order (WS-13c §1/D25 — the compat enum the Claude Agent SDK ships), got [${names.join(", ")}]`,
            "claude-slots-pinned",
          );
        }
        continue;
      }
      for (let s = 0; s < names.length; s++) {
        if (CLAUDE_RESERVED_SLOT_NAMES.includes(names[s]!)) {
          errs.add(
            `families[${i}].slots[${s}].name`,
            `${JSON.stringify(names[s])} is reserved to the \`claude\` family (WS-13c §1/D25: a non-Claude model must never be offered under a Claude lineup name)`,
            "slot-name-reserved",
          );
        }
      }
    }
  }

  const models = json["models"];
  const modelKeys = new Set<string>();
  /** providerId -> the set of names that resolve inside it (upstreamId ∪ aliases). */
  const namesByProvider = new Map<string, Set<string>>();
  if (!Array.isArray(models)) errs.add("models", `expected an array, got ${describe(models)}`);
  else {
    for (let i = 0; i < models.length; i++) {
      const path = `models[${i}]`;
      checkModel(errs, models[i], path);
      const row = models[i];
      if (!isRecord(row)) continue;
      const key = typeof row["key"] === "string" ? row["key"] : undefined;
      const providerId = typeof row["providerId"] === "string" ? row["providerId"] : undefined;
      const upstreamId = typeof row["upstreamId"] === "string" ? row["upstreamId"] : undefined;
      if (key !== undefined && key.length > 0) {
        if (modelKeys.has(key)) errs.add(`${path}.key`, `duplicate model key ${JSON.stringify(key)}`);
        modelKeys.add(key);
      }
      if (providerId !== undefined && providerId.length > 0 && providers !== undefined && Array.isArray(providers) && !providerIds.has(providerId)) {
        errs.add(`${path}.providerId`, `names no provider in this catalog (${JSON.stringify(providerId)}) — an orphan model row is unresolvable`);
      }
      if (providerId === undefined) continue;
      let names = namesByProvider.get(providerId);
      if (names === undefined) {
        names = new Set<string>();
        namesByProvider.set(providerId, names);
      }
      const candidates: Array<{ name: string; where: string }> = [];
      if (upstreamId !== undefined && upstreamId.length > 0) candidates.push({ name: upstreamId, where: `${path}.upstreamId` });
      const aliases = row["aliases"];
      if (Array.isArray(aliases)) {
        for (let a = 0; a < aliases.length; a++) {
          const alias = aliases[a];
          if (typeof alias === "string" && alias.length > 0) candidates.push({ name: alias, where: `${path}.aliases[${a}]` });
        }
      }
      for (const { name, where } of candidates) {
        if (names.has(name)) errs.add(where, `${JSON.stringify(name)} already resolves inside provider ${JSON.stringify(providerId)} — model ids and aliases share one namespace per provider`);
        names.add(name);
      }
    }
  }

  // --- WS-13c §1/§4: the family layer's claims about the MODEL rows ---------------------------------
  //
  // Both rules exist because a slot is a PROMISE the catalog makes to a user's picker: a slot whose
  // canonical id names nothing shippable renders an option that cannot resolve, and a `provider` pin
  // naming a provider that does not serve the model is a resolution that fails only at turn time.
  // Neither is visible to a reviewer reading `overlay/families.json`, which is why they are here.
  /**
   * canonicalModelId -> the provider ids that could actually SERVE it.
   *
   * `isSlotServableRow` is the SAME predicate `rowsForCanonicalId` uses — §4 step 1's own filter,
   * status AND endpoint. Fix round 1's I-3: these were two predicates, and the validator's (status
   * only) was the looser one, so a slot whose only rows were `endpoints: ["embeddings"]` validated
   * clean and resolved to nothing. One function, both call sites.
   */
  const serversByCanonicalId = new Map<string, Set<string>>();
  if (Array.isArray(models) && Array.isArray(families)) {
    for (const row of models) {
      if (!isRecord(row)) continue;
      const canonical = row["canonicalModelId"];
      const providerId = row["providerId"];
      if (typeof canonical !== "string" || canonical.length === 0) continue;
      // The row is raw JSON here; a malformed `status`/`endpoints` is already reported by
      // `checkModel`, and a row whose shape cannot be read is not one that can serve a slot.
      const endpoints = Array.isArray(row["endpoints"]) ? row["endpoints"].filter((e): e is string => typeof e === "string") : [];
      if (typeof row["status"] !== "string" || !isSlotServableRow({ status: row["status"], endpoints })) continue;
      const set = serversByCanonicalId.get(canonical) ?? new Set<string>();
      if (typeof providerId === "string" && providerId.length > 0) set.add(providerId);
      serversByCanonicalId.set(canonical, set);
    }

    for (let i = 0; i < models.length; i++) {
      const row = models[i];
      if (!isRecord(row)) continue;
      const family = row["modelFamily"];
      if (typeof family !== "string" || family.length === 0) continue; // already reported by checkModel
      if (family !== OTHER_FAMILY_ID && !familyIds.has(family)) {
        errs.add(`models[${i}].modelFamily`, `${JSON.stringify(family)} names no family in this catalog (and is not ${JSON.stringify(OTHER_FAMILY_ID)})`, "model-family-unknown");
      }
    }

    for (let i = 0; i < families.length; i++) {
      const row = families[i];
      if (!isRecord(row) || !Array.isArray(row["slots"])) continue;
      const slots = row["slots"] as unknown[];
      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s];
        if (!isRecord(slot)) continue;
        const canonical = slot["canonicalModelId"];
        if (typeof canonical !== "string" || canonical.length === 0) continue; // already reported
        const servers = serversByCanonicalId.get(canonical);
        if (servers === undefined) {
          errs.add(
            `families[${i}].slots[${s}].canonicalModelId`,
            `${JSON.stringify(canonical)} is on NO model row that could serve it (every row is missing, blocked, deprecated, or serves neither \`chat\` nor \`responses\`) — WS-13c §1: a slot never names a model the catalog does not ship`,
            "slot-model-missing",
          );
          continue;
        }
        const pinned = slot["provider"];
        if (typeof pinned === "string" && pinned.length > 0 && !servers.has(pinned)) {
          errs.add(
            `families[${i}].slots[${s}].provider`,
            `${JSON.stringify(pinned)} serves no row with canonicalModelId ${JSON.stringify(canonical)} (served by: ${[...servers].sort().join(", ") || "nobody"}) — a pin that cannot resolve is a slot that fails at turn time`,
            "slot-provider-unserving",
          );
        }
      }
    }
  }

  // `scanForSecrets` keeps its `string[]` signature (Lane X's generator runs it standalone over the
  // RAW extraction, where there is no `Errors` to hand it); its findings are already `${path}: ${…}`,
  // so the path is split back off rather than re-derived.
  for (const finding of scanForSecrets(json)) {
    const split = finding.indexOf(": ");
    errs.list.push({ code: "secret", path: split > 0 ? finding.slice(0, split) : "<root>", message: finding });
  }

  if (errs.list.length > 0) return { ok: false, errors: errs.list };
  return { ok: true, catalog: json as unknown as WinterCatalog };
}

// Re-exported for the generator/registry so nothing re-derives them from the type declarations.
export type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor };
