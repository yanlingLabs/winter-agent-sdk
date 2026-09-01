import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import type { SdkMessage } from "./protocol/frames.ts";
import type { Provider } from "./provider/mock.ts";

export const PROTOCOL_VERSION = "1.0" as const;

export async function runWinterRuntime(opts: {
  input: FrameSource; output: FrameSink; provider: Provider;
  sessionId: string; cwd: string; model: string; permissionMode?: string; tools?: string[];
}): Promise<void> {
  const { input, output, provider, sessionId, cwd, model } = opts;
  const permissionMode = opts.permissionMode ?? "default";
  const tools = opts.tools ?? [];
  // init MUST be the first runtime→host frame (WS-04 §3/§4)
  output.write({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId, cwd, model, permissionMode, tools });
  // also project it as the SDK system/init message so the wrapper can surface it
  const initMsg: SdkMessage = { type: "system", subtype: "init", session_id: sessionId, cwd, model, permissionMode, tools };
  output.write({ type: "data", message: initMsg });

  for await (const frame of input) {
    if (frame.type !== "user") continue; // P0: ignore control frames; P2+ handles them
    const prompt = (frame as { text: string }).text;
    try {
      const { text } = await provider.generate({ prompt });
      output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "text", text }] } } });
      output.write({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: text } });
    } catch (err) {
      output.write({ type: "data", message: { type: "result", subtype: "error_during_execution", is_error: true, result: String((err as Error).message) } });
    }
  }
  output.end();
}
