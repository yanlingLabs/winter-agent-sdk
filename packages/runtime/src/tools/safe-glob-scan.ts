import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative as pathRelative, resolve } from "node:path";
import { currentHostCodeProtectionPaths, hostCodePathAllowed } from "../sandbox/host-code-protection.ts";

const permissionFailure = (error: unknown): boolean => typeof error === "object" && error !== null && ["EPERM", "EACCES"].includes((error as { code?: string }).code ?? "");
function readableMetadata(path: string): boolean {
  if (!hostCodePathAllowed(path, "read")) return false;
  try { statSync(path); return true; } catch (error) { return !permissionFailure(error); }
}
function fallbackStart(pattern: string, root: string): string {
  const parts=pattern.split("/");
  const dynamic=parts.findIndex(part=>/[*?\[\]{}\\]/.test(part));
  // Complete literal directory components anchor the walk. Absolute and ../ patterns
  // ignore/escape cwd just as Bun does; a narrow /fixture/target/**/* never walks /.
  if(dynamic===-1)return dirname(resolve(root,pattern));
  const prefix=parts.slice(0,dynamic).join("/");
  return resolve(root,isAbsolute(pattern)?(prefix || "/"):prefix);
}

/** Bun's native scanner aborts a whole scan on an inaccessible subtree. Retry that case
 * with directory-local errors so a protected sibling cannot hide allowed shared results.
 * Never follows a directory symlink, matching the native followSymlinks:false contract. */
export async function scanReadableFiles(pattern: string, root: string, dot: boolean, extraReadCheck?: (path: string) => boolean): Promise<string[]> {
  const allowed = (path: string) => hostCodePathAllowed(path, "read") && (extraReadCheck?.(path) ?? true);
  const glob = new Bun.Glob(pattern);
  const found = new Set<string>();
  if (!extraReadCheck && currentHostCodeProtectionPaths().denyReadPaths.length === 0) try {
    for await (const path of glob.scan({ cwd: root, onlyFiles: true, dot, followSymlinks: false })) found.add(isAbsolute(path) ? resolve(path) : resolve(root, path));
    return [...found].filter(readableMetadata);
  } catch (error) {
    if (!permissionFailure(error)) throw error;
  }
  found.clear();
  const start=fallbackStart(pattern,root);
  if (!allowed(start)) return [];
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    let entries;
    if (!allowed(resolve(start, relative))) continue;
    try { entries = readdirSync(resolve(start, relative), { withFileTypes: true }); }
    catch (error) { if (permissionFailure(error) || (error as { code?: string }).code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (!dot && entry.name.startsWith(".")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = resolve(start, child);
      if (!allowed(absolute)) continue;
      if (entry.isDirectory()) { pending.push(child); continue; }
      let file = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { file = statSync(absolute).isFile(); } catch { continue; }
      }
      if (file && glob.match(isAbsolute(pattern) ? absolute : pathRelative(root,absolute)) && readableMetadata(absolute)) found.add(absolute);
    }
  }
  return [...found];
}
