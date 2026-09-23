// WS-21, fix round 3 (I-1, security): the ONE resolver for "a directory marketplace manifest names
// a plugin's install path" -- ported from the pinned binary's own three-function chain (claude CLI
// 2.1.250 / agent-sdk 0.3.250, dump-confirmed by content search around offset 11903300 for
// `Gyn`/`Vyn`/`E3t`/`Zs`, and offset 19588032 for `Aoe`), because BOTH call sites this repository had
// (`packages/runtime/src/plugins/installed.ts`'s directory-marketplace fallback, and this package's
// own `manage.ts`'s `resolvePluginSourcePath`) did a bare, unchecked `resolve(installLocation,
// pluginRoot, entry.source)`:
//
//   - `source: "../../x"`, `source: "/abs"` or `pluginRoot: "/etc"` escaped the marketplace
//     directory entirely, and that plugin's hooks then run shell commands from wherever it landed;
//   - `pluginRoot: "./plugins"` with `source: "./plugins/foo"` DOUBLED into `plugins/plugins/foo`
//     (both were always joined, unconditionally) -- claude only ever consults `pluginRoot` for a
//     BARE name (see `withPluginRootPrefix` below); an explicit relative `source` ignores it
//     entirely;
//   - a bare `source: "foo"` with NO `pluginRoot` set (or an invalid one) loaded anyway, where
//     claude refuses it outright (`Zs`'s own paired message, `Js` in the pinned binary: "Bare source
//     names resolve under metadata.pluginRoot, which this marketplace does not set...").
//
// PURE AND SYNCHRONOUS, deliberately: this function does no I/O (unlike its two callers, one async
// for the CLI-facing management API, one sync for the runtime's own directory-marketplace read), so
// there is no reason for a second copy -- the "installed.ts is sync, manage.ts is async" split that
// might tempt duplicating this exists at the CALLERS, not here.
import { resolve, sep } from "node:path";

/**
 * `Zs` (dump-confirmed): a BARE plugin source name -- no path separator of any kind, so it can only
 * ever mean "a plugin directly under the marketplace's `pluginRoot`", never a path a caller
 * constructed. Starts with an alphanumeric; the rest is alphanumeric, `-`, `.` or `_`.
 */
const BARE_SOURCE_NAME = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;

/** `E3t` (dump-confirmed): is `source` a bare name -- `Zs`-shaped AND (belt-and-suspenders, `Zs`'s own class permits `.`) never containing `".."`. */
function isBareSourceName(source: string): boolean {
  return BARE_SOURCE_NAME.test(source) && !source.includes("..");
}

/**
 * `Gyn` (dump-confirmed): normalizes and validates a marketplace manifest's `metadata.pluginRoot`.
 * `undefined` (invalid, or simply absent -- `typeof` narrows both to the same rung) for: not a
 * string, empty, an ABSOLUTE path (`startsWith("/")`), a Windows-style separator or drive letter
 * (`\` or `:`), or any segment that is empty, `.` or `..` once a leading `./` and trailing `/`s are
 * stripped. The bare root itself (`""`/`"."`/`"./"`) normalizes to `"."`.
 */
function normalizePluginRoot(pluginRoot: unknown): string | undefined {
  if (typeof pluginRoot !== "string" || pluginRoot === "" || pluginRoot.startsWith("/") || pluginRoot.includes("\\") || pluginRoot.includes(":")) return undefined;
  const stripped = pluginRoot.replace(/^\.\//, "").replace(/\/+$/, "");
  if (stripped === "" || stripped === ".") return ".";
  if (stripped.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return stripped;
}

/**
 * `Vyn` (dump-confirmed): prefixes the NORMALIZED `pluginRoot` onto `source` -- but ONLY when
 * `source` is a bare name AND a valid root was actually resolved. An already-relative source
 * (`"./x"`), an absolute one, or anything else that is not a bare name passes through UNCHANGED --
 * `pluginRoot` never touches it, which is what stops the double-join bug (`pluginRoot: "./plugins"`
 * + `source: "./plugins/foo"` staying `"./plugins/foo"`, not becoming `"./plugins/plugins/foo"`).
 */
function withPluginRootPrefix(source: string, normalizedRoot: string | undefined): string {
  if (normalizedRoot === undefined || !isBareSourceName(source)) return source;
  return normalizedRoot === "." ? `./${source}` : `./${normalizedRoot}/${source}`;
}

/**
 * The source SCHEMA'S OWN shape rule (I-1: "the source schema requires startsWith('./')"; `"."`
 * alone means `"./"`). Applied AFTER `withPluginRootPrefix`: a still-bare name here (no `pluginRoot`
 * was available to prefix it) is REFUSED, matching claude's own `Js` message -- Winter had no
 * equivalent refusal before this fix, and silently resolved it anyway.
 */
function schemaSourcePath(source: string): string | undefined {
  const normalized = source === "." ? "./" : source;
  return normalized.startsWith("./") ? normalized : undefined;
}

/**
 * `Aoe` (dump-confirmed, offset 19588032): the RUNTIME FENCE, and the actual security boundary --
 * every check above is syntactic (string shape), but only resolving the path and verifying the
 * result is still inside `base` catches what string checks cannot (a `pluginRoot`/`source` pair that
 * is individually well-formed but composes to something outside `base` once resolved, or a
 * platform-specific escape a regex alone would miss). The `+ sep` on the prefix check is deliberate:
 * a naive `resolved.startsWith(base)` would wrongly accept a SIBLING directory that merely shares
 * `base` as a string prefix (`/marketplace` vs `/marketplace-evil`).
 */
function resolveWithinBase(base: string, relativePath: string): string {
  const normalizedBase = resolve(base);
  const resolved = resolve(base, relativePath);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + sep)) {
    throw new Error(`Path traversal detected: "${relativePath}" would escape the base directory`);
  }
  return resolved;
}

/**
 * Resolve one marketplace manifest plugin entry's install path -- the ONE function
 * `packages/runtime/src/plugins/installed.ts` (the daemon's own directory-marketplace fallback,
 * SV-4) and `packages/sdk/src/plugins/manage.ts` (`resolvePluginSourcePath`, the CLI-facing install
 * command) both call, so the two can never resolve the identical manifest entry to two different
 * paths. `undefined` for anything invalid or refused -- a bare name with no usable `pluginRoot`, an
 * absolute/malformed source, or a path that would escape `installLocation` -- NEVER a throw a
 * caller must remember to catch; each caller renders its own typed rejection from `undefined`.
 */
export function resolveMarketplacePluginPath(installLocation: string, pluginRoot: unknown, source: unknown): string | undefined {
  if (typeof source !== "string" || source === "") return undefined;
  const normalizedRoot = normalizePluginRoot(pluginRoot);
  const prefixed = withPluginRootPrefix(source, normalizedRoot);
  const sourcePath = schemaSourcePath(prefixed);
  if (sourcePath === undefined) return undefined;
  try {
    return resolveWithinBase(installLocation, sourcePath);
  } catch {
    return undefined;
  }
}
