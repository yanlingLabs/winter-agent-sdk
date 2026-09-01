import { test, expect } from "bun:test";
import { query } from "./query.ts";
import { ResultError } from "./errors.ts";
import { inMemorySpawn } from "winter-agent-runtime/testing";

test("query yields system/init, assistant, result in order", async () => {
  const seen: string[] = [];
  for await (const msg of query({ prompt: "ping", options: { model: "sonnet", spawnRuntime: inMemorySpawn() } })) {
    seen.push(msg.type);
  }
  expect(seen).toEqual(["system", "assistant", "result"]);
});

test("error-result-then-throw: the terminal error result is yielded, THEN the iterator throws ResultError", async () => {
  const boom = { async generate(): Promise<{ text: string }> { throw new Error("down"); } };
  const yielded: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({ prompt: "ping", options: { spawnRuntime: inMemorySpawn(boom) } })) {
      yielded.push(msg.type);
      if (msg.type === "result") { /* observe the error result before the throw */ expect((msg as { is_error?: boolean }).is_error).toBe(true); }
    }
  } catch (e) { thrown = e; }
  expect(yielded).toContain("result");        // result WAS yielded first (report §9)
  expect(thrown).toBeInstanceOf(ResultError); // …then the iterator threw
});
