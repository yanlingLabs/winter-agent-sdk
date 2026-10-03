// Edge cases of the `claudeMd` userContext value (`renderInstructionsContext`).
import { describe, expect, test } from "bun:test";
import { INSTRUCTIONS_CONTEXT_HEADER, renderInstructionsContext } from "./winter-md.ts";

describe("renderInstructionsContext", () => {
  test("a file with EMPTY content is skipped; when every file is empty there is no value", () => {
    expect(renderInstructionsContext([{ path: "/a", kind: "user", content: "" }])).toBeUndefined();
    expect(renderInstructionsContext([{ path: "/a", kind: "user", content: "" }, { path: "/b", kind: "project", content: "B" }])).toBe(
      `${INSTRUCTIONS_CONTEXT_HEADER}\n\nContents of /b (project instructions, checked into the codebase):\n\nB`,
    );
  });

  test("emptiness is judged BEFORE trimming: a whitespace-only file still gets an entry, with nothing after its blank line", () => {
    expect(renderInstructionsContext([{ path: "/w", kind: "local", content: "  \n\t" }])).toBe(
      `${INSTRUCTIONS_CONTEXT_HEADER}\n\nContents of /w (user's private project instructions, not checked in):\n\n`,
    );
  });

  test("content is trimmed at both ends but kept intact inside", () => {
    expect(renderInstructionsContext([{ path: "/m", kind: "auto-memory", content: "\n\n  line 1\n\n  line 2  \n" }])).toBe(
      `${INSTRUCTIONS_CONTEXT_HEADER}\n\nContents of /m (user's auto-memory, persists across conversations):\n\nline 1\n\n  line 2`,
    );
  });

  test("entries keep the given order and duplicates are not collapsed", () => {
    const out = renderInstructionsContext([
      { path: "/p", kind: "project", content: "1" },
      { path: "/p", kind: "project", content: "2" },
      { path: "/u", kind: "user", content: "3" },
    ]);
    expect(out).toBe(
      `${INSTRUCTIONS_CONTEXT_HEADER}\n\n` +
        "Contents of /p (project instructions, checked into the codebase):\n\n1\n\n" +
        "Contents of /p (project instructions, checked into the codebase):\n\n2\n\n" +
        "Contents of /u (user's private global instructions for all projects):\n\n3",
    );
  });

  test("the path is inserted as-is (spaces, unicode, an empty path)", () => {
    expect(renderInstructionsContext([{ path: "", kind: "user", content: "x" }])).toBe(`${INSTRUCTIONS_CONTEXT_HEADER}\n\nContents of  (user's private global instructions for all projects):\n\nx`);
    expect(renderInstructionsContext([{ path: "/a b/é.md", kind: "user", content: "x" }])).toContain("Contents of /a b/é.md (user's");
  });
});
