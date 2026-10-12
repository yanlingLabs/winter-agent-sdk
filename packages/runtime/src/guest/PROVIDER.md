# Private guest provider proxy

`createGuestProviderClient` accepts only a trusted immutable-bootstrap channel,
copied scope and host-selected public model metadata. No credential, endpoint or
authentication-header field exists on the binding. Its length-prefixed private
exchange carries normalized provider requests/events, including opaque state and
thinking signatures; it must not be connected to model-readable NDJSON or logs.
The native integration must authenticate the channel's actual boot/task/UID.
This JavaScript constructor is not proof of native admission.

The sealed binding can be passed only through internal SessionProviderOptions.
The actual SessionProvider buildProvider route uses `guestProviderFor` and the
existing adapterAsProvider fold/domain stamping/history renderer. A mismatched
SDK backend session or model refuses. Guest credential/keychain/tool-secret
stores remain unavailable; the proxy has no direct HTTP/discovery/local fallback.
Ordinary sessions with no binding keep their existing provider path.

One exchange is bounded at six seconds; response size and invocation/sequence
are checked. Pending poll responses continue the same invocation and adapter operation; turn
payloads are never re-sent. Port failures/cancellation close the lease,
fence late responses and expose only fixed non-retryable errors. Closure does not
prove host adapter/native descendants stopped; the host broker retains uncertain
work independently. A terminal turn leaves the acknowledged private binding usable
for a later turn. Root owns child-task delegation and production channel wiring.

Seven focused SDK tests verify real fold/native state/tool triples, sealed model/
backend matching, framing/sequence failure without retries, and cancellation with
late-response fencing, pending polls without request replay, actual exchange
deadline enforcement and oversized/malformed response refusal. Companion Core tests exercise actual shipped Responses
and Anthropic adapters plus sidecar/tool-result continuation over fixture Worker
bytes. That Worker is not a production sandbox, and scripted tool results are not
Linux tool execution. Global confined startup remains refused. No SDK release,
consumer pin, environment authorization flag or broad fallback was introduced.

Final validation: 166 proxy/posture/bridge/session-provider/credential regressions
pass (513 assertions), and both SDK typecheck projects pass. Companion Core
validation passes 13 tests (109 assertions), including actual partial Responses
output that fails without another upstream request or leaked fixture credential.
