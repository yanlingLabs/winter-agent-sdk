import type { WinterFrame } from "./frames.ts";
export class ProtocolError extends Error {}

export function encodeFrame(frame: WinterFrame): string { return JSON.stringify(frame) + "\n"; }

export function decodeFrame(line: string): WinterFrame {
  let v: unknown;
  try { v = JSON.parse(line); } catch { throw new ProtocolError(`malformed JSON frame: ${line.slice(0, 80)}`); }
  if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { type?: unknown }).type !== "string")
    throw new ProtocolError("frame missing string 'type'");
  return v as WinterFrame; // open struct: unknown fields are retained on the object as-is
}

export function splitFrames(chunk: string, carry: string): { frames: WinterFrame[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split("\n");
  const nextCarry = parts.pop() ?? "";           // trailing partial (or "") stays in carry
  const frames = parts.filter((l) => l.length > 0).map(decodeFrame);
  return { frames, carry: nextCarry };
}
