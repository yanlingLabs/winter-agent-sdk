// Anti-wiring pin for the guided guest ticket issuer. A TypeScript AST scan over EVERY script and source file under
// packages/** and scripts/** (.ts .tsx .mts .cts .js .mjs .cjs, no test or fixture exemption by file name): the only
// path that can claim the issuer or mint a ticket is the one documented export, `query()` only SPENDS a ticket, and
// the exact files that may claim are listed below. This is a tripwire for accidental or careless wiring, not a
// security boundary: see docs/guided-guest-attestation.md.
//
// KNOWN LIMITS of an AST tripwire (none is detected, none is claimed to be): `createRequire(import.meta.url)("...")`
// (a require call through another name), a script that shells out to `bun -e`/`node -e` or spawns another runtime, and
// `new Function(...)`/`eval` building code from strings. A run-time-built module specifier IS counted, but only where
// the call is literally `import(...)` or `require(...)`.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ATTESTATION = "packages/sdk/src/guided-guest-attestation.ts";
const QUERY = "packages/sdk/src/query.ts";
const OPTIONS = "packages/sdk/src/options.ts";
const INDEX = "packages/sdk/src/index.ts";
const ENTRIES = [INDEX, "packages/sdk/src/messaging/index.ts", "packages/sdk/src/tools/index.ts"];
const SDK_PACKAGE = "@yanlinglabs/winter-agent-sdk";
/** Built at run time so this file never contains the name as a literal: the scan below runs over this file too. */
const ISSUER = ["claim", "Guided", "Guest", "Issuer"].join("");
/** The EXACT files that may claim the issuer or import the module freely. Nothing is exempt by file name. */
const CLAIMERS = ["packages/sdk/src/guided-guest-attestation.test.ts", "packages/sdk/src/fixtures/guided-guest-ticket-capacity.ts"];
/** Per production importer of the attestation module: the exact names it may import (value or type). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  [QUERY]: ["retireGuidedGuestTicket", "spendGuidedGuestTicket"],
  [OPTIONS]: ["GuidedGuestTicket"],
  [INDEX]: [ISSUER, "GuidedGuestIssuer", "GuidedGuestMintRequest", "GuidedGuestTicket"],
};
/** Run-time-built module specifiers that exist today, per file, with their exact counts. Each could name any module. */
const COMPUTED_ALLOWED: Readonly<Record<string, number>> = {
  "packages/sdk/src/transport.ts": 1, "packages/conformance/src/official/capture.ts": 1, "scripts/verify-provider-live.ts": 1,
  "scripts/research/code-policy-compatibility.ts": 3, "scripts/record-frontmatter-bun-overlay.ts": 1,
};
const ATTESTATION_EXPORTS = [ISSUER, "retireGuidedGuestTicket", "spendGuidedGuestTicket", "GuidedGuestIssuer", "GuidedGuestMintRequest", "GuidedGuestTicket"];
/** Names that must never appear in a package entry. */
const INTERNAL_NAMES = ["spendGuidedGuestTicket", "retireGuidedGuestTicket", "bindGuidedGuestGuard", "assertGuidedQueryClaimActive", "forgetConsumedBindings", "GuidedGuestGuard"];
/** Preparation-module internals: who may import each (the claimers may import all). */
const INTERNAL_IMPORTERS: Readonly<Record<string, string>> = {
  bindGuidedGuestGuard: ATTESTATION, forgetConsumedBindings: ATTESTATION, assertGuidedQueryClaimActive: QUERY,
};
const CLOCKS = ["Date", "performance", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "hrtime", "nanoseconds", "requestAnimationFrame"];
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const COMPUTED = "<computed>";

