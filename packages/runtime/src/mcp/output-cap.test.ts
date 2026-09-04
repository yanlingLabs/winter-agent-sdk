// WS-09 §7 as amended by RULING P4-K: the oversized-result path is PERSIST-AND-ENVELOPE, not an
// inline token truncation. Every fixture writes into a fresh `mkdtemp` directory and removes it --
// nothing here touches a real session temp tree, a real home, or `~/.winter`.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capMcpOutput, estimateTokens, MCP_PERSISTED_OUTPUT_DIRNAME, type McpPersistTarget } from "./output-cap.ts";

function withSessionDir<T>(fn: (target: McpPersistTarget, sessionDir: string) => T): T {
  const sessionDir = mkdtempSync(join(tmpdir(), "winter-output-cap-"));
  try {
    return fn({ sessionDir: () => sessionDir, serverName: "srv", toolName: "big_tool" }, sessionDir);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

// Pulls the path out of the envelope's own header line -- the test reads what the MODEL reads,
// rather than trusting `persistedPath` to agree with the text.
function pathFromEnvelope(text: string): string {
  const m = /Full output saved to: (.+)/.exec(text);
  expect(m, "the envelope must name the file it saved").not.toBeNull();
  return m![1]!.trim();
}

describe("estimateTokens", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("~4 chars/token, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("capMcpOutput below the threshold (RULING P4-K: untouched)", () => {
  test("under the threshold: returned verbatim, nothing persisted, no session dir touched", () => {
    withSessionDir((target, sessionDir) => {
      const text = "hello world";
      const result = capMcpOutput(text, 1000, target);
      expect(result).toEqual({ text, truncated: false, originalTokens: estimateTokens(text), cappedTokens: estimateTokens(text) });
      expect(result.text).not.toContain("<persisted-output>");
      expect(existsSync(join(sessionDir, MCP_PERSISTED_OUTPUT_DIRNAME))).toBe(false);
    });
  });

  test("exactly at the threshold: not persisted (the boundary is inclusive)", () => {
    withSessionDir((target, sessionDir) => {
      const text = "a".repeat(40); // exactly 10 tokens at 4 chars/token
      const result = capMcpOutput(text, 10, target);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
      expect(existsSync(join(sessionDir, MCP_PERSISTED_OUTPUT_DIRNAME))).toBe(false);
    });
  });

  test("the session directory is resolved LAZILY -- a below-threshold call never even asks for it", () => {
    let asked = 0;
    const target: McpPersistTarget = {
      sessionDir: () => {
        asked += 1;
        return "/nonexistent/should-never-be-used";
      },
      serverName: "srv",
      toolName: "t",
    };
    capMcpOutput("small", 1000, target);
    expect(asked, "ToolExecutionContext.tempDir is a getter that CREATES the D18 temp tree on first read").toBe(0);
  });
});

describe("capMcpOutput over the threshold (RULING P4-K: the <persisted-output> envelope)", () => {
  test("the envelope shape: wrapper, size in KB, the saved path, and a head/tail excerpt with an elision", () => {
    withSessionDir((target) => {
      const head = "H".repeat(1000);
      const middle = "M".repeat(388_000);
      const tail = "T".repeat(1000);
      const text = head + middle + tail;
      const result = capMcpOutput(text, 25_000, target);

      expect(result.truncated).toBe(true);
      expect(result.text.startsWith("<persisted-output>\n")).toBe(true);
      expect(result.text.endsWith("\n</persisted-output>")).toBe(true);
      // 390 000 ASCII bytes / 1024 = 380.859... -> the capture's own "380.9KB".
      expect(result.text).toContain("Output too large (380.9KB). Full output saved to: ");
      expect(result.text).toContain("\n\n...\n\n"); // the elision
      expect(result.text).toContain(head);
      expect(result.text).toContain(tail);
      expect(result.text).not.toContain("M".repeat(2000)); // the middle is genuinely gone
      // The envelope is SMALL: the whole point is that the payload never reaches the model.
      expect(result.text.length).toBeLessThan(3000);
      // The retired inline marker must be gone everywhere.
      expect(result.text).not.toContain("[winter: MCP tool output truncated");
    });
  });

  test("the file holds the BYTE-EXACT payload -- no envelope, no header, no added newline", () => {
    withSessionDir((target, sessionDir) => {
      const text = `START${"x".repeat(200_000)}END`;
      const result = capMcpOutput(text, 25_000, target);
      const path = pathFromEnvelope(result.text);
      expect(result.persistedPath).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(text);
      // ...and it lands under THIS session's own directory, in the one named subdirectory.
      expect(path.startsWith(join(sessionDir, MCP_PERSISTED_OUTPUT_DIRNAME))).toBe(true);
    });
  });

  test("the path is session-scoped: two sessions never share a file", () => {
    withSessionDir((targetA, dirA) => {
      withSessionDir((targetB, dirB) => {
        const text = "y".repeat(200_000);
        const a = pathFromEnvelope(capMcpOutput(text, 25_000, targetA).text);
        const b = pathFromEnvelope(capMcpOutput(text, 25_000, targetB).text);
        expect(a).not.toBe(b);
        expect(a.startsWith(dirA)).toBe(true);
        expect(b.startsWith(dirB)).toBe(true);
      });
    });
  });

  test("two oversized results in ONE session get distinct files (never a clobber)", () => {
    withSessionDir((target, sessionDir) => {
      const first = capMcpOutput(`first${"a".repeat(200_000)}`, 25_000, target);
      const second = capMcpOutput(`second${"b".repeat(200_000)}`, 25_000, target);
      expect(first.persistedPath).not.toBe(second.persistedPath);
      expect(readdirSync(join(sessionDir, MCP_PERSISTED_OUTPUT_DIRNAME))).toHaveLength(2);
      expect(readFileSync(first.persistedPath!, "utf8").startsWith("first")).toBe(true);
      expect(readFileSync(second.persistedPath!, "utf8").startsWith("second")).toBe(true);
    });
  });

  test("a failed write never throws and never substitutes the full payload back in", () => {
    // A session dir that cannot be created (a path under an existing FILE) -- mkdirSync throws
    // ENOTDIR, which is exactly the class this fallback exists for.
    const sessionDir = mkdtempSync(join(tmpdir(), "winter-output-cap-"));
    try {
      const blocker = join(sessionDir, "blocker");
      writeFileSync(blocker, "not a directory");
      const target: McpPersistTarget = { sessionDir: () => blocker, serverName: "srv", toolName: "t" };
      const text = "z".repeat(200_000);
      const result = capMcpOutput(text, 25_000, target);
      expect(result.truncated).toBe(true);
      expect(result.persistedPath).toBeUndefined();
      expect(result.text).toContain("could NOT be saved to disk");
      expect(result.text.length).toBeLessThan(3000);
      expect(result.text).not.toContain("z".repeat(3000));
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test("non-positive maxOutputTokens degrades to a 1-token threshold rather than throwing", () => {
    withSessionDir((target) => {
      const result = capMcpOutput("hello world this is a longer string", 0, target);
      expect(result.truncated).toBe(true);
      expect(result.text).toContain("<persisted-output>");
      expect(capMcpOutput("hello world this is a longer string", -5, target).truncated).toBe(true);
    });
  });

  test("fractional maxOutputTokens truncates to an integer threshold", () => {
    withSessionDir((target) => {
      // 44 chars = 11 tokens: over a threshold of 10 (from 10.9), under one of 11.
      const text = "a".repeat(44);
      expect(capMcpOutput(text, 10.9, target).truncated).toBe(true);
      expect(capMcpOutput(text, 11, target).truncated).toBe(false);
    });
  });

  test("a payload just over the threshold but shorter than the two excerpt windows is carried whole", () => {
    withSessionDir((target) => {
      const text = "q".repeat(60); // 15 tokens, over a threshold of 10, well under 2000 chars
      const result = capMcpOutput(text, 10, target);
      expect(result.truncated).toBe(true);
      expect(result.text).toContain(text); // never "excerpted" into something longer than itself
      expect(result.text).not.toContain("\n\n...\n\n");
      expect(readFileSync(result.persistedPath!, "utf8")).toBe(text);
    });
  });
});
