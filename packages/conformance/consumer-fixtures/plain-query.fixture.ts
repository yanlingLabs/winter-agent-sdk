// Compiled against @anthropic-ai/claude-agent-sdk (official, ephemeral) AND @yanlinglabs/winter-agent-sdk.
// The import specifier is swapped by tsconfig `paths`; the body is identical for both (drop-in surface, WS-03 §1).
import { query } from "@sdk-under-test";
import type { Options } from "@sdk-under-test";

export async function run(): Promise<string[]> {
  const options: Options = { model: "sonnet", permissionMode: "default", maxTurns: 4 };
  const seen: string[] = [];
  const q = query({ prompt: "hello", options });
  for await (const msg of q) {
    seen.push(msg.type);
    if (msg.type === "assistant") { /* content is a block array */ void msg.message.content.length; }
    if (msg.type === "result") { void (msg.subtype); }
  }
  return seen;
}
