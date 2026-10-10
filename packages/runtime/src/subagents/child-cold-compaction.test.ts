import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import type { GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { Provider, ProviderMessage } from "../engine.ts";
import type { CompactionController } from "../compaction/seam.ts";
import { TranscriptWriter, childTranscriptSubpath } from "../store/dialect.ts";
import { rebuildProviderMessages, toDialectEntries } from "../store/resume.ts";
import { userMessageText } from "../provider/mock.ts";
import { createChildEngineFactory } from "./child-engine.ts";
import type { ChildHandle, ChildSessionRecord } from "./child-handle.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";

function message(sessionId: string, body: string): GlobalAgentMessage {
  const address = { objectKind: "session" as const, runtimeKind: "winter-agent" as const, winterSessionId: sessionId };
  return { messageId: randomUUID(), from: address, fromGeneration: 1, to: address, toGeneration: 1,
    body, notifyWhenIdle: false, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    hopCount: 0, senderPermissionClass: "unknown" };
}

async function finished(handle: ChildHandle): Promise<void> {
  const until = Date.now() + 3000;
  while (handle.status() === "running" && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(handle.status()).toBe("completed");
}

// Semantic persistence regression; real OS-process identity is covered independently by
// sdk/src/subagent-cold-restart.test.ts. This test injects a deterministic compaction policy,
// while using the actual child restore/generation, writer, native boundary and resume reader.
test("a child's first compaction after cold restore retains prior messages through another restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "winter-child-cold-compaction-"));
  const sessionId = randomUUID();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  const seen: ProviderMessage[][] = [];
  const provider: Provider = { async generate(request) {
    seen.push(structuredClone(request.messages));
    const latest = request.messages.filter((item) => item.role === "user").at(-1);
    return { kind: "text", text: "reply: " + userMessageText(latest) };
  } };
  const bind = (compactionController?: CompactionController) => createChildEngineFactory({
    provider, store, winterHome: root, env: {},
    ...(compactionController !== undefined ? { compactionController } : {}),
  })({ parentSessionId: sessionId, forwardChildFrame() {} });
  const handles: ChildHandle[] = [];
  try {
    const initial = await bind().spawn({ parentToolUseId: "original-spawn", prompt: "DROP_BEFORE_COMPACT", runInBackground: false }, {
      policy: { effectiveMode: "default", parentPolicyHash: "original-policy", parentPolicyVersion: 1 },
      tools: [], model: "winter-test/echo", effort: "medium", thinking: undefined, systemPrompt: "", sessionRoot: root,
    });
    handles.push(initial);
    await initial.result();
    expect((await initial.resume(message(sessionId, "KEEP_BEFORE_RESTART"))).status).toBe("resumed_and_delivered");
    await finished(initial);
    const key = { projectKey: compatibilityKeys(root).transcriptProjectKey, sessionId, subpath: childTranscriptSubpath(initial.record.id) };
    const before = toDialectEntries(await TranscriptWriter.readBack(store, key));
    const priorPair = before.filter((entry) => entry.message !== undefined).slice(-2).map((entry) => entry.uuid);
    expect(priorPair).toHaveLength(2);
    expect(JSON.stringify(rebuildProviderMessages(before))).toContain("KEEP_BEFORE_RESTART");

    let compacted = false;
    const controller: CompactionController = {
      shouldCompact() { return !compacted; },
      async compact(input) {
        compacted = true;
        // Retain the last old user+assistant pair and the newly delivered message.
        // The summary intentionally omits that pair, so replay cannot pass by summary alone.
        return { summary: "SUMMARY_WITHOUT_PRIOR_PAIR", retained: input.messages.slice(-3), preTokens: 100, evidencedToolNames: [] };
      },
    };
    const cold = await bind(controller).restore!(JSON.parse(JSON.stringify(initial.record)) as ChildSessionRecord);
    handles.push(cold);
    expect((await cold.resume(message(sessionId, "COMPACT_THIS_RESUME"))).status).toBe("resumed_and_delivered");
    await cold.result();
    await finished(cold);
    expect(compacted).toBe(true);
    const afterCompact = toDialectEntries(await TranscriptWriter.readBack(store, key));
    const boundary = afterCompact.find((entry) => entry.type === "system" && entry.subtype === "compact_boundary")!;
    expect(boundary).toBeDefined();
    const preserved = (boundary.compactMetadata as { preservedMessages?: { uuids: string[] } }).preservedMessages?.uuids ?? [];
    for (const uuid of priorPair) expect(preserved).toContain(uuid);
    const rebuilt = JSON.stringify(rebuildProviderMessages(afterCompact));
    expect(rebuilt).toContain("KEEP_BEFORE_RESTART");
    expect(rebuilt).toContain("reply: KEEP_BEFORE_RESTART");
    expect(rebuilt).not.toContain("DROP_BEFORE_COMPACT");

    const next = await bind().restore!(JSON.parse(JSON.stringify(cold.record)) as ChildSessionRecord);
    handles.push(next);
    expect((await next.resume(message(sessionId, "AFTER_SECOND_RESTART"))).status).toBe("resumed_and_delivered");
    await next.result();
    await finished(next);
    const finalRequest = JSON.stringify(seen.at(-1));
    expect(finalRequest).toContain("SUMMARY_WITHOUT_PRIOR_PAIR");
    expect(finalRequest).toContain("KEEP_BEFORE_RESTART");
    expect(finalRequest).toContain("reply: KEEP_BEFORE_RESTART");
    expect(finalRequest).toContain("COMPACT_THIS_RESUME");
    expect(finalRequest).toContain("AFTER_SECOND_RESTART");
    expect(finalRequest).not.toContain("DROP_BEFORE_COMPACT");
    expect(next.record.id).toBe(initial.record.id);
  } finally {
    for (const handle of handles) await handle.stop();
    resetSpawnLimitsForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
