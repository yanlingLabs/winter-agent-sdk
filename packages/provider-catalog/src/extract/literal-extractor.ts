// The restricted TypeScript-AST literal extractor (WS-13 §3 step 3).
//
// THE ONE RULE: no upstream code executes in a trusted process. This module never imports, loads,
// evaluates, or `eval`s an upstream module — it hands the file's TEXT to the TypeScript compiler's
// parser and walks the resulting syntax tree. `typescript` is used purely as a parser; no program,
// no type checker, no module resolution, no transpilation.
//
// WHAT IS ACCEPTED is a deliberately tiny, reviewable set of inert literal forms:
//
//   string / number / boolean / null literals, template literals with NO substitutions, array and
//   object literals, `as const` / `satisfies` / parenthesised wrappers, unary minus on a number,
//   and a reference (or spread) to another accepted literal declared in an ALLOWLISTED, materialized
//   file.
//
// EVERYTHING ELSE IS REJECTED into the ledger with a reason and an exclusion class — functions and
// arrow functions, call expressions (`Object.freeze(...)`, `resolvePublicCred(...)`,
// `getAnthropicCompatHeaders()`), `new`, template literals with substitutions, conditionals, binary
// expressions, property access, computed keys, `process.env` reads, and every value under a field
// name that carries credential or identity material.
//
// Rejecting `Object.freeze([...])` is not an oversight. A call expression whose callee happens to be
// inert today is still a call expression, and "accept calls when the name looks safe" is a rule that
// decays the first time upstream renames a helper. The cost is visible and bounded: a handful of
// `unsupportedParams` arrays land in the rejection ledger instead of the catalog, where a reviewer
// can see exactly what was dropped and the overlay can carry the fact with real evidence.
//
// Node-portable (sdk fence): `typescript` and nothing else.

import ts from "typescript";

export type LiteralValue = string | number | boolean | null | LiteralValue[] | { [key: string]: LiteralValue };

/**
 * Why something did not reach the catalog. The FIELD/VALUE classes are this module's; the CATEGORY
 * and CURATION classes are `ledgers.ts`'s, and both live in one union so the committed ledger has a
 * single closed vocabulary a reviewer can diff across upstream bumps.
 */
export type ExclusionClass =
  // --- value-shape classes (this module) ---
  | "executable-value"
  | "dynamic-expression"
  | "env-read"
  | "identity-header"
  | "url-builder"
  | "credential-material"
  | "unresolved-reference"
  | "unsupported-shape"
  // --- category dispositions (WS-13 §1's table) ---
  | "category-no-auth"
  | "category-oauth"
  | "category-web-cookie"
  | "category-search"
  | "category-audio"
  | "category-upstream-proxy"
  | "category-cloud-agent"
  | "category-system"
  | "category-local-live-discovery"
  // --- curation / representability ---
  | "not-allowlisted"
  | "no-registry-entry"
  | "duplicate-id"
  | "unrepresentable-protocol"
  /**
   * NOT an exclusion. A row that DID reach the catalog, carrying a reviewed, recorded deviation from
   * what the pinned tree literally says (a corrected wire id, an adapter the protocol does not imply,
   * a per-row status). It shares the ledger with the exclusions because the ledger's job is "every
   * place the catalog and its source differ, with the reason" — and filing a deliberate normalization
   * under `unrepresentable-protocol` made the ledger's own counts lie about what was dropped.
   */
  | "reviewed-normalization"
  /** A row excluded because it is not a language model at all (WS-13 §4: `tts`/`stt`/media rows never feed the worker-model picker). */
  | "out-of-scope";

export interface Rejection {
  scope: "module" | "provider" | "model" | "field";
  /** The upstream provider id this rejection belongs to, or `""` for a module-level one. */
  upstreamId: string;
  /** Dotted location inside the module, e.g. `geminiProvider.oauth`. */
  path: string;
  sourcePath: string;
  reason: string;
  exclusionClass: ExclusionClass;
}

