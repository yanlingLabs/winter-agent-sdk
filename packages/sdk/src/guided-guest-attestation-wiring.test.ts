// Anti-wiring pin for the guided guest ticket issuer. A TypeScript AST scan over every production source: the only
// production path that can claim the issuer or mint a ticket is the one documented export, and `query()` only SPENDS
// a ticket. Tests (and one capacity fixture) are the only code that claims. This is a tripwire for accidental or
// careless wiring, not a security boundary: see docs/guided-guest-attestation.md.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ATTESTATION = "packages/sdk/src/guided-guest-attestation.ts";
const PREPARATION = "packages/sdk/src/guided-query-preparation.ts";
const QUERY = "packages/sdk/src/query.ts";
const OPTIONS = "packages/sdk/src/options.ts";
const ENTRIES = ["packages/sdk/src/index.ts", "packages/sdk/src/messaging/index.ts", "packages/sdk/src/tools/index.ts"];
const ISSUER = "claimGuidedGuestIssuer";
/** Test and fixture code: the only files allowed to claim the issuer. Everything else is production. */
const CAPACITY_FIXTURE = "packages/sdk/src/fixtures/guided-guest-ticket-capacity.ts";
const isTestCode = (path: string) => /\.(test|test-support|fixture)\.ts$/.test(path) || path === CAPACITY_FIXTURE;
/** Per production importer of the attestation module: the exact names it may import (value or type). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  [QUERY]: ["retireGuidedGuestTicket", "spendGuidedGuestTicket"],
  [OPTIONS]: ["GuidedGuestTicket"],
  "packages/sdk/src/index.ts": [ISSUER, "GuidedGuestIssuer", "GuidedGuestMintRequest", "GuidedGuestTicket"],
};
/** The only run-time-built specifier in the owning package today: transport.ts reads a platform package.json. */
const COMPUTED_ALLOWED: Readonly<Record<string, number>> = { "packages/sdk/src/transport.ts": 1 };
const ATTESTATION_EXPORTS = [ISSUER, "retireGuidedGuestTicket", "spendGuidedGuestTicket", "GuidedGuestIssuer", "GuidedGuestMintRequest", "GuidedGuestTicket"];
const INTERNAL_NAMES = ["spendGuidedGuestTicket", "retireGuidedGuestTicket", "bindGuidedGuestGuard", "assertGuidedQueryClaimActive", "GuidedGuestGuard"];
const CLOCKS = ["Date", "performance", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "hrtime", "nanoseconds", "requestAnimationFrame"];

const mentionsAttestation = (specifier: string) => /guided-guest-attestation/.test(specifier);
const mentionsPreparation = (specifier: string) => /guided-query-preparation/.test(specifier);
const parsed = new Map<string, { text: string; file: ts.SourceFile }>();
function parse(path: string, text: string): ts.SourceFile {
  const cached = parsed.get(path);
  if (cached !== undefined && cached.text === text) return cached.file;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  parsed.set(path, { text, file });
  return file;
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
/** The text of a literal specifier; anything built at run time is "<computed>". */
const literalText = (node: ts.Node | undefined): string =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : COMPUTED;
const COMPUTED = "<computed>";

/** Every way a module specifier reaches a file: static import/export, import(), require(), import-equals, import types. */
function references(file: ts.SourceFile): { specifier: string; names: string[]; form: "named" | "namespace" | "default" | "star" | "dynamic" }[] {
  const found: { specifier: string; names: string[]; form: "named" | "namespace" | "default" | "star" | "dynamic" }[] = [];
  walk(file, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause, bindings = clause?.namedBindings;
      if (clause?.name !== undefined) found.push({ specifier: node.moduleSpecifier.text, names: [clause.name.text], form: "default" });
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) found.push({ specifier: node.moduleSpecifier.text, names: [bindings.name.text], form: "namespace" });
      else if (bindings !== undefined) found.push({ specifier: node.moduleSpecifier.text, names: bindings.elements.map(item => (item.propertyName ?? item.name).text), form: "named" });
      else if (clause === undefined) found.push({ specifier: node.moduleSpecifier.text, names: [], form: "named" });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) found.push({ specifier: node.moduleSpecifier.text, names: [], form: "star" });
      else found.push({ specifier: node.moduleSpecifier.text, names: clause.elements.map(item => (item.propertyName ?? item.name).text), form: "named" });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      found.push({ specifier: literalText(node.arguments[0]), names: [], form: "dynamic" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push({ specifier: literalText(node.moduleReference.expression), names: [], form: "dynamic" });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      found.push({ specifier: literalText(node.argument.literal), names: [], form: "dynamic" });
    }
  });
  return found;
}
function identifiers(file: ts.SourceFile, wanted: readonly string[]): { name: string; node: ts.Identifier }[] {
  const result: { name: string; node: ts.Identifier }[] = [];
  walk(file, node => { if (ts.isIdentifier(node) && wanted.includes(node.text)) result.push({ name: node.text, node }); });
  return result;
}