const mentionsAttestation = (specifier: string) => /guided-guest-attestation/.test(specifier);
const mentionsPreparation = (specifier: string) => /guided-query-preparation/.test(specifier);
/** The package entry, by name or by a relative path that resolves to the SDK's source or built index. */
function isSdkEntry(specifier: string, path: string): boolean {
  if (specifier === SDK_PACKAGE) return true;
  if (!specifier.startsWith(".")) return false;
  // The source index and the BUILT index (packages/sdk/dist/index.js) are both the package entry.
  return /^packages\/sdk\/(?:src|dist)(\/index(\.[mc]?[jt]sx?)?)?$/.test(posix.normalize(posix.join(posix.dirname(path), specifier)));
}
const parsed = new Map<string, { text: string; file: ts.SourceFile }>();
function parse(path: string, text: string): ts.SourceFile {
  const cached = parsed.get(path);
  if (cached !== undefined && cached.text === text) return cached.file;
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  if (parsed.size >= 64) parsed.clear(); // Only the few hot files are re-parsed; never keep the whole tree's syntax trees.
  parsed.set(path, { text, file });
  return file;
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
/** The text of a literal specifier; anything built at run time is "<computed>". */
const literalText = (node: ts.Node | undefined): string =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : COMPUTED;

type Form = "named" | "namespace" | "default" | "star" | "dynamic";
interface Reference { specifier: string; names: string[]; form: Form; node: ts.Node }
/** Every way a module specifier reaches a file: static import/export, import(), require(), import-equals, import types. */
function references(file: ts.SourceFile): Reference[] {
  const found: Reference[] = [];
  // A file that declares its own `require` (an assertion helper, say) is not calling CommonJS require.
  let ownRequire = false;
  walk(file, node => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === "require") ownRequire = true;
  });
  walk(file, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause, bindings = clause?.namedBindings, specifier = node.moduleSpecifier.text;
      if (clause?.name !== undefined) found.push({ specifier, names: [clause.name.text], form: "default", node });
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) found.push({ specifier, names: [bindings.name.text], form: "namespace", node });
      else if (bindings !== undefined) found.push({ specifier, names: bindings.elements.map(item => (item.propertyName ?? item.name).text), form: "named", node });
      else if (clause === undefined) found.push({ specifier, names: [], form: "named", node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause, specifier = node.moduleSpecifier.text;
      if (clause === undefined || ts.isNamespaceExport(clause)) found.push({ specifier, names: [], form: "star", node });
      else found.push({ specifier, names: clause.elements.map(item => (item.propertyName ?? item.name).text), form: "named", node });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (!ownRequire && ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      found.push({ specifier: literalText(node.arguments[0]), names: [], form: "dynamic", node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push({ specifier: literalText(node.moduleReference.expression), names: [node.name.text], form: "dynamic", node });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      found.push({ specifier: literalText(node.argument.literal), names: [], form: "dynamic", node });
    }
  });
  return found;
}
function identifiers(file: ts.SourceFile, wanted: readonly string[]): { name: string; node: ts.Identifier }[] {
  const result: { name: string; node: ts.Identifier }[] = [];
  walk(file, node => { if (ts.isIdentifier(node) && wanted.includes(node.text)) result.push({ name: node.text, node }); });
  return result;
}

/** The expression a value flows through unchanged: await, parentheses, non-null, `as`, `satisfies`, type assertions. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent) || ts.isTypeAssertionExpression(current.parent))) current = current.parent;
  return current;
}
/** A property name on the SDK namespace that is neither the issuer nor a way to hand the namespace to other code. */
const harmlessKey = (name: string) => name !== ISSUER && name !== "then";
/** How a whole-module value (an `import()`/`require()` result) is used: only as `value.name`, `value["name"]` or a plain
 * destructuring of other names. Returns the identifier the value is bound to when it is bound whole, else null. */
function wholeModuleUse(node: ts.Node): { ok: true; bound?: string } | { ok: false; reason: string } {
  const current = outermost(node), parent = current.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === current) return harmlessKey(parent.name.text) ? { ok: true } : { ok: false, reason: `reads .${parent.name.text}` };
  if (ts.isElementAccessExpression(parent) && parent.expression === current) {
    const key = parent.argumentExpression;
    return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && harmlessKey(key.text) ? { ok: true } : { ok: false, reason: "reads a computed key" };
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
    if (ts.isIdentifier(parent.name)) return { ok: true, bound: parent.name.text };
    if (ts.isObjectBindingPattern(parent.name)) {
      const clean = parent.name.elements.every(element => element.dotDotDotToken === undefined
        && (element.propertyName === undefined || ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
        && harmlessKey(((element.propertyName ?? element.name) as ts.Identifier | ts.StringLiteral).text));
      return clean ? { ok: true } : { ok: false, reason: "destructures the issuer, a rest or a computed key" };
    }
  }
  return { ok: false, reason: "uses the whole module value" };
}
/** Every use of an identifier bound to the whole SDK module must be a harmless property read (or a type position). */
function namespaceUses(file: ts.SourceFile, name: string, declaration: ts.Node): string[] {
  const violations: string[] = [];
  walk(file, node => {
    if (!ts.isIdentifier(node) || node.text !== name || node === (declaration as { name?: ts.Node }).name || ts.isImportSpecifier(node.parent)) return;
    const use = outermost(node), parent = use.parent;
    if (ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isVariableDeclaration(parent) && parent.name === node) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === use) { if (!harmlessKey(parent.name.text)) violations.push(`reads .${parent.name.text}`); return; }
    if (ts.isElementAccessExpression(parent) && parent.expression === use) {
      const key = parent.argumentExpression;
      if (!((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && harmlessKey(key.text))) violations.push("reads a computed key");
      return;
    }
    violations.push("passes or stores the whole module value");
  });
  return violations;
}
/** The package entry is never taken whole: no star re-export, default import, escaping namespace or computed key. */
function entryRules(path: string, file: ts.SourceFile): string[] {
  const violations: string[] = [];
  for (const ref of references(file)) {
    if (!isSdkEntry(ref.specifier, path)) continue;
    if (ref.form === "star") violations.push(`${path}: re-exports the whole SDK entry`);
    else if (ref.form === "default") violations.push(`${path}: default-imports the SDK entry`);
    else if (ref.form === "namespace") {
      if (ts.isImportDeclaration(ref.node) && ref.node.importClause?.isTypeOnly === true) continue;
      for (const reason of namespaceUses(file, ref.names[0]!, ref.node)) violations.push(`${path}: SDK namespace ${reason}`);
    } else if (ref.form === "dynamic" && !ts.isImportTypeNode(ref.node)) {
      const use = ts.isImportEqualsDeclaration(ref.node) ? { ok: true as const, bound: ref.names[0] } : wholeModuleUse(ref.node);
      if (!use.ok) violations.push(`${path}: SDK entry loaded dynamically and ${use.reason}`);
      else if (use.bound !== undefined) for (const reason of namespaceUses(file, use.bound, ref.node.parent)) violations.push(`${path}: SDK namespace ${reason}`);
    }
  }
  return violations;
}

/** Scans a map of repository-relative POSIX path -> source text. Returns one line per violation. */
export function scan(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, text] of files) {
    if (CLAIMERS.includes(path)) continue;
    const source = parse(path, text), refs = references(source);
    // 1. Run-time-built specifiers could name any module, the attestation module included.
    const computed = refs.filter(item => item.specifier === COMPUTED).length;
    if (computed > (COMPUTED_ALLOWED[path] ?? 0)) violations.push(`${path}: computed module specifier cannot be proven not to reach the attestation module`);
    // 2. Who may import the attestation module, and with which names.
    for (const ref of refs.filter(item => mentionsAttestation(item.specifier))) {
      const allowed = ALLOWED[path];
      if (allowed === undefined) violations.push(`${path}: imports the attestation module and is not an allowed importer`);
      else if (ref.form !== "named") violations.push(`${path}: ${ref.form} import/export of the attestation module`);
      else for (const name of ref.names) if (!allowed.includes(name)) violations.push(`${path}: imports ${name} from the attestation module`);
    }
    // 3. The issuer claim: nothing names it, as an identifier or a string, except the declaration and the one package re-export.
    for (const { node } of identifiers(source, [ISSUER])) {
      const reexport = path === INDEX && ts.isExportSpecifier(node.parent);
      const declaration = path === ATTESTATION && ts.isFunctionDeclaration(node.parent);
      if (!reexport && !declaration) violations.push(`${path}: references ${ISSUER} outside its declaration and the single package export`);
    }
    walk(source, node => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === ISSUER && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent))
        violations.push(`${path}: names ${ISSUER} as a string`);
    });
    // 4. The package entry is never taken whole.
    violations.push(...entryRules(path, source));
    // 5. Internal names never leave the package entries; the preparation internals have one importer each.
    if (ENTRIES.includes(path)) for (const { name } of identifiers(source, INTERNAL_NAMES)) violations.push(`${path}: package entry names internal ${name}`);
    for (const ref of refs.filter(item => mentionsPreparation(item.specifier)))
      for (const [name, owner] of Object.entries(INTERNAL_IMPORTERS)) if (ref.names.includes(name) && path !== owner) violations.push(`${path}: imports ${name}`);
    if (path === ATTESTATION) violations.push(...attestationRules(source));
    if (path === QUERY) for (const { node } of identifiers(source, ["spendGuidedGuestTicket"])) {
      if (!ts.isCallExpression(node.parent) && !ts.isImportSpecifier(node.parent)) violations.push(`${path}: spendGuidedGuestTicket used other than by a direct call`);
    }
  }
  return violations;
}