/**
 * Field names whose VALUE is rejected on sight, whatever its shape.
 *
 * Defence in depth, and the reason it sits here rather than in the mapper: WS-13 §5's "never import
 * secret defaults, OAuth client secrets, cookies, runtime environment values, or identity-mirroring
 * headers" is a rule about what may be READ, not merely about what may be written out. A credential
 * that never enters the raw extraction cannot leak from it — including into a debug dump of the
 * intermediate value, which no output-side scan would ever see.
 */
const REJECTED_FIELD_NAMES: ReadonlyArray<{ name: string; exclusionClass: ExclusionClass; reason: string }> = [
  { name: "oauth", exclusionClass: "credential-material", reason: "OAuth client id/secret defaults and their env names — WS-13 §5/§6: never imported, and Winter's OAuth providers are Winter-owned rows" },
  { name: "anonymousApiKey", exclusionClass: "credential-material", reason: "a literal API key used as an anonymous bearer token — a secret default, categorically excluded" },
  { name: "headers", exclusionClass: "identity-header", reason: "provider request headers carry client-identity mirroring (vendor CLI user-agents, beta flags, stainless versions) — WS-13 §5: never imported; Winter adapters author their own" },
  { name: "extraHeaders", exclusionClass: "identity-header", reason: "as `headers` — identity-mirroring request headers are never imported" },
  { name: "defaultHeaders", exclusionClass: "identity-header", reason: "as `headers` — identity-mirroring request headers are never imported" },
  { name: "urlBuilder", exclusionClass: "url-builder", reason: "an executable URL builder — WS-13 §13's security floor states the rule as \"no executable upstream URL builders\"" },
  { name: "poolConfig", exclusionClass: "unsupported-shape", reason: "opaque upstream session-pool runtime configuration; no Winter descriptor field, and it is not inert catalog data" },
  { name: "requestDefaults", exclusionClass: "unsupported-shape", reason: "upstream request-shaping defaults are executor behaviour, not catalog facts — Winter adapters own request serialization (WS-13 §5)" },
];

const REJECTED_FIELD_BY_NAME = new Map(REJECTED_FIELD_NAMES.map((f) => [f.name, f]));

export interface ExtractOptions {
  /**
   * Exported literals from other ALLOWLISTED modules, keyed `<sourcePath>#<exportName>` and
   * `#<exportName>` (the latter is the "any allowlisted module" fallback used when an import
   * specifier resolves to a materialized file whose own exports are already known).
   */
  externals?: ReadonlyMap<string, LiteralValue>;
  /** Every repository-relative path that was materialized, so an out-of-allowlist import is visible. */
  materializedPaths?: ReadonlySet<string>;
}

export interface ModuleLiterals {
  sourcePath: string;
  /** Top-level `const` bindings whose initializer was fully accepted. */
  values: Map<string, LiteralValue>;
  rejections: Rejection[];
  /** Import specifiers naming a module outside the materialized allowlist. */
  outOfAllowlistImports: string[];
  /** Imported name -> the module specifier it came from, for `unresolved-reference` reasons. */
  importOrigins: Map<string, string>;
}

/**
 * Resolve a relative import specifier against a repository-relative source path.
 *
 * Upstream mixes explicit `./shared.ts` specifiers with extensionless `./gateways` ones, so an
 * `exists` predicate is consulted for the two implicit spellings. Without it every extensionless
 * import inside the allowlist reads as OUT of the allowlist — a false boundary alarm that would
 * bury the real ones.
 */
export function resolveRelativeSpecifier(sourcePath: string, specifier: string, exists?: (path: string) => boolean): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const segments = sourcePath.split("/");
  segments.pop();
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const base = segments.join("/");
  if (exists === undefined || exists(base)) return base;
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (exists(candidate)) return candidate;
  }
  return base;
}

const MAX_DEPTH = 32;

