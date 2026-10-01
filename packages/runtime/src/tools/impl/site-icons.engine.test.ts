// Host-only site icons, end to end through the REAL engine: a tool result's `siteIcons`
// (`ToolResultPayload.siteIcons` -- WebFetch's page icon, WebSearch's Exa favicons) reaches the HOST'S
// tool-round frame as `winter_site_icons: [{url, icon_url}]`, and NOTHING the model or the transcript
// sees: not the provider's next request, not the recorded user entry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../../protocol/channel.ts";
import { runEngine, withHostSiteIcons, type ContentBlock, type EngineOptions, type ProviderRequest } from "../../engine.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-site-icons-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ICONS = [
  { url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/touch.png" },
  { url: "https://other.example.org/", iconUrl: "https://cdn.example.net/o.png" },
];

async function run(siteIcons: typeof ICONS | undefined): Promise<{ requests: ProviderRequest[]; recorded: unknown[]; frames: WinterFrame[] }> {
  const requests: ProviderRequest[] = [];
  const recorded: unknown[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-site-icons", cwd: dir, model: "anthropic/claude-sonnet-5-5", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        if (requests.length === 1) {
          return { kind: "tool_use", calls: [{ id: "toolu_a", name: "WebFetch", input: { url: "https://docs.example.com/page", prompt: "p" } }, { id: "toolu_b", name: "WebFetch", input: { url: "https://x.example.com/", prompt: "p" } }] };
        }
        return { kind: "text", text: "done" };
      },
    },
    tools: {
      async execute(call: { id: string }) {
        return call.id === "toolu_a" ? { output: "the digest", ...(siteIcons !== undefined ? { siteIcons } : {}) } : { output: "no icons here" };
      },
    },
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    describeModel: () => ({}),
    store: {
      recordUserEntry(content: string | ContentBlock[]) { recorded.push(structuredClone(content)); },
      recordAssistantEntry() {},
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "read it" });
  for (let n = 0; n < 2000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, recorded, frames };
}

function toolRoundContent(frames: WinterFrame[]): Array<Record<string, unknown>> {
  const frame = frames.find((f) => {
    const msg = (f as { message?: { type?: string; message?: { content?: unknown } } }).message;
    return f.type === "data" && msg?.type === "user" && Array.isArray(msg.message?.content) && (msg.message!.content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
  });
  if (frame === undefined) throw new Error("no tool-round user frame");
  return (frame as unknown as { message: { message: { content: Array<Record<string, unknown>> } } }).message.message.content;
}

describe("site icons through the engine", () => {
  test("ride the host's tool-round frame, on the reporting call's block only", async () => {
    const { frames } = await run(ICONS);
    expect(toolRoundContent(frames)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: "the digest", winter_site_icons: [{ url: "https://docs.example.com/page", icon_url: "https://docs.example.com/touch.png" }, { url: "https://other.example.org/", icon_url: "https://cdn.example.net/o.png" }] },
      { type: "tool_result", tool_use_id: "toolu_b", content: "no icons here" },
    ]);
  });

  test("never reach the model's next request or the transcript", async () => {
    const { requests, recorded } = await run(ICONS);
    expect(requests).toHaveLength(2);
    const next = JSON.stringify(requests[1]!.messages);
    expect(next).toContain("the digest");
    expect(next).not.toContain("winter_site_icons");
    expect(next).not.toContain("touch.png");
    expect(JSON.stringify(recorded)).not.toContain("touch.png");
    expect(JSON.stringify(recorded)).toContain("the digest");
  });

  test("a result with none leaves the frame exactly as before", async () => {
    const { frames } = await run(undefined);
    expect(toolRoundContent(frames)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: "the digest" },
      { type: "tool_result", tool_use_id: "toolu_b", content: "no icons here" },
    ]);
  });
});

describe("withHostSiteIcons", () => {
  test("copies the blocks it decorates -- the history's own objects are never mutated", () => {
    const block: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "x" };
    const content = [block];
    const out = withHostSiteIcons(content, new Map([["t1", [ICONS[0]!]]]));
    expect(out[0]).not.toBe(block);
    expect(block).toEqual({ type: "tool_result", tool_use_id: "t1", content: "x" });
    expect(withHostSiteIcons(content, new Map())).toBe(content);
  });
});
