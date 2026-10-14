import { expect, test } from "bun:test";
import { createSystemPromptAssembler } from "./assembler.ts";
import type { SystemPromptInput } from "./seam.ts";
import type { Settings } from "@yanlinglabs/winter-agent-sdk";

test("guided assembler retains the exact required source and excludes legacy instruction/memory discovery", () => {
  let memoryInputs = 0;
  const requiredContext = { async resolve() { return { revision: "r1", facts: "facts", instructions: "current" }; } };
  const settings = Object.defineProperty({}, "autoMemoryDirectory", { get() { memoryInputs++; throw new Error("personal memory configuration must not be inspected"); } }) as Settings;
  const assembler = createSystemPromptAssembler({ home: "/fixture/run-home", settings: () => settings, requiredContext, admittedGuidanceOnly: true });
  const input: SystemPromptInput = { config: { sessionId: "fixture", model: "fixture/model", cwd: "/fixture/source", settingSources: [], autoMemory: { enabled: true } }, cwd: "/fixture/source", env: {},
    platform: "linux", osVersion: "fixture", shell: "/bin/sh", date: "2026-10-14" };
  Object.defineProperty(input, "memoryDir", { get() { memoryInputs++; throw new Error("legacy memory directory must not be inspected"); } });
  Object.defineProperty(input.config, "autoMemory", { get() { memoryInputs++; throw new Error("legacy memory option must not be inspected"); } });
  expect(assembler.requiredContext).toBe(requiredContext);
  expect(assembler.userContext!(input)).toEqual([["currentDate", "Today's date is 2026-10-14."]]);
  expect(assembler.assemble(input).system).not.toContain("auto memory");
  expect(memoryInputs).toBe(0);
  expect(() => createSystemPromptAssembler({ admittedGuidanceOnly: true })).toThrow("required_context_unavailable");
});
