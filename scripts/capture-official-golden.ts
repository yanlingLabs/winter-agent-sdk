// GATED — not run in ordinary CI. Requires the pinned darwin-arm64 native package + a loopback endpoint.
// Procedure (WS-17 §4, report §5 probe): install @anthropic-ai/claude-agent-sdk@0.3.250 ephemerally,
// run query() against a loopback Anthropic-compatible endpoint that records the request and returns a
// canned assistant+result, capture the SDK message stream, normalizeTrace(), and write the golden.
export {};
