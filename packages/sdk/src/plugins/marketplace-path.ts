// Resolves a directory marketplace manifest's plugin `source` (optionally relative to the
// manifest's `metadata.pluginRoot`) into an absolute path that cannot escape the marketplace
// directory. It is the single resolver both packages/runtime/src/plugins/installed.ts and
// packages/sdk/src/plugins/manage.ts call. Pure, synchronous (no filesystem access) and it
// never throws: every refusal is reported as `undefined`.

import path from "node:path";

// Sentinel meaning "the marketplace directory itself" as a usable plugin root.
const MARKETPLACE_DIR = Symbol("marketplace-dir");

// Interprets the manifest-level plugin root. Returns the marketplace-dir sentinel, a clean
// relative directory string, or undefined when the root is absent or unusable.
function usableRoot(pluginRoot: unknown): string | typeof MARKETPLACE_DIR | undefined {
  if (typeof pluginRoot !== "string") return undefined;
  if (pluginRoot === "" || pluginRoot.startsWith("/")) return undefined;
  if (pluginRoot.includes("\\") || pluginRoot.includes(":")) return undefined;

  let rest = pluginRoot.startsWith("./") ? pluginRoot.slice(2) : pluginRoot;
  rest = rest.replace(/\/+$/, "");
  if (rest === "" || rest === ".") return MARKETPLACE_DIR;

  for (const piece of rest.split("/")) {
    if (piece === "" || piece === "." || piece === "..") return undefined;
  }
  return rest;
}

// A bare name starts with an ASCII letter or digit, continues with letters, digits, `-`, `.`
// or `_`, and never contains `..`.
function isBareName(source: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source) && !source.includes("..");
}

export function resolveMarketplacePluginPath(installLocation: string, pluginRoot: unknown, source: unknown): string | undefined {
  try {
    // Step 1: the source must be a non-empty string.
    if (typeof source !== "string" || source === "") return undefined;

    // Step 2-4: a bare name is placed under the usable plugin root; any other source is
    // taken exactly as written.
    let relativePath = source;
    if (isBareName(source)) {
      const root = usableRoot(pluginRoot);
      if (root !== undefined) {
        relativePath = root === MARKETPLACE_DIR ? `./${source}` : `./${root}/${source}`;
      }
    }

    // Step 5: the effective path must be "." or explicitly relative ("./...").
    if (relativePath === ".") relativePath = "./";
    if (!relativePath.startsWith("./")) return undefined;

    // Step 6: containment. This is the security boundary: the resolved candidate must be the
    // resolved marketplace directory or lie strictly beneath it, so no `..` segment or
    // absolute path can point outside the marketplace (symlinks are not examined: no I/O).
    const base = path.resolve(installLocation);
    const candidate = path.resolve(installLocation, relativePath);
    if (candidate === base || candidate.startsWith(base + path.sep)) return candidate;
    return undefined;
  } catch {
    return undefined;
  }
}