/**
 * Parse one module and extract its accepted top-level literal bindings.
 *
 * Never throws on hostile input: a syntactically broken file yields no values and a module-scope
 * rejection. Depth-bounded so a pathological nesting cannot overflow the stack.
 */
export function extractModuleLiterals(sourcePath: string, text: string, options: ExtractOptions = {}): ModuleLiterals {
  const values = new Map<string, LiteralValue>();
  const rejections: Rejection[] = [];
  const outOfAllowlistImports: string[] = [];
  const importOrigins = new Map<string, string>();
  const externals = options.externals ?? new Map<string, LiteralValue>();
  const materialized = options.materializedPaths;

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ES2022, /*setParentNodes*/ false, ts.ScriptKind.TS);
  } catch (error) {
    rejections.push({
      scope: "module",
      upstreamId: "",
      path: "<module>",
      sourcePath,
      reason: `could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      exclusionClass: "unsupported-shape",
    });
    return { sourcePath, values, rejections, outOfAllowlistImports, importOrigins };
  }

  const reject = (path: string, reason: string, exclusionClass: ExclusionClass, scope: Rejection["scope"] = "field"): void => {
    rejections.push({ scope, upstreamId: "", path, sourcePath, reason, exclusionClass });
  };

  /** Strip the wrappers that carry no runtime value: `as const`, `satisfies T`, `(x)`, `<T>x`. */
  function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    for (;;) {
      if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      return current;
    }
  }

  function describeCallee(node: ts.CallExpression): string {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) return `${expr.text}(…)`;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) return `${expr.expression.text}.${expr.name.text}(…)`;
    return "a call expression";
  }

  function resolveIdentifier(name: string, path: string): LiteralValue | undefined {
    const local = values.get(name);
    if (local !== undefined) return local;
    const origin = importOrigins.get(name);
    if (origin !== undefined) {
      const resolved = resolveRelativeSpecifier(sourcePath, origin, materialized === undefined ? undefined : (path) => materialized.has(path));
      if (resolved !== undefined) {
        const keyed = externals.get(`${resolved}#${name}`);
        if (keyed !== undefined) return keyed;
      }
      const anywhere = externals.get(`#${name}`);
      if (anywhere !== undefined) return anywhere;
      const insideBoundary = resolved !== undefined && (materialized === undefined || materialized.has(resolved));
      reject(
        path,
        insideBoundary
          ? `references \`${name}\` from ${JSON.stringify(origin)}, which IS materialized — but that binding was itself rejected there, so no accepted literal exists to resolve to`
          : `references \`${name}\`, imported from ${JSON.stringify(origin)} — a module outside the materialized allowlist, so the value cannot be resolved without widening the source boundary`,
        "unresolved-reference",
      );
      return undefined;
    }
    const anywhere = externals.get(`#${name}`);
    if (anywhere !== undefined) return anywhere;
    reject(path, `references \`${name}\`, which is not an accepted literal declared in any materialized allowlisted file`, "unresolved-reference");
    return undefined;
  }

  /** The accepted-forms walker. Returns `undefined` for a rejected value (the caller drops it). */
  function literalOf(raw: ts.Expression, path: string, depth: number): LiteralValue | undefined {
    if (depth > MAX_DEPTH) {
      reject(path, `nested deeper than ${MAX_DEPTH} levels — refusing to walk further`, "unsupported-shape");
      return undefined;
    }
    const node = unwrap(raw);

    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) {
      // `node.text` is the scanner's normalized form, so numeric separators (`1_000_000`) are
      // already gone. Guarded anyway: a value the parser hands back as non-finite is a rejection,
      // never a silent NaN in a descriptor.
      const value = Number(node.text);
      if (!Number.isFinite(value)) {
        reject(path, `numeric literal ${JSON.stringify(node.text)} is not a finite number`, "unsupported-shape");
        return undefined;
      }
      return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const inner = literalOf(node.operand, path, depth + 1);
      if (typeof inner === "number") return -inner;
      reject(path, "unary minus applied to something other than a numeric literal", "dynamic-expression");
      return undefined;
    }

    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") {
        reject(path, "`undefined` is not a catalog value — a fact Winter does not have is recorded by OMITTING the key", "unsupported-shape");
        return undefined;
      }
      return resolveIdentifier(node.text, path);
    }

    if (ts.isArrayLiteralExpression(node)) {
      const out: LiteralValue[] = [];
      node.elements.forEach((element, index) => {
        const elementPath = `${path}[${index}]`;
        if (ts.isSpreadElement(element)) {
          const spread = literalOf(element.expression, `${elementPath} (spread)`, depth + 1);
          if (Array.isArray(spread)) out.push(...spread);
          else if (spread !== undefined) reject(`${elementPath} (spread)`, "spread of a non-array value into an array literal", "unsupported-shape");
          return;
        }
        if (element.kind === ts.SyntaxKind.OmittedExpression) {
          reject(elementPath, "array holes are not an accepted literal form", "unsupported-shape");
          return;
        }
        const value = literalOf(element, elementPath, depth + 1);
        if (value !== undefined) out.push(value);
      });
      return out;
    }

    if (ts.isObjectLiteralExpression(node)) {
      const out: { [key: string]: LiteralValue } = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = literalOf(property.expression, `${path}.…(spread)`, depth + 1);
          if (spread !== null && typeof spread === "object" && !Array.isArray(spread)) Object.assign(out, spread);
          else if (spread !== undefined) reject(`${path}.…(spread)`, "spread of a non-object value into an object literal", "unsupported-shape");
          continue;
        }
        if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          const name = property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : "<computed>";
          reject(`${path}.${name}`, "an object method/accessor is executable, not inert data", "executable-value");
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const value = resolveIdentifier(property.name.text, `${path}.${property.name.text}`);
          if (value !== undefined) out[property.name.text] = value;
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          // Unreachable against today's TypeScript AST (every `ObjectLiteralElementLike` variant is
          // handled above, which is why the compiler narrows `property` to `never` here) — kept as a
          // fail-closed guard for a future AST that grows a new member kind.
          reject(path, "unsupported object member kind", "unsupported-shape");
          continue;
        }
        const nameNode = property.name;
        let key: string;
        if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) key = nameNode.text;
        else if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) key = nameNode.text;
        else {
          reject(path, "a computed property key is a dynamic expression, not inert data", "dynamic-expression");
          continue;
        }
        const banned = REJECTED_FIELD_BY_NAME.get(key);
        if (banned !== undefined) {
          reject(`${path}.${key}`, banned.reason, banned.exclusionClass);
          continue;
        }
        const value = literalOf(property.initializer, `${path}.${key}`, depth + 1);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }

    // --- everything below is a REJECTION, classified so the ledger is diffable ------------------
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      reject(path, "an inline function — no executable upstream value is ever extracted (WS-13 §3: no upstream code runs in a trusted process)", "executable-value");
      return undefined;
    }
    if (ts.isCallExpression(node)) {
      reject(path, `the value is ${describeCallee(node)} — a call expression is never evaluated, so its result cannot be extracted`, "executable-value");
      return undefined;
    }
    if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      reject(path, "a constructor/tagged-template invocation is executable, not inert data", "executable-value");
      return undefined;
    }
    if (ts.isTemplateExpression(node)) {
      reject(path, "a template literal WITH substitutions is a dynamic expression — only substitution-free templates are accepted", "dynamic-expression");
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const text = node.getText(source);
      if (/^(?:process\.env|import\.meta\.env|Bun\.env)\b/.test(text)) {
        reject(path, `reads the runtime environment (${text}) — WS-13 §5: runtime environment values are never imported`, "env-read");
        return undefined;
      }
      reject(path, `a property access (${text}) is resolved at runtime, not a literal`, "dynamic-expression");
      return undefined;
    }
    reject(path, `unsupported expression of kind ${ts.SyntaxKind[node.kind]} — only inert literal forms are accepted`, "unsupported-shape");
    return undefined;
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifierNode = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifierNode)) continue;
      const specifier = specifierNode.text;
      const resolved = resolveRelativeSpecifier(sourcePath, specifier, materialized === undefined ? undefined : (path) => materialized.has(path));
      if (resolved === undefined || (materialized !== undefined && !materialized.has(resolved))) {
        if (!outOfAllowlistImports.includes(specifier)) outOfAllowlistImports.push(specifier);
      }
      const clause = statement.importClause;
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly || clause.isTypeOnly) continue;
          importOrigins.set(element.name.text, specifier);
        }
      }
      if (clause?.name !== undefined && !clause.isTypeOnly) importOrigins.set(clause.name.text, specifier);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (declaration.initializer === undefined) continue;
      const value = literalOf(declaration.initializer, name, 0);
      if (value !== undefined) values.set(name, value);
    }
  }

  return { sourcePath, values, rejections, outOfAllowlistImports, importOrigins };
}

