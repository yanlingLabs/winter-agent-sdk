// WS-23 item 7: on a model that takes mid-conversation system messages, a reminder whose renderer
// opted in (Winter-authored text only -- `date_change` today) rides as `role: "system"` right after
// the user turn that triggered it; everything else, and every placement the vendor forbids, keeps
// today's user-text form. Reminders stay append-only either way.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { attachmentMessage, isSystemRoleAttachment } from "./attachments.ts";
import { buildRequestMessages } from "./request-layout.ts";

const dateChange = attachmentMessage({ type: "date_change", newDate: "2026-09-26" })!;
const skills = attachmentMessage({ type: "skill_listing", content: "- alpha: Alpha.", skillCount: 1, isInitial: true, names: ["alpha"] })!;

describe("system-role reminders (WS-23 item 7)", () => {
  test("only Winter-authored reminders opt in: the date change does, the skill listing (third-party descriptions) does not", () => {
    expect(isSystemRoleAttachment({ type: "date_change", newDate: "x" })).toBe(true);
    expect(isSystemRoleAttachment({ type: "skill_listing" })).toBe(false);
    expect(isSystemRoleAttachment({ type: "agent_listing_delta" })).toBe(false);
  });

  test("on a model with the evidence, the date change follows the user turn as its own `system` message and is never merged into the user's text", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "one" }, { role: "assistant", content: "r1" }, { role: "user", content: "two" }, dateChange];
    const out = buildRequestMessages(history, undefined, { systemReminders: true });
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(out[3]).toEqual({ role: "system", content: dateChange.content });
    expect(out[2]).toEqual({ role: "user", content: "two" });
  });

  test("without the evidence the layout is exactly today's (the reminder bubbles up and merges into the user turn)", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "one" }, { role: "assistant", content: "r1" }, { role: "user", content: "two" }, dateChange];
    expect(buildRequestMessages(history, undefined, { systemReminders: false })).toEqual(buildRequestMessages(history));
    expect(buildRequestMessages(history).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("an opted-out reminder keeps its user form beside a system one", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "go" }, skills, dateChange];
    const out = buildRequestMessages(history, undefined, { systemReminders: true });
    expect(out.map((m) => m.role)).toEqual(["user", "system"]);
    expect(JSON.stringify(out[0]!.content)).toContain("The following skills are available");
  });

  test("placements the vendor forbids fall back to user text: after an assistant reply, or with another user turn behind it", () => {
    const afterAssistant = buildRequestMessages([{ role: "user", content: "summary" }, { role: "assistant", content: "kept reply" }, dateChange], undefined, { systemReminders: true });
    expect(afterAssistant.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const interrupted = buildRequestMessages([{ role: "user", content: "one" }, dateChange, { role: "user", content: "two" }], undefined, { systemReminders: true });
    expect(interrupted.some((m) => m.role === "system")).toBe(false);
  });

  test("append-only: the reminder keeps its position and bytes on every later request", () => {
    const turn2: ProviderMessage[] = [{ role: "user", content: "two" }, dateChange];
    const turn3: ProviderMessage[] = [...turn2, { role: "assistant", content: "r2" }, { role: "user", content: "three" }];
    const a = buildRequestMessages(turn2, undefined, { systemReminders: true });
    const b = buildRequestMessages(turn3, undefined, { systemReminders: true });
    expect(b.slice(0, a.length)).toEqual(a);
  });
});