/** The module itself: no clock, no class, no timer, one import, exactly the reviewed export list. */
function attestationRules(file: ts.SourceFile): string[] {
  const violations: string[] = [];
  const exported = new Set<string>();
  walk(file, node => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) violations.push(`${ATTESTATION}: declares a class`);
    if (ts.isNewExpression(node) && !(ts.isIdentifier(node.expression) && ["Error", "Map", "Set", "WeakMap"].includes(node.expression.text))) violations.push(`${ATTESTATION}: new ${node.expression.getText(file)}`);
    if (ts.isExportAssignment(node)) violations.push(`${ATTESTATION}: export default/assignment`);
  });
  for (const statement of file.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier !== undefined || statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) violations.push(`${ATTESTATION}: re-export or star export`);
      else for (const element of statement.exportClause.elements) exported.add(element.name.text);
    } else if (isExported) {
      if (ts.isVariableStatement(statement)) violations.push(`${ATTESTATION}: exports a variable`);
      else if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) { if (statement.name) exported.add(statement.name.text); }
      else violations.push(`${ATTESTATION}: exports a ${ts.SyntaxKind[statement.kind]}`);
    }
  }
  if ([...exported].sort().join() !== [...ATTESTATION_EXPORTS].sort().join()) violations.push(`${ATTESTATION}: export list is ${[...exported].sort().join(",")}`);
  for (const { name } of identifiers(file, CLOCKS)) violations.push(`${ATTESTATION}: clock or timer identifier ${name}`);
  const imports = references(file);
  if (imports.length !== 1 || imports[0]!.specifier !== "./guided-query-preparation.ts") violations.push(`${ATTESTATION}: imports ${imports.map(item => item.specifier).join(",")}`);
  return violations;
}