/** Scans a map of repository-relative POSIX path -> source text. Returns one line per violation. */
export function scan(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, text] of files) {
    const source = parse(path, text), test = isTestCode(path);
    const refs = references(source);
    // 1. Who may import the attestation module, and with which names. Inside the owning package a specifier built at
    // run time could reach it by relative path, so it is refused there; other packages can only use the package entry.
    const computed = refs.filter(item => item.specifier === COMPUTED).length;
    if (!test && path.startsWith("packages/sdk/src/") && computed > (COMPUTED_ALLOWED[path] ?? 0)) violations.push(`${path}: computed module specifier cannot be proven not to reach the attestation module`);
    for (const ref of refs.filter(item => mentionsAttestation(item.specifier))) {
      if (test) continue;
      const allowed = ALLOWED[path];
      if (allowed === undefined) violations.push(`${path}: imports the attestation module and is not an allowed importer`);
      else if (ref.form !== "named") violations.push(`${path}: ${ref.form} import/export of the attestation module`);
      else for (const name of ref.names) if (!allowed.includes(name)) violations.push(`${path}: imports ${name} from the attestation module`);
    }
    // 2. The issuer claim: production never names it, as an identifier or a string, except the declaration and the one
    // package re-export.
    if (!test) {
      for (const { node } of identifiers(source, [ISSUER])) {
        const reexport = path === "packages/sdk/src/index.ts" && ts.isExportSpecifier(node.parent);
        const declaration = path === ATTESTATION && ts.isFunctionDeclaration(node.parent);
        if (!reexport && !declaration) violations.push(`${path}: references ${ISSUER} outside its declaration and the single package export`);
      }
      walk(source, node => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === ISSUER && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent))
          violations.push(`${path}: names ${ISSUER} as a string`);
      });
    }
    // 3. Internal names never leave the package entries; the guard binder is the attestation module's alone.
    if (ENTRIES.includes(path)) for (const { name } of identifiers(source, INTERNAL_NAMES)) violations.push(`${path}: package entry names internal ${name}`);
    if (!test) for (const ref of refs.filter(item => mentionsPreparation(item.specifier))) {
      if (ref.names.includes("bindGuidedGuestGuard") && path !== ATTESTATION) violations.push(`${path}: imports bindGuidedGuestGuard`);
      if (ref.names.includes("assertGuidedQueryClaimActive") && path !== QUERY) violations.push(`${path}: imports assertGuidedQueryClaimActive`);
    }
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

