// SDK 0.0.16 Lane C: the persisted-attachment renderers and folds. Texts are the pinned binary's.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import {
  attachmentMessage,
  attachmentsIn,
  dateChangeAnnounced,
  localDateString,
  registerAttachmentRenderer,
  renderAttachment,
  skillListingResumeSeed,
  wrapSystemReminder,
} from "./attachments.ts";

describe("rendering", () => {
  test("the wrapper adds exactly the tag lines", () => {
    expect(wrapSystemReminder("x")).toBe("<system-reminder>\nx\n</system-reminder>");
  });

  test("skill_listing: claude's header, a blank line, the content -- and nothing for empty content", () => {
    expect(renderAttachment({ type: "skill_listing", content: "- a: A.\n- b", skillCount: 2, isInitial: true, names: ["a", "b"] })).toBe(
      "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- a: A.\n- b\n</system-reminder>",
    );
    expect(renderAttachment({ type: "skill_listing", content: "", skillCount: 0, isInitial: true, names: [] })).toBeUndefined();
  });

  test("date_change: claude's one-line text", () => {
    expect(renderAttachment({ type: "date_change", newDate: "2026-09-18" })).toBe(
      "<system-reminder>\nThe date has changed. Today's date is now 2026-09-18. No need to announce the new date — the user's own clock shows it.\n</system-reminder>",
    );
  });

  test("an unknown type renders nothing and yields no message; a registered renderer makes it render", () => {
    expect(attachmentMessage({ type: "lane-c-test-kind", text: "t" })).toBeUndefined();
    registerAttachmentRenderer("lane-c-test-kind", (a) => String(a["text"]));
    expect(attachmentMessage({ type: "lane-c-test-kind", text: "t" })).toEqual({
      role: "user",
      content: "<system-reminder>\nt\n</system-reminder>",
      meta: { attachment: { type: "lane-c-test-kind", text: "t" } },
    });
  });
});

describe("folds", () => {
  const history: ProviderMessage[] = [
    { role: "user", content: "p" },
    attachmentMessage({ type: "skill_listing", content: "- a", skillCount: 1, isInitial: true, names: ["a"] })!,
    attachmentMessage({ type: "date_change", newDate: "2026-09-18" })!,
    { role: "user", content: "legacy", meta: { attachment: { type: "skill_listing", content: "- z" } } },
  ];

  test("attachmentsIn keeps history order", () => {
    expect(attachmentsIn(history).map((a) => a.type)).toEqual(["skill_listing", "date_change", "skill_listing"]);
  });

  test("date_change is found by its new date only", () => {
    expect(dateChangeAnnounced(history, "2026-09-18")).toBe(true);
    expect(dateChangeAnnounced(history, "2026-09-19")).toBe(false);
  });

  test("the skill resume seed: names from entries that carry them, suppressNext for a legacy one that does not", () => {
    expect(skillListingResumeSeed(history)).toEqual({ names: ["a"], suppressNext: true });
  });

  test("localDateString is the LOCAL calendar date", () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