function loadProduction(root: string = ROOT): Map<string, string> {
  const files = new Map<string, string>();
  // Walk by hand. Only a PACKAGE ROOT's dist and node_modules are skipped (a recursive listing would follow them first);
  // a directory of either name anywhere deeper, such as src/dist, is source and is scanned.
  const skipped = (path: string) => /^(?:packages\/(?:[^/]+|platform\/[^/]+)|scripts)\/(?:dist|node_modules)$/.test(path);
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (!skipped(path)) visit(path); }
      else if (entry.isFile() && EXTENSIONS.test(entry.name) && !/\.d\.[mc]?ts$/.test(entry.name)) files.set(path, readFileSync(join(root, path), "utf8"));
    }
  };
  for (const root of ["packages", "scripts"]) visit(root);
  return files;
}
const real = loadProduction();
// Every rule is per file, so a negative control scans just the file it plants or edits.
const withFile = (path: string, text: string) => new Map([[path, text]]);
const replaced = (path: string, edit: (text: string) => string) => new Map([[path, edit(real.get(path)!)]]);

test("the real tree is clean: the issuer is reachable from exactly one package export and no production path claims or mints", () => {
  expect(real.has(ATTESTATION)).toBe(true); expect(real.has(QUERY)).toBe(true); expect(real.size).toBeGreaterThan(100);
  for (const claimer of CLAIMERS) expect(real.has(claimer)).toBe(true);
  expect(scan(real)).toEqual([]);
});
test("every script and source extension at any depth under packages and scripts is scanned; dependencies and builds are not entered", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-wiring-scan-"));
  try {
    const write = (path: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), "export {};\n"); };
    const scanned = ["packages/a/src/x.ts", "packages/a/src/x.tsx", "packages/a/src/x.mts", "packages/a/src/x.cts", "packages/a/bin/x.js", "packages/a/x.mjs", "packages/a/x.cjs", "scripts/deep/er/x.ts",
      "packages/a/src/dist/x.ts", "packages/a/src/deep/dist/x.mjs", "packages/a/src/node_modules/x.ts", "packages/platform/t/bin/x.js"];
    const ignored = ["packages/a/node_modules/dep/x.ts", "packages/a/dist/x.js", "packages/platform/t/dist/x.js", "packages/platform/t/node_modules/dep/x.js",
      "scripts/node_modules/dep/x.ts", "packages/a/src/x.d.ts", "packages/a/src/x.json", "packages/a/src/x.md"];
    for (const path of [...scanned, ...ignored]) write(path);
    expect([...loadProduction(root).keys()].sort()).toEqual([...scanned].sort());
    // End to end: a claim planted under a src/dist directory is found by the scan of what was loaded.
    writeFileSync(join(root, "packages/a/src/dist/claim.ts"), `import { ${ISSUER} } from "./guided-guest-attestation.ts"; ${ISSUER}();\n`);
    expect(scan(loadProduction(root)).some(line => /packages\/a\/src\/dist\/claim\.ts: imports the attestation module/.test(line))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect([...real.keys()].some(path => /\.mjs$/.test(path))).toBe(true); // The real tree has a script outside .ts.
  expect([...real.keys()].some(path => !/^packages\/[^/]+\/src\//.test(path))).toBe(true); // And files outside src.
});
test("only the exact claimer files name the issuer: the attestation suite, the capacity fixture, the declaration and the one export", () => {
  const namers = [...real].filter(([path, text]) => identifiers(parse(path, text), [ISSUER]).length > 0).map(([path]) => path).sort();
  expect(namers).toEqual([ATTESTATION, INDEX, ...CLAIMERS].sort());
});
test("the package entries export the issuer once and nothing internal", () => {
  const index = parse(INDEX, real.get(INDEX)!);
  const values: string[] = [], types: string[] = [];
  for (const statement of index.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !mentionsAttestation((statement.moduleSpecifier as ts.StringLiteral).text)) continue;
    const names = (statement.exportClause as ts.NamedExports).elements.map(element => element.name.text);
    (statement.isTypeOnly ? types : values).push(...names);
  }
  expect(values).toEqual([ISSUER]); expect(types.sort()).toEqual(["GuidedGuestIssuer", "GuidedGuestMintRequest", "GuidedGuestTicket"]);
  for (const entry of ENTRIES.slice(1)) expect(references(parse(entry, real.get(entry)!)).filter(item => mentionsAttestation(item.specifier))).toEqual([]);
});
test("the attestation module has no clock, no timer and no class, and exactly one dependency", () => {
  expect(attestationRules(parse(ATTESTATION, real.get(ATTESTATION)!))).toEqual([]);
});
test("query.ts spends and retires tickets and never mints, advances or claims", () => {
  const source = parse(QUERY, real.get(QUERY)!);
  const names = references(source).filter(item => mentionsAttestation(item.specifier)).flatMap(item => item.names).sort();
  expect(names).toEqual(["retireGuidedGuestTicket", "spendGuidedGuestTicket"]);
  expect(identifiers(source, [ISSUER, "mint", "advance", "revoke", "forget"]).filter(({ node }) => !ts.isPropertyAccessExpression(node.parent) || node.parent.name !== node)).toEqual([]);
});