/** How many times `extractAll` may re-walk the set before declaring the resolution stuck. */
const MAX_RESOLUTION_PASSES = 8;

/**
 * Extract a whole materialized set, resolving cross-module identifier references between
 * ALLOWLISTED files only.
 *
 * ITERATES TO A FIXPOINT rather than running a fixed number of passes, because upstream's import
 * graph is neither topologically ordered nor shallow. The real chain at the pin is three deep and
 * runs BACKWARDS against filename order:
 *
 *     open-sse/config/providers/index.ts          (REGISTRY -> each provider identifier)
 *       <- registry/openai/index.ts               (a model spreads GPT_5_6_API_CAPABILITIES)
 *         <- shared.ts                            (where that constant is declared)
 *
 * `index.ts` sorts FIRST and `shared.ts` LAST, so a two-pass version resolved the leaf entries but
 * handed `index.ts` the stale first-pass copies — and the whole GPT-5.6 family silently lost its
 * context window, modalities and Responses endpoint while every row still looked plausible. A
 * fixpoint has no such off-by-one: it stops when a pass adds nothing, and the pass budget exists
 * only so a pathological graph terminates rather than looping.
 *
 * Values accumulate into ONE map that later files in the SAME pass can already read, so a forward
 * dependency costs no extra pass at all.
 */
