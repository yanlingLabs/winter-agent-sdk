// WS-21 §6.3 item 3 / Contract B: the shared runtime home's global config file -- claude's
// `.claude.json` in shape (`mcpServers` for the `user` scope, `projects[<abs root>].mcpServers`
// for `local`), Winter's own name. Its READER lives in
// packages/runtime/src/settings/loaders/mcp-config.ts (`loadGlobalConfigMcp`); this module only
// names the file, the same split `paths/home.ts` makes between "what the path is" and "who reads
// it".
import type { BrandProfile } from "../brand.ts";

/**
 * `<brand.homeDirName>.json` -- `.winter.json` for Winter's own brand. `brand.homeDirName` is
 * documented (`brand.ts`) as never containing a slash, so this is always a single path segment,
 * safe to `join` onto any directory without further validation.
 */
export function globalConfigFileName(brand: Pick<BrandProfile, "homeDirName">): string {
  return `${brand.homeDirName}.json`;
}
