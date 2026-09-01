import { test, expect } from "bun:test";
import { extractInventory, diffInventory } from "./gen-declaration-snapshot.ts";

const dts = { "sdk.d.ts": `export interface Options { model?: string }\nexport declare function query(a: unknown): unknown;\nexport type PermissionMode = "default" | "auto";` };

test("extractInventory lists exported symbol names + kinds, not verbatim bodies", () => {
  const { exports, digests } = extractInventory(dts);
  const names = exports.symbols.map((s) => s.name).sort();
  expect(names).toEqual(["Options", "PermissionMode", "query"]);
  expect(exports.symbols.find((s) => s.name === "query")!.kind).toBe("function");
  expect(digests["sdk.d.ts"]).toMatch(/^[0-9a-f]{64}$/); // digest, not the source text (WS-02 §6, no verbatim)
});

test("diffInventory flags an added export", () => {
  const a = extractInventory(dts).exports;
  const b = extractInventory({ "sdk.d.ts": dts["sdk.d.ts"] + `\nexport type NewThing = number;` }).exports;
  expect(diffInventory(a, b)).toContain("added export: NewThing (type)");
});