function loadProduction(): Map<string, string> {
  const files = new Map<string, string>();
  const roots = [...readdirSync(join(ROOT, "packages")).map(name => join("packages", name, "src")), "scripts"];
  for (const root of roots) {
    let entries: string[];
    try { entries = readdirSync(join(ROOT, root), { recursive: true, encoding: "utf8" }); } catch { continue; }
    for (const entry of entries) {
      const path = posix.join(...join(root, entry).split(sep));
      if (!path.endsWith(".ts") || path.endsWith(".d.ts") || /(^|\/)(node_modules|dist)\//.test(path)) continue;
      files.set(path, readFileSync(join(ROOT, path), "utf8"));
    }
  }
  return files;
}
const real = loadProduction();
// Every rule is per file, so a negative control scans just the file it plants or edits.
const withFile = (path: string, text: string) => new Map([[path, text]]);
const replaced = (path: string, edit: (text: string) => string) => new Map([[path, edit(real.get(path)!)]]);

test("the real tree is clean: the issuer is reachable from exactly one package export and no production path claims or mints", () => {
  expect(real.has(ATTESTATION)).toBe(true); expect(real.has(QUERY)).toBe(true); expect(real.size).toBeGreaterThan(100);
  expect(scan(real)).toEqual([]);
});
test("only test code claims the issuer: exactly the attestation suite and the capacity fixture", () => {
  const claimers = [...real].filter(([path, text]) => identifiers(parse(path, text), [ISSUER]).length > 0).map(([path]) => path).sort();
  expect(claimers).toEqual([ATTESTATION, "packages/sdk/src/fixtures/guided-guest-ticket-capacity.ts", "packages/sdk/src/guided-guest-attestation.test.ts", "packages/sdk/src/index.ts"].sort());
});
test("the package entries export the issuer once and nothing internal", () => {
  const index = parse(ENTRIES[0]!, real.get(ENTRIES[0]!)!);
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
  expect(identifiers(source, [ISSUER, "mint", "advance"]).filter(({ node }) => !ts.isPropertyAccessExpression(node.parent) || node.parent.name !== node)).toEqual([]);
});

// ---- negative controls: the pin itself must catch each wiring shape ------------------------------------------------

const rules: [string, Map<string, string>, RegExp][] = [
  ["a daemon file imports and claims the issuer", withFile("packages/sdk/src/daemon.ts", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; export const issuer = ${ISSUER}();`), /daemon\.ts: imports the attestation module/],
  ["a runtime package file claims through the package entry", withFile("packages/runtime/src/boot.ts", `import { ${ISSUER} } from "@yanlinglabs/winter-agent-sdk"; ${ISSUER}();`), /boot\.ts: references claimGuidedGuestIssuer/],
  ["a script requires the module", withFile("scripts/mint.ts", `const m = require("../packages/sdk/src/guided-guest-attestation.ts");`), /mint\.ts: imports the attestation module/],
  ["a dynamic import with a literal specifier", withFile("packages/sdk/src/late.ts", `export const load = () => import("./guided-guest-attestation.ts");`), /late\.ts: imports the attestation module/],
  ["a dynamic import with a computed specifier", withFile("packages/sdk/src/late.ts", `export const load = (name: string) => import(name);`), /computed module specifier/],
  ["a template-literal dynamic import", withFile("packages/sdk/src/late.ts", "export const load = () => import(`./guided-guest-${'attestation'}.ts`);"), /late\.ts: computed module specifier/],
  ["a string-keyed lookup of the claim", withFile("packages/runtime/src/boot.ts", `export const claim = (sdk: any) => sdk["${ISSUER}"]();`), /boot\.ts: names claimGuidedGuestIssuer as a string/],
  ["an import type of the module", withFile("packages/sdk/src/late.ts", `export type T = import("./guided-guest-attestation.ts").GuidedGuestIssuer;`), /late\.ts: imports the attestation module/],
  ["a namespace import in an allowed importer", replaced(QUERY, text => `import * as attestation from "./guided-guest-attestation.ts";\n${text}`), /query\.ts: namespace import/],
  ["query.ts also imports the issuer claim", replaced(QUERY, text => text.replace("{ retireGuidedGuestTicket, spendGuidedGuestTicket }", `{ retireGuidedGuestTicket, spendGuidedGuestTicket, ${ISSUER} }`)), /query\.ts: imports claimGuidedGuestIssuer/],
  ["the package entry star-exports the module", replaced("packages/sdk/src/index.ts", text => `${text}\nexport * from "./guided-guest-attestation.ts";`), /index\.ts: (star import\/export|namespace|star)/],
  ["the package entry exports an internal spender", replaced("packages/sdk/src/index.ts", text => text.replace(`export { ${ISSUER} }`, `export { ${ISSUER}, spendGuidedGuestTicket }`)), /index\.ts: imports spendGuidedGuestTicket/],
  ["a package entry names the internal guard type", replaced("packages/sdk/src/tools/index.ts", text => `${text}\nexport type Leak = import("../guided-query-preparation.ts").GuidedGuestGuard;`), /tools\/index\.ts: package entry names internal GuidedGuestGuard/],
  ["the messaging entry re-exports the issuer", replaced("packages/sdk/src/messaging/index.ts", text => `${text}\nexport { ${ISSUER} } from "../guided-guest-attestation.ts";`), /messaging\/index\.ts: imports the attestation module/],
  ["the module reads a clock", replaced(ATTESTATION, text => `${text}\nexport const stamp = Date.now();`), /clock or timer identifier Date/],
  ["the module sets a timer", replaced(ATTESTATION, text => text.replace("const fail =", "const expire = () => setTimeout(() => {}, 1);\nconst fail =")), /clock or timer identifier setTimeout/],
  ["the module exports a class", replaced(ATTESTATION, text => `${text}\nexport class GuestTicket {}`), /declares a class|exports a ClassDeclaration/],
  ["the module exports its mint", replaced(ATTESTATION, text => `${text}\nexport { mint };`), /export list is/],
  ["the module gains a dependency", replaced(ATTESTATION, text => `import { randomUUID } from "node:crypto";\n${text}`), /imports node:crypto,|imports \.\/guided-query-preparation\.ts,node:crypto/],
  ["another file imports the guard binder", withFile("packages/sdk/src/forge.ts", `import { bindGuidedGuestGuard } from "./guided-query-preparation.ts";`), /forge\.ts: imports bindGuidedGuestGuard/],
  ["another file imports the claim-active assert", withFile("packages/sdk/src/forge.ts", `import { assertGuidedQueryClaimActive } from "./guided-query-preparation.ts";`), /forge\.ts: imports assertGuidedQueryClaimActive/],
  ["a production file hides behind a fixture-like name", withFile("packages/sdk/src/fixtures/claim.ts", `import { ${ISSUER} } from "../guided-guest-attestation.ts"; ${ISSUER}();`), /fixtures\/claim\.ts: imports the attestation module/],
];
for (const [name, files, expected] of rules) {
  test(`pin catches: ${name}`, () => {
    const violations = scan(files);
    expect(violations.some(line => expected.test(line))).toBe(true);
  });
}
test("pin negative control: a test file may claim and import freely", () => {
  expect(scan(withFile("packages/sdk/src/other.test.ts", `import { ${ISSUER} } from "./guided-guest-attestation.ts"; ${ISSUER}();`))).toEqual([]);
});