// ---- negative controls: the pin itself must catch each wiring shape ------------------------------------------------

const claim = `${ISSUER}()`;
const sdkNamespace = `import * as sdk from "${SDK_PACKAGE}";\n`;
const rules: [string, Map<string, string>, RegExp][] = [
  ["a daemon file imports and claims the issuer", withFile("packages/sdk/src/daemon.ts", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; export const issuer = ${claim};`), /daemon\.ts: imports the attestation module/],
  ["a runtime package file claims through the package entry", withFile("packages/runtime/src/boot.ts", `import { ${ISSUER} } from "${SDK_PACKAGE}"; ${claim};`), /boot\.ts: references claimGuidedGuestIssuer/],
  ["a script requires the module", withFile("scripts/mint.ts", `const m = require("../packages/sdk/src/guided-guest-attestation.ts");`), /mint\.ts: imports the attestation module/],
  ["a dynamic import with a literal specifier", withFile("packages/sdk/src/late.ts", `export const load = () => import("./guided-guest-attestation.ts");`), /late\.ts: imports the attestation module/],
  ["a dynamic import with a computed specifier", withFile("packages/sdk/src/late.ts", `export const load = (name: string) => import(name);`), /computed module specifier/],
  ["a computed dynamic import in another package", withFile("packages/runtime/src/late.ts", `const p = ["../../sdk/src/guided-", "guest-attestation.ts"].join(""); export const m = import(p);`), /late\.ts: computed module specifier/],
  ["a template-literal dynamic import", withFile("packages/sdk/src/late.ts", "export const load = () => import(`./guided-guest-${'attestation'}.ts`);"), /late\.ts: computed module specifier/],
  ["an import type of the module", withFile("packages/sdk/src/late.ts", `export type T = import("./guided-guest-attestation.ts").GuidedGuestIssuer;`), /late\.ts: imports the attestation module/],
  ["a string-keyed lookup of the claim", withFile("packages/runtime/src/boot.ts", `export const claim = (sdk: any) => sdk["${ISSUER}"]();`), /boot\.ts: names claimGuidedGuestIssuer as a string/],
  ["a namespace import in an allowed importer", replaced(QUERY, text => `import * as attestation from "./guided-guest-attestation.ts";\n${text}`), /query\.ts: namespace import/],
  ["query.ts also imports the issuer claim", replaced(QUERY, text => text.replace("{ retireGuidedGuestTicket, spendGuidedGuestTicket }", `{ retireGuidedGuestTicket, spendGuidedGuestTicket, ${ISSUER} }`)), /query\.ts: imports claimGuidedGuestIssuer/],
  ["the package entry star-exports the module", replaced(INDEX, text => `${text}\nexport * from "./guided-guest-attestation.ts";`), /index\.ts: (star import\/export|namespace|star)/],
  ["the package entry exports an internal spender", replaced(INDEX, text => text.replace(`export { ${ISSUER} }`, `export { ${ISSUER}, spendGuidedGuestTicket }`)), /index\.ts: imports spendGuidedGuestTicket/],
  ["a package entry names the internal guard type", replaced("packages/sdk/src/tools/index.ts", text => `${text}\nexport type Leak = import("../guided-query-preparation.ts").GuidedGuestGuard;`), /tools\/index\.ts: package entry names internal GuidedGuestGuard/],
  ["the messaging entry re-exports the issuer", replaced("packages/sdk/src/messaging/index.ts", text => `${text}\nexport { ${ISSUER} } from "../guided-guest-attestation.ts";`), /messaging\/index\.ts: imports the attestation module/],
  ["the module reads a clock", replaced(ATTESTATION, text => `${text}\nexport const stamp = Date.now();`), /clock or timer identifier Date/],
  ["the module sets a timer", replaced(ATTESTATION, text => text.replace("const fail =", "const expire = () => setTimeout(() => {}, 1);\nconst fail =")), /clock or timer identifier setTimeout/],
  ["the module exports a class", replaced(ATTESTATION, text => `${text}\nexport class GuestTicket {}`), /declares a class|exports a ClassDeclaration/],
  ["the module exports its mint", replaced(ATTESTATION, text => `${text}\nexport { mint };`), /export list is/],
  ["the module gains a dependency", replaced(ATTESTATION, text => `import { randomUUID } from "node:crypto";\n${text}`), /imports node:crypto,|imports \.\/guided-query-preparation\.ts,node:crypto/],
  ["another file imports the guard binder", withFile("packages/sdk/src/forge.ts", `import { bindGuidedGuestGuard } from "./guided-query-preparation.ts";`), /forge\.ts: imports bindGuidedGuestGuard/],
  ["another file imports the consumed-id eviction", withFile("packages/sdk/src/forge.ts", `import { forgetConsumedBindings } from "./guided-query-preparation.ts";`), /forge\.ts: imports forgetConsumedBindings/],
  ["another file imports the claim-active assert", withFile("packages/sdk/src/forge.ts", `import { assertGuidedQueryClaimActive } from "./guided-query-preparation.ts";`), /forge\.ts: imports assertGuidedQueryClaimActive/],
  ["a production file hides behind a fixture-like name", withFile("packages/sdk/src/fixtures/claim.ts", `import { ${ISSUER} } from "../guided-guest-attestation.ts"; ${claim};`), /fixtures\/claim\.ts: imports the attestation module/],
  ["a file named like a fixture claims", withFile("packages/sdk/src/boot.fixture.ts", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; export const c = ${claim};`), /boot\.fixture\.ts: imports the attestation module/],
  ["a test-named file claims", withFile("packages/runtime/src/other.test.ts", `import { ${ISSUER} } from "${SDK_PACKAGE}"; ${claim};`), /other\.test\.ts: references claimGuidedGuestIssuer/],
  ["a .mjs file claims through a relative import", withFile("packages/sdk/src/zz.mjs", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; export const c = ${claim};`), /zz\.mjs: imports the attestation module/],
  ["a .tsx file claims through a relative import", withFile("packages/sdk/src/zz.tsx", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; export const c = ${claim};`), /zz\.tsx: imports the attestation module/],
  ["a file outside src claims through the package entry", withFile("packages/sdk/bin/zz.ts", `import { ${ISSUER} } from "${SDK_PACKAGE}"; export const c = ${claim};`), /bin\/zz\.ts: references claimGuidedGuestIssuer/],
  ["a string-concatenated key on the SDK namespace", withFile("packages/runtime/src/zz.ts", `${sdkNamespace}export const c = (sdk as any)["claimGuided" + "GuestIssuer"]();`), /SDK namespace reads a computed key/],
  ["a template key on the SDK namespace", withFile("packages/runtime/src/zz.ts", `${sdkNamespace}const k = \`claim\${"Guided"}GuestIssuer\`;\nexport const c = (sdk as any)[k]();`), /SDK namespace reads a computed key/],
  ["enumerating the SDK namespace", withFile("packages/runtime/src/zz.ts", `${sdkNamespace}export const c = (Object.entries(sdk).find(([n]) => /Issuer$/.test(n))![1] as any)();`), /SDK namespace passes or stores the whole module value/],
  ["destructuring the SDK namespace", withFile("packages/runtime/src/zz.ts", `${sdkNamespace}const { ${ISSUER}: c } = sdk;\nexport const i = c();`), /SDK namespace passes or stores the whole module value/],
  ["storing the SDK namespace", withFile("packages/runtime/src/zz.ts", `${sdkNamespace}export const alias = sdk;`), /SDK namespace passes or stores the whole module value/],
  ["a star re-export of the SDK entry", withFile("packages/runtime/src/zz.ts", `export * from "${SDK_PACKAGE}";`), /re-exports the whole SDK entry/],
  ["a star re-export of the SDK index by relative path", withFile("packages/runtime/src/zz.ts", `export * from "../../sdk/src/index.ts";`), /re-exports the whole SDK entry/],
  ["a star re-export of the BUILT SDK index", withFile("packages/runtime/src/zz.ts", `export * from "../../sdk/dist/index.js";`), /re-exports the whole SDK entry/],
  ["a star re-export of the built SDK directory", withFile("packages/runtime/src/zz.ts", `export * from "../../sdk/dist";`), /re-exports the whole SDK entry/],
  ["enumerating a namespace import of the BUILT SDK index", withFile("packages/runtime/src/zz.ts", `import * as built from "../../sdk/dist/index.js";\nexport const names = Object.keys(built);`), /SDK namespace passes or stores the whole module value/],
  ["a computed key on the BUILT SDK index", withFile("packages/runtime/src/zz.mjs", `import * as built from "../../sdk/dist/index.js";\nexport const c = built["claimGuided" + "GuestIssuer"]();`), /SDK namespace reads a computed key/],
  ["a dynamic import of the BUILT SDK index kept whole", withFile("packages/runtime/src/zz.ts", `export const load = async () => { const built = await import("../../sdk/dist/index.js"); return built; };`), /SDK namespace passes or stores the whole module value/],
  ["a named import of the claim from the BUILT SDK index", withFile("packages/runtime/src/zz.ts", `import { ${ISSUER} } from "../../sdk/dist/index.js"; ${claim};`), /references claimGuidedGuestIssuer/],
  ["a dynamic import of the SDK entry kept whole", withFile("packages/runtime/src/zz.ts", `export const load = async () => { const sdk = await import("${SDK_PACKAGE}"); return Object.keys(sdk); };`), /SDK namespace passes or stores the whole module value/],
  ["a dynamic import of the SDK entry through then", withFile("packages/runtime/src/zz.ts", `export const load = () => import("${SDK_PACKAGE}").then(sdk => sdk);`), /SDK entry loaded dynamically and reads \.then/],
  ["a bare dynamic import of the SDK entry", withFile("packages/runtime/src/zz.ts", `export const load = () => import("${SDK_PACKAGE}");`), /SDK entry loaded dynamically and uses the whole module value/],
  ["a require of the SDK entry kept whole", withFile("packages/runtime/src/zz.js", `const sdk = require("${SDK_PACKAGE}");\nmodule.exports = Object.assign({}, sdk);`), /SDK namespace passes or stores the whole module value/],
  ["a dynamic import destructuring a rest", withFile("packages/runtime/src/zz.ts", `export const load = async () => { const { query, ...rest } = await import("${SDK_PACKAGE}"); return rest; };`), /SDK entry loaded dynamically and destructures the issuer, a rest or a computed key/],
];
for (const [name, files, expected] of rules) {
  test(`pin catches: ${name}`, () => {
    const violations = scan(files);
    expect(violations.some(line => expected.test(line))).toBe(true);
  });
}
test("pin negative control: harmless uses of the SDK entry are not flagged", () => {
  expect(scan(withFile("packages/runtime/src/ok.ts", `${sdkNamespace}export const q = sdk.query; export const s = sdk["splitFrames"];\nexport const t = (await import("${SDK_PACKAGE}")).compatibilityKeys;\nconst { addMarketplace } = await import("${SDK_PACKAGE}");\nexport type Q = typeof sdk.query;`))).toEqual([]);
});
test("pin negative control: the exact claimers may claim and import freely, nothing else is exempt", () => {
  const plant = `import { ${ISSUER} } from "./guided-guest-attestation.ts"; ${claim};`;
  expect(scan(withFile(CLAIMERS[0]!, plant))).toEqual([]);
  expect(scan(withFile("packages/sdk/src/guided-guest-attestation-wiring.test.ts", plant)).length).toBeGreaterThan(0);
});