export function extractAll(files: ReadonlyArray<{ path: string; text: string }>): {
  modules: Map<string, ModuleLiterals>;
  exports: Map<string, LiteralValue>;
  passes: number;
} {
  const materializedPaths = new Set(files.map((f) => f.path));
  const exports = new Map<string, LiteralValue>();
  let modules = new Map<string, ModuleLiterals>();
  let passes = 0;
  let previous = "";

  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass++) {
    passes = pass + 1;
    modules = new Map<string, ModuleLiterals>();
    for (const file of files) {
      const module = extractModuleLiterals(file.path, file.text, { externals: exports, materializedPaths });
      modules.set(file.path, module);
      for (const [name, value] of module.values) {
        // Unconditional, so a later pass's better-resolved value REPLACES an earlier partial one.
        // The path-qualified key is what a resolvable import uses; the bare `#name` fallback is
        // consulted only when a specifier did not resolve to a materialized path, and it is
        // last-writer-wins in a deterministic file order.
        exports.set(`${file.path}#${name}`, value);
        exports.set(`#${name}`, value);
      }
    }
    // Compare the whole extracted state, not just the map size: a pass that REPLACES a partial value
    // with a complete one adds no keys, and stopping on size alone would freeze exactly the
    // half-resolved rows this loop exists to finish.
    const snapshot = JSON.stringify([...modules].map(([path, m]) => [path, [...m.values]]));
    if (snapshot === previous) break;
    previous = snapshot;
  }

  return { modules, exports, passes };
}
