import { posix } from "node:path";
import { GuestFileHelperError, type GuestFileSnapshot } from "./file-helper.ts";
import { guestFileError, type GuestFileSession } from "./file-session.ts";
import type { ToolExecutionContext, ToolResultPayload } from "../tools/registry.ts";
import { evaluateReadLadder } from "../tools/impl/read-ladder.ts";
import { computeLineDiff } from "../tools/line-diff.ts";

export function guestTarget(ctx: ToolExecutionContext, path: string): string {
  if (!posix.isAbsolute(ctx.cwd) || path.includes("\0") || !path.trim()) throw new GuestFileHelperError("path_denied", "invalid guest path");
  return posix.resolve(ctx.cwd, path.trim());
}
function text(snapshot: GuestFileSnapshot): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes); }
  catch { throw new GuestFileHelperError("guest_file_type_unsupported", "guest text operations require UTF-8 text"); }
}
function record(guest: GuestFileSession, path: string, snapshot: GuestFileSnapshot, complete: boolean): void {
  guest.readState.recordRead(path, { complete, mtimeMs: snapshot.mtimeMs, fileVersion: snapshot.fileVersion });
}
function diff(before: string, after: string) {
  // Host diff behavior stays unchanged; bounded guest payloads can still contain many short lines.
  const oldLines = before.split("\n").length, newLines = after.split("\n").length;
  if (Math.max(oldLines, newLines) > 8192 || oldLines * newLines > 1_000_000) return { diff: [], diffTruncated: true };
  return { diff: computeLineDiff(before, after) };
}
function decision(guest: GuestFileSession, path: string, snapshot: GuestFileSnapshot, operation: "edit" | "overwrite", unambiguous?: boolean) {
  return evaluateReadLadder({ filePath: path, currentMtimeMs: snapshot.mtimeMs, currentFileVersion: snapshot.fileVersion, operation,
    ...(unambiguous === undefined ? {} : { hasUnambiguousCurrentMatch: unambiguous }) }, { readState: guest.readState, probeReadAccess: target => guest.probeReadAccess(target) });
}
export async function guestWrite(input: { file_path: string; content: string }, ctx: ToolExecutionContext, guest: GuestFileSession): Promise<ToolResultPayload> {
  try {
    const path = guestTarget(ctx, input.file_path);
    let before: GuestFileSnapshot | undefined;
    try { before = await guest.read(path, ctx.signal); }
    catch (error) {
      if (!(error instanceof GuestFileHelperError && error.code === "path_denied" && error.errno === 2)) throw error;
    }
    if (before) {
      const allowed = decision(guest, path, before, "overwrite");
      if (!allowed.eligible) return { output: `Error: ${allowed.reason}`, isError: true };
    }
    const previous = before ? text(before) : undefined;
    let after: GuestFileSnapshot;
    try { after = await guest.write(path, Buffer.from(input.content), before?.fileVersion ?? "absent", ctx.signal); }
    catch (error) {
      if (!before && error instanceof GuestFileHelperError && error.code === "path_denied" && error.errno === 2) throw new GuestFileHelperError("guest_parent_creation_unsupported", "new guest Write requires existing parent directories");
      throw error;
    }
    record(guest, path, after, true);
    return { output: JSON.stringify({ type: before ? "update" : "create", filePath: path, content: input.content,
      ...diff(previous ?? "", input.content), ...(previous === undefined ? {} : { previousContent: previous }), userEdited: false }) };
  } catch (error) { return guestFileError(error); }
}
export async function guestEdit(input: { file_path: string; old_string: string; new_string: string; replace_all: boolean }, ctx: ToolExecutionContext, guest: GuestFileSession): Promise<ToolResultPayload> {
  try {
    const path = guestTarget(ctx, input.file_path), before = await guest.read(path, ctx.signal), content = text(before);
    const occurrences = content.split(input.old_string).length - 1;
    const allowed = decision(guest, path, before, "edit", occurrences === 1);
    if (!allowed.eligible) return { output: `Error: ${allowed.reason}`, isError: true };
    if (!occurrences) return { output: `Error: old_string not found in "${path}"`, isError: true };
    if (occurrences > 1 && !input.replace_all) return { output: `Error: old_string appears ${occurrences} times in "${path}" -- pass replace_all:true, or include more surrounding context to make it unique`, isError: true };
    const at = content.indexOf(input.old_string), updated = input.replace_all ? content.split(input.old_string).join(input.new_string) : content.slice(0, at) + input.new_string + content.slice(at + input.old_string.length);
    const complete = guest.readState.lookup(path)?.complete === true;
    const after = await guest.write(path, Buffer.from(updated), before.fileVersion, ctx.signal);
    record(guest, path, after, complete);
    return { output: JSON.stringify({ filePath: path, ...diff(content, updated), originalContent: content, replaceAll: input.replace_all, userModified: false }) };
  } catch (error) { return guestFileError(error); }
}
export function guestText(snapshot: GuestFileSnapshot): string { return text(snapshot); }
